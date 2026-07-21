from __future__ import annotations

import argparse
import os
from datetime import UTC, datetime
from pathlib import Path

from packages.evals.assistments.agent import (
    OpenAIAssistmentsPredictor,
    prediction_targets,
    run_prediction_loop,
)
from packages.evals.assistments.baseline import fit_predict_pybkt
from packages.evals.assistments.data import AssistmentsDataError, load_assistments
from packages.evals.assistments.report import write_assistments_report
from packages.evals.metrics import binary_metrics
from packages.harness.config import HarnessConfig, MemoryMode
from packages.harness.journal import JournalWriter
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
    parser.add_argument("--max-predictions", type=int)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--pybkt-fits", type=int, default=1)
    parser.add_argument("--skip-pybkt", action="store_true")
    parser.add_argument("--workers", type=int, default=1)
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
    if arguments.max_predictions is not None and arguments.max_predictions < 1:
        parser.error("--max-predictions must be positive")
    if arguments.pybkt_fits < 1:
        parser.error("--pybkt-fits must be positive")
    if arguments.workers < 1:
        parser.error("--workers must be positive")

    session_id = f"assistments-{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}"
    journal = JournalWriter(Path("state/evals/assistments") / f"{session_id}.jsonl", session_id)
    journal.append(
        "session.started",
        {
            "eval": "assistments",
            "source": str(arguments.source),
            "memory_mode": arguments.memory_mode,
        },
    )

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
    selected_students = held_out_students[: arguments.max_students]
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
    results = {}
    pybkt_fallback_count = 0
    if not arguments.skip_pybkt:
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
        results["pyBKT"] = binary_metrics(
            pybkt_targets["correct"].tolist(),
            pybkt_targets["probability"].tolist(),
        )
        pybkt_fallback_count = pybkt.fallback_count

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

    config = HarnessConfig(
        memory_mode=MemoryMode(arguments.memory_mode),
        state_directory=Path("state/evals/assistments") / session_id,
        journal_directory=Path("state/evals/assistments"),
    )
    client = OpenAIModelClient(config, journal=journal)
    memory = LearnerMemory(config.state_directory)
    predictor = OpenAIAssistmentsPredictor(
        config=config,
        client=client,
        memory=memory,
        journal=journal,
    )
    agent_predictions, usage = run_prediction_loop(
        interactions,
        selected_students,
        predictor,
        chunk_size=arguments.chunk_size,
        max_predictions=arguments.max_predictions,
        max_workers=arguments.workers,
    )
    results["Teacher Brain"] = binary_metrics(
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
            "external ASSISTments rows."
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


if __name__ == "__main__":
    main()
