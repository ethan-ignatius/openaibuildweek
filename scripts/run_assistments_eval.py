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


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the ASSISTments calibration eval.")
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("data/assistments/skill_builder_data_corrected.csv"),
    )
    parser.add_argument(
        "--manifest", type=Path, default=Path("data/assistments/manifest.json")
    )
    parser.add_argument("--chunk-size", type=int, default=10)
    parser.add_argument("--max-students", type=int, default=5)
    parser.add_argument("--seed", type=int, default=42)
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
    pybkt = fit_predict_pybkt(training, held_out, seed=arguments.seed)
    targets = prediction_targets(
        interactions,
        held_out_students,
        chunk_size=arguments.chunk_size,
        max_students=arguments.max_students,
    )
    pybkt_targets = targets.merge(
        pybkt.predictions,
        on=["student_id", "sequence_index"],
        how="inner",
        validate="one_to_one",
    )
    results = {
        "pyBKT": binary_metrics(
            pybkt_targets["correct"].tolist(),
            pybkt_targets["probability"].tolist(),
        )
    }

    if not os.getenv("OPENAI_API_KEY"):
        detail = (
            "The external dataset loaded and pyBKT ran, but OPENAI_API_KEY is not set; "
            "the agent condition was not executed and M1 is not complete."
        )
        journal.append("eval.metric", {"system": "pyBKT", **results["pyBKT"].as_dict()})
        journal.append("session.ended", {"status": "unavailable", "reason": detail})
        write_assistments_report(
            arguments.report,
            status="PARTIAL",
            status_detail=detail,
            source_sha256=dataset.source_sha256,
            eligible_students=len(dataset.students),
            interactions=len(interactions),
            results=results,
            pybkt_fallback_count=pybkt.fallback_count,
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
        held_out_students,
        predictor,
        chunk_size=arguments.chunk_size,
        max_students=arguments.max_students,
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
        eligible_students=len(dataset.students),
        interactions=len(interactions),
        results=results,
        model=config.model,
        usage=usage,
        pybkt_fallback_count=pybkt.fallback_count,
    )


if __name__ == "__main__":
    main()
