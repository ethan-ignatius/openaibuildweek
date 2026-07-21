from __future__ import annotations

import argparse
import json
import os
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd

from packages.evals.assistments.agent import (
    OpenAIAssistmentsPredictor,
    prediction_targets,
    recover_resume_progress,
    run_prediction_loop,
)
from packages.evals.assistments.baseline import fit_predict_pybkt
from packages.evals.assistments.data import (
    AssistmentsDataError,
    load_assistments,
    select_held_out_students,
)
from packages.evals.assistments.report import write_assistments_report
from packages.evals.metrics import BinaryMetrics, binary_metrics
from packages.harness.config import HarnessConfig, MemoryMode
from packages.harness.journal import JournalReader, JournalWriter
from packages.harness.learner_memory import LearnerMemory
from packages.harness.model_client import OpenAIModelClient, TokenUsage


def default_source() -> Path:
    candidates = (
        Path("data/assistments/skill_builder_data_corrected.csv"),
        Path("data/assistments/skill_builder_data_corrected_collapsed.csv"),
    )
    return next((path for path in candidates if path.is_file()), candidates[0])


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the ASSISTments calibration eval.")
    parser.add_argument(
        "--source",
        type=Path,
        default=default_source(),
    )
    parser.add_argument(
        "--manifest", type=Path, default=Path("data/assistments/manifest.json")
    )
    parser.add_argument("--chunk-size", type=int, default=10)
    parser.add_argument("--max-students", type=int, default=5)
    parser.add_argument(
        "--student-offset",
        type=int,
        default=0,
        help="Skip this many deterministically ranked held-out students.",
    )
    parser.add_argument(
        "--maximum-student-interactions",
        type=int,
        help="Only select held-out students at or below this trajectory length.",
    )
    parser.add_argument("--max-predictions", type=int)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--pybkt-fits", type=int, default=1)
    parser.add_argument("--skip-pybkt", action="store_true")
    parser.add_argument("--workers", type=int, default=1)
    parser.add_argument("--timeout-seconds", type=float, default=90.0)
    parser.add_argument(
        "--resume-session",
        help="Resume an interrupted assistments-YYYYMMDDTHHMMSSZ session.",
    )
    parser.add_argument(
        "--memory-mode",
        choices=[mode.value for mode in MemoryMode],
        default=MemoryMode.NOTES.value,
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=Path("packages/evals/assistments/report.md"),
    )
    arguments = parser.parse_args()
    if arguments.chunk_size < 1:
        parser.error("--chunk-size must be positive")
    if arguments.max_students < 1:
        parser.error("--max-students must be positive")
    if arguments.student_offset < 0:
        parser.error("--student-offset cannot be negative")
    if (
        arguments.maximum_student_interactions is not None
        and arguments.maximum_student_interactions < 2
    ):
        parser.error("--maximum-student-interactions must be at least 2")
    if arguments.max_predictions is not None and arguments.max_predictions < 1:
        parser.error("--max-predictions must be positive")
    if arguments.pybkt_fits < 1:
        parser.error("--pybkt-fits must be positive")
    if arguments.workers < 1:
        parser.error("--workers must be positive")
    if arguments.timeout_seconds <= 0:
        parser.error("--timeout-seconds must be positive")

    journal_directory = Path("state/evals/assistments")
    if arguments.resume_session:
        session_id = arguments.resume_session
        if Path(session_id).name != session_id or not session_id.startswith("assistments-"):
            parser.error("--resume-session must be an assistments-* session ID")
        journal_path = journal_directory / f"{session_id}.jsonl"
        prior_events = JournalReader(journal_path).read_all()
        journal = JournalWriter(journal_path, session_id, resume=True)
        journal.append(
            "session.resumed",
            {
                "eval": "assistments",
                "memory_mode": arguments.memory_mode,
                "prior_events": len(prior_events),
            },
        )
    else:
        session_id = f"assistments-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
        journal_path = journal_directory / f"{session_id}.jsonl"
        prior_events = []
        journal = JournalWriter(journal_path, session_id)
        journal.append(
            "session.started",
            {
                "eval": "assistments",
                "source": str(arguments.source),
                "memory_mode": arguments.memory_mode,
                "chunk_size": arguments.chunk_size,
                "max_students": arguments.max_students,
                "student_offset": arguments.student_offset,
                "maximum_student_interactions": arguments.maximum_student_interactions,
                "max_predictions": arguments.max_predictions,
                "seed": arguments.seed,
                "model": os.getenv("OPENAI_MODEL", "gpt-5.6"),
            },
        )
    state_directory = journal_directory / session_id

    try:
        dataset = load_assistments(
            arguments.source,
            manifest_path=arguments.manifest,
            min_interactions=80,
        )
    except AssistmentsDataError as error:
        journal.append("session.ended", {"status": "unavailable", "error": str(error)})
        write_assistments_report(
            arguments.report,
            status="UNAVAILABLE",
            status_detail=str(error),
        )
        raise SystemExit(str(error)) from error

    training_students, held_out_students = dataset.split_students(seed=arguments.seed)
    interactions = dataset.interactions
    training = interactions[interactions["student_id"].isin(training_students)]
    held_out = interactions[interactions["student_id"].isin(held_out_students)]
    selected_students = select_held_out_students(
        interactions,
        held_out_students,
        count=arguments.max_students,
        offset=arguments.student_offset,
        maximum_interactions=arguments.maximum_student_interactions,
    )
    if prior_events:
        started_payload = prior_events[0].get("payload", {})
        if started_payload.get("memory_mode") != arguments.memory_mode:
            raise SystemExit("Resume memory mode does not match the original session")
        if int(started_payload.get("student_offset", 0)) != arguments.student_offset:
            raise SystemExit("Resume student offset does not match the original session")
        if (
            started_payload.get("maximum_student_interactions")
            != arguments.maximum_student_interactions
        ):
            raise SystemExit(
                "Resume maximum student interactions does not match the original session"
            )
    evaluation_held_out = held_out[
        held_out["student_id"].isin(selected_students)
    ]
    evaluation_skills = set(evaluation_held_out["skill_id"])
    evaluation_training = training[training["skill_id"].isin(evaluation_skills)]
    targets = prediction_targets(
        interactions,
        selected_students,
        chunk_size=arguments.chunk_size,
        max_predictions=arguments.max_predictions,
    )
    results: dict[str, BinaryMetrics] = {}
    pybkt_fallback_count = 0
    if not arguments.skip_pybkt:
        cache_path = state_directory / "pybkt_baseline.json"
        cached_baseline = _load_pybkt_cache(
            cache_path,
            source_sha256=dataset.source_sha256,
            selected_students=selected_students,
            seed=arguments.seed,
            num_fits=arguments.pybkt_fits,
            prediction_count=len(targets),
        )
        if cached_baseline is None:
            pybkt = fit_predict_pybkt(
                evaluation_training,
                evaluation_held_out,
                seed=arguments.seed,
                num_fits=arguments.pybkt_fits,
            )
            pybkt_targets = targets.merge(
                pybkt.predictions,
                on=["student_id", "sequence_index"],
                how="inner",
                validate="one_to_one",
            )
            baseline_metrics = binary_metrics(
                pybkt_targets["correct"].tolist(),
                pybkt_targets["probability"].tolist(),
            )
            pybkt_fallback_count = pybkt.fallback_count
            _write_pybkt_cache(
                cache_path,
                source_sha256=dataset.source_sha256,
                selected_students=selected_students,
                seed=arguments.seed,
                num_fits=arguments.pybkt_fits,
                metrics=baseline_metrics,
                fallback_count=pybkt_fallback_count,
            )
            cache_hit = False
        else:
            baseline_metrics, pybkt_fallback_count = cached_baseline
            cache_hit = True
        results["pyBKT"] = baseline_metrics
        journal.append(
            "eval.metric",
            {
                "system": "pyBKT",
                **baseline_metrics.as_dict(),
                "cache_hit": cache_hit,
            },
        )

    if not os.getenv("OPENAI_API_KEY"):
        detail = (
            "The external dataset loaded"
            f"{' and pyBKT ran' if results else ''}, but OPENAI_API_KEY is not set; "
            "the agent condition was not executed and M1 is not complete."
        )
        for system, metrics in results.items():
            journal.append("eval.metric", {"system": system, **metrics.as_dict()})
        journal.append("session.ended", {"status": "unavailable", "reason": detail})
        write_assistments_report(
            arguments.report,
            status="PARTIAL",
            status_detail=detail,
            source_sha256=dataset.source_sha256,
            source_encoding=dataset.source_encoding,
            eligible_students=len(dataset.students),
            interactions=len(interactions),
            results=results,
            pybkt_fallback_count=pybkt_fallback_count,
            pybkt_num_fits=None if arguments.skip_pybkt else arguments.pybkt_fits,
        )
        raise SystemExit(detail)

    memory_mode = MemoryMode(arguments.memory_mode)
    config = HarnessConfig(
        tool_surface=memory_mode == MemoryMode.NOTES,
        memory_mode=memory_mode,
        pedagogy_context="off",
        orchestration=False,
        model=os.getenv("OPENAI_MODEL", "gpt-5.6"),
        model_timeout_seconds=arguments.timeout_seconds,
        state_directory=state_directory,
        journal_directory=journal_directory,
    )
    client = OpenAIModelClient(config, journal=journal)
    memory = LearnerMemory(config.state_directory)
    predictor = OpenAIAssistmentsPredictor(
        config=config,
        client=client,
        memory=memory,
        journal=journal,
    )
    progress = recover_resume_progress(
        prior_events,
        interactions,
        selected_students,
        chunk_size=arguments.chunk_size,
    )
    try:
        new_predictions, new_usage = run_prediction_loop(
            interactions,
            selected_students,
            predictor,
            chunk_size=arguments.chunk_size,
            max_predictions=arguments.max_predictions,
            max_workers=arguments.workers,
            completed_predictions=progress.completed_by_student,
            memory_prepared_for=progress.memory_prepared_for,
        )
    except Exception as error:
        journal.append(
            "session.interrupted",
            {
                "status": "failed",
                "error_type": type(error).__name__,
                "error": str(error),
            },
        )
        raise
    agent_predictions = pd.concat(
        [progress.predictions, new_predictions],
        ignore_index=True,
    )
    student_order = {student: index for index, student in enumerate(selected_students)}
    agent_predictions["_student_order"] = agent_predictions["student_id"].map(
        student_order
    )
    agent_predictions = agent_predictions.sort_values(
        ["_student_order", "sequence_index"], kind="stable"
    ).drop(columns="_student_order")
    usage = progress.usage + new_usage
    condition_label = {
        MemoryMode.NOTES: "Teacher Brain notes",
        MemoryMode.FULL_CONTEXT: "GPT-5.6 full context",
        MemoryMode.NONE: "GPT-5.6 stateless",
    }[memory_mode]
    results[condition_label] = binary_metrics(
        agent_predictions["correct"].tolist(),
        agent_predictions["probability"].tolist(),
    )
    output_path = config.state_directory / "agent_predictions.csv"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    agent_predictions.to_csv(output_path, index=False)
    for system, metrics in results.items():
        journal.append("eval.metric", {"system": system, **metrics.as_dict()})
    journal.append(
        "session.ended",
        {"status": "complete", "predictions": len(agent_predictions)},
    )
    write_assistments_report(
        arguments.report,
        status="COMPLETE",
        status_detail=(
            f"Completed {len(agent_predictions)} held-out next-item predictions using "
            f"external ASSISTments rows under `{memory_mode.value}` memory."
        ),
        source_sha256=dataset.source_sha256,
        source_encoding=dataset.source_encoding,
        eligible_students=len(dataset.students),
        interactions=len(interactions),
        results=results,
        model=config.model,
        usage=usage,
        pybkt_fallback_count=pybkt_fallback_count,
        pybkt_num_fits=None if arguments.skip_pybkt else arguments.pybkt_fits,
    )


def _load_pybkt_cache(
    path: Path,
    *,
    source_sha256: str,
    selected_students: list[str],
    seed: int,
    num_fits: int,
    prediction_count: int,
) -> tuple[BinaryMetrics, int] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        expected = {
            "source_sha256": source_sha256,
            "selected_students": selected_students,
            "seed": seed,
            "num_fits": num_fits,
            "prediction_count": prediction_count,
        }
        if any(payload.get(key) != value for key, value in expected.items()):
            return None
        return BinaryMetrics(**payload["metrics"]), int(payload["fallback_count"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def _write_pybkt_cache(
    path: Path,
    *,
    source_sha256: str,
    selected_students: list[str],
    seed: int,
    num_fits: int,
    metrics: BinaryMetrics,
    fallback_count: int,
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source_sha256": source_sha256,
        "selected_students": selected_students,
        "seed": seed,
        "num_fits": num_fits,
        "prediction_count": metrics.count,
        "metrics": metrics.as_dict(),
        "fallback_count": fallback_count,
    }
    path.write_text(
        json.dumps(payload, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
