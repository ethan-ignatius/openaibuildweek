from __future__ import annotations

import argparse
import os
from datetime import UTC, datetime
from pathlib import Path

from packages.evals.metrics import binary_metrics, spearman_correlation
from packages.evals.ncte.agent import predict_observation_scores, predict_turn_moves
from packages.evals.ncte.data import NCTEDataError, SCORE_DIMENSIONS, load_ncte
from packages.evals.ncte.report import write_ncte_report
from packages.harness.config import HarnessConfig, MemoryMode
from packages.harness.journal import JournalWriter
from packages.harness.model_client import OpenAIModelClient, TokenUsage


def main() -> None:
    parser = argparse.ArgumentParser(description="Run NCTE Tier 1 transcript evaluation.")
    parser.add_argument("--data-dir", type=Path, default=Path("data/ncte"))
    parser.add_argument("--max-transcripts", type=int, default=10)
    parser.add_argument("--max-exchanges", type=int, default=100)
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument(
        "--condition",
        choices=("full", "pedagogy-off", "bare"),
        default="full",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("packages/evals/ncte/report.md"),
    )
    arguments = parser.parse_args()
    if arguments.max_transcripts < 2:
        parser.error("--max-transcripts must be at least 2 for correlation")
    if arguments.max_exchanges < 1:
        parser.error("--max-exchanges must be positive")
    if arguments.workers < 1:
        parser.error("--workers must be positive")

    session_id = f"ncte-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    state_directory = Path("state/evals/ncte") / session_id
    journal = JournalWriter(state_directory / "session.jsonl", session_id)
    journal.append(
        "session.started",
        {
            "eval": "ncte-tier-1",
            "data_directory": str(arguments.data_dir),
            "condition": arguments.condition,
        },
    )

    try:
        dataset = load_ncte(arguments.data_dir)
    except NCTEDataError as error:
        _finish_unavailable(
            journal,
            arguments.report,
            condition=arguments.condition,
            detail=str(error),
        )
        raise SystemExit(str(error)) from error

    if not os.getenv("OPENAI_API_KEY"):
        detail = (
            "Authorized NCTE inputs loaded, but OPENAI_API_KEY is not set; no local "
            "model predictions were executed and M1 is not complete."
        )
        _finish_unavailable(
            journal,
            arguments.report,
            condition=arguments.condition,
            detail=detail,
        )
        raise SystemExit(detail)

    config = _condition_config(arguments.condition, state_directory)
    client = OpenAIModelClient(config, journal=journal)
    selected_ids = dataset.observation_ids[: arguments.max_transcripts]
    if len(selected_ids) < 2:
        detail = "Fewer than two scored OBSIDs overlap the supplied transcript and score files."
        _finish_unavailable(
            journal,
            arguments.report,
            condition=arguments.condition,
            detail=detail,
        )
        raise SystemExit(detail)

    matching_exchanges = dataset.exchanges[
        dataset.exchanges["observation_id"].isin(selected_ids)
    ]
    if matching_exchanges.empty:
        matching_exchanges = dataset.exchanges

    try:
        turn_predictions, turn_usage = predict_turn_moves(
            matching_exchanges,
            client=client,
            config=config,
            journal=journal,
            max_exchanges=arguments.max_exchanges,
            max_workers=arguments.workers,
        )
        score_predictions, score_usage = predict_observation_scores(
            dataset.utterances,
            selected_ids,
            client=client,
            config=config,
            journal=journal,
            max_observations=arguments.max_transcripts,
            max_workers=arguments.workers,
        )
    except Exception as error:
        detail = f"NCTE model run failed without substituting synthetic results: {error}"
        journal.append("session.ended", {"status": "failed", "error": str(error)})
        write_ncte_report(
            arguments.report,
            status="FAILED",
            status_detail=detail,
            model=config.model,
            condition=arguments.condition,
            usage=client.total_usage,
        )
        raise

    usage = turn_usage + score_usage
    turn_results = {
        "high_uptake": binary_metrics(
            turn_predictions["high_uptake"].tolist(),
            turn_predictions["high_uptake_probability"].tolist(),
        ),
        "focusing_question": binary_metrics(
            turn_predictions["focusing_question"].tolist(),
            turn_predictions["focusing_question_probability"].tolist(),
        ),
    }
    scored = dataset.observation_scores.merge(
        score_predictions,
        on="observation_id",
        how="inner",
        validate="one_to_one",
    )
    score_results: dict[str, tuple[int, float]] = {}
    for dimension in SCORE_DIMENSIONS:
        rows = scored.dropna(subset=[dimension, f"{dimension}_prediction"])
        score_results[dimension] = (
            len(rows),
            spearman_correlation(
                rows[dimension].to_numpy(),
                rows[f"{dimension}_prediction"].to_numpy(),
            ),
        )

    state_directory.mkdir(parents=True, exist_ok=True)
    turn_predictions.to_csv(state_directory / "turn_predictions.csv", index=False)
    score_predictions.to_csv(state_directory / "score_predictions.csv", index=False)
    for label, metrics in turn_results.items():
        journal.append("eval.metric", {"label": label, **metrics.as_dict()})
    for dimension, (count, correlation) in score_results.items():
        journal.append(
            "eval.metric",
            {"dimension": dimension, "count": count, "spearman": correlation},
        )
    journal.append(
        "session.ended",
        {
            "status": "complete",
            "turn_predictions": len(turn_predictions),
            "transcript_predictions": len(score_predictions),
        },
    )
    write_ncte_report(
        arguments.report,
        status="COMPLETE",
        status_detail=(
            f"Scored {len(score_predictions)} authorized NCTE transcripts and classified "
            f"{len(turn_predictions)} externally annotated exchanges."
        ),
        turn_results=turn_results,
        score_results=score_results,
        model=config.model,
        condition=arguments.condition,
        usage=usage,
    )


def _condition_config(condition: str, state_directory: Path) -> HarnessConfig:
    common = {
        "state_directory": state_directory,
        "journal_directory": state_directory,
        "model": os.getenv("OPENAI_MODEL", "gpt-5.6"),
    }
    if condition == "bare":
        return HarnessConfig(
            tool_surface=False,
            memory_mode=MemoryMode.NONE,
            pedagogy_context="off",
            orchestration=False,
            **common,
        )
    return HarnessConfig(
        pedagogy_context="off" if condition == "pedagogy-off" else "on",
        **common,
    )


def _finish_unavailable(
    journal: JournalWriter,
    report: Path,
    *,
    condition: str,
    detail: str,
) -> None:
    journal.append("session.ended", {"status": "unavailable", "reason": detail})
    write_ncte_report(
        report,
        status="UNAVAILABLE",
        status_detail=detail,
        condition=condition,
        usage=TokenUsage(),
    )


if __name__ == "__main__":
    main()
