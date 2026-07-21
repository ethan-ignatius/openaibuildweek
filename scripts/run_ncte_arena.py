from __future__ import annotations

import argparse
import os
from datetime import UTC, datetime
from pathlib import Path

from packages.evals.metrics import binary_metrics
from packages.evals.ncte.arena import (
    ARENA_CONDITIONS,
    ArenaCheckpoint,
    ArenaCondition,
    build_ghost_episodes,
    run_arena,
    select_arena_observations,
    write_arena_replay,
)
from packages.evals.ncte.arena_report import write_arena_report
from packages.evals.ncte.data import NCTEDataError, load_ncte
from packages.harness.config import HarnessConfig, MemoryMode
from packages.harness.journal import JournalWriter
from packages.harness.model_client import OpenAIModelClient, TokenUsage


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run the controlled long-horizon NCTE ghost-classroom arena."
    )
    parser.add_argument("--data-dir", type=Path, default=Path("data/ncte"))
    parser.add_argument("--observations", type=int, default=3)
    parser.add_argument("--decisions", type=int, default=6)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument(
        "--condition",
        action="append",
        choices=ARENA_CONDITIONS,
        dest="conditions",
        help="Condition to run; repeat to select multiple. Defaults to all three.",
    )
    parser.add_argument(
        "--observation-id",
        action="append",
        dest="observation_ids",
        help="Explicit authorized observation ID; repeat for multiple episodes.",
    )
    parser.add_argument(
        "--skip-development-observations",
        type=int,
        default=10,
        help="Exclude the first N scored observations used by earlier development runs.",
    )
    parser.add_argument("--resume-session")
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("packages/evals/ncte/arena-report.md"),
    )
    arguments = parser.parse_args()
    if arguments.observations < 1:
        parser.error("--observations must be positive")
    if arguments.decisions < 1:
        parser.error("--decisions must be positive")
    if arguments.workers < 1:
        parser.error("--workers must be positive")
    if arguments.skip_development_observations < 0:
        parser.error("--skip-development-observations cannot be negative")

    conditions: tuple[ArenaCondition, ...] = tuple(
        dict.fromkeys(arguments.conditions or ARENA_CONDITIONS)
    )
    session_id = arguments.resume_session or (
        f"ncte-arena-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    )
    state_directory = Path("state/evals/ncte-arena") / session_id
    journal_path = state_directory / "session.jsonl"
    resume = arguments.resume_session is not None
    journal = JournalWriter(journal_path, session_id, resume=resume)
    journal.append(
        "session.resumed" if resume else "session.started",
        {
            "eval": "ncte-ghost-classroom",
            "data_directory": str(arguments.data_dir),
            "conditions": list(conditions),
            "decisions_per_observation": arguments.decisions,
        },
    )

    try:
        dataset = load_ncte(arguments.data_dir)
        if arguments.observation_ids:
            observation_ids = [str(item) for item in arguments.observation_ids]
        else:
            development_ids = set(
                dataset.observation_ids[: arguments.skip_development_observations]
            )
            observation_ids = select_arena_observations(
                dataset,
                count=arguments.observations,
                exclude_observations=development_ids,
            )
        episodes = build_ghost_episodes(
            dataset,
            observation_ids,
            decisions_per_observation=arguments.decisions,
        )
    except (NCTEDataError, ValueError) as error:
        journal.append("session.ended", {"status": "unavailable", "error": str(error)})
        write_arena_report(
            arguments.report,
            status="UNAVAILABLE",
            status_detail=str(error),
            model=os.getenv("OPENAI_MODEL", "gpt-5.6"),
            session_directory=state_directory,
        )
        raise SystemExit(str(error)) from error

    if not os.getenv("OPENAI_API_KEY"):
        detail = "OPENAI_API_KEY is not set; no arena predictions were executed."
        journal.append("session.ended", {"status": "unavailable", "error": detail})
        write_arena_report(
            arguments.report,
            status="UNAVAILABLE",
            status_detail=detail,
            model=os.getenv("OPENAI_MODEL", "gpt-5.6"),
            observation_ids=observation_ids,
            decisions_per_observation=arguments.decisions,
            session_directory=state_directory,
        )
        raise SystemExit(detail)

    model = os.getenv("OPENAI_MODEL", "gpt-5.6")
    configs = {
        condition: _condition_config(condition, state_directory, model=model)
        for condition in conditions
    }
    clients = {
        condition: OpenAIModelClient(configs[condition], journal=journal)
        for condition in conditions
    }
    checkpoint = ArenaCheckpoint(state_directory / "predictions.jsonl")

    try:
        arena_run = run_arena(
            episodes,
            conditions=conditions,
            clients=clients,
            configs=configs,
            checkpoint=checkpoint,
            journal=journal,
            max_workers=arguments.workers,
        )
        expected_per_condition = sum(len(episode.decisions) for episode in episodes)
        for condition in conditions:
            actual = int((arena_run.predictions["condition"] == condition).sum())
            if actual != expected_per_condition:
                raise RuntimeError(
                    f"Condition {condition} has {actual} predictions; "
                    f"expected {expected_per_condition}"
                )
    except Exception as error:
        detail = f"Arena run failed after checkpointing completed decisions: {error}"
        journal.append("session.ended", {"status": "failed", "error": str(error)})
        partial_records = checkpoint.records()
        partial_usage = _usage_from_records(partial_records)
        write_arena_report(
            arguments.report,
            status="FAILED",
            status_detail=detail,
            model=model,
            usage_by_condition=partial_usage,
            observation_ids=observation_ids,
            decisions_per_observation=arguments.decisions,
            session_directory=state_directory,
        )
        print(
            f"Resume with: python scripts/run_ncte_arena.py --resume-session {session_id}",
            flush=True,
        )
        raise

    predictions = arena_run.predictions
    metrics = {}
    for condition in conditions:
        rows = predictions[predictions["condition"] == condition]
        metrics[condition] = {
            "high_uptake": binary_metrics(
                rows["high_uptake"].tolist(),
                rows["high_uptake_probability"].tolist(),
            ),
            "focusing_question": binary_metrics(
                rows["focusing_question"].tolist(),
                rows["focusing_question_probability"].tolist(),
            ),
        }
        for label, result in metrics[condition].items():
            journal.append(
                "eval.metric",
                {
                    "eval": "ncte-ghost-classroom",
                    "condition": condition,
                    "label": label,
                    **result.as_dict(),
                },
            )

    state_directory.mkdir(parents=True, exist_ok=True)
    predictions.to_csv(state_directory / "predictions.csv", index=False)
    write_arena_replay(state_directory / "replay.md", predictions)
    journal.append(
        "session.ended",
        {
            "status": "complete",
            "observations": observation_ids,
            "conditions": list(conditions),
            "predictions": len(predictions),
        },
    )
    write_arena_report(
        arguments.report,
        status="COMPLETE",
        status_detail=(
            f"Compared {', '.join(conditions)} across {len(observation_ids)} unseen "
            f"NCTE classroom episodes and {arguments.decisions} sequential decision "
            "points per episode."
        ),
        model=model,
        predictions=predictions,
        metrics=metrics,
        usage_by_condition=arena_run.usage_by_condition,
        observation_ids=observation_ids,
        decisions_per_observation=arguments.decisions,
        session_directory=state_directory,
    )
    print(f"Arena report: {arguments.report}", flush=True)
    print(f"Licensed-text replay: {state_directory / 'replay.md'}", flush=True)


def _condition_config(
    condition: ArenaCondition,
    state_directory: Path,
    *,
    model: str,
) -> HarnessConfig:
    common = {
        "state_directory": state_directory / condition,
        "journal_directory": state_directory,
        "model": model,
        "reasoning_effort": os.getenv("OPENAI_REASONING_EFFORT", "low"),
        "model_timeout_seconds": float(os.getenv("OPENAI_TIMEOUT_SECONDS", "180")),
        "model_max_attempts": int(os.getenv("OPENAI_MAX_ATTEMPTS", "3")),
    }
    if condition == "full":
        return HarnessConfig(**common)
    return HarnessConfig(
        tool_surface=False,
        memory_mode=MemoryMode.NONE,
        pedagogy_context="on" if condition == "scaffolded" else "off",
        orchestration=False,
        **common,
    )


def _usage_from_records(records: list[dict[str, object]]) -> dict[str, TokenUsage]:
    usage: dict[str, TokenUsage] = {}
    for record in records:
        condition = str(record["condition"])
        item = TokenUsage(
            input=int(record.get("input_tokens", 0)),
            output=int(record.get("output_tokens", 0)),
            total=int(record.get("total_tokens", 0)),
        )
        usage[condition] = usage.get(condition, TokenUsage()) + item
    return usage


if __name__ == "__main__":
    main()
