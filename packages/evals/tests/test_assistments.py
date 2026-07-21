from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from packages.evals.assistments.agent import (
    NextItemPrediction,
    OpenAIAssistmentsPredictor,
    PredictionOutcome,
    prediction_targets,
    recover_resume_progress,
    run_prediction_loop,
)
from packages.evals.assistments.baseline import fit_predict_pybkt
from packages.evals.assistments.data import (
    AssistmentsDataError,
    load_assistments,
    write_verified_manifest,
)
from packages.evals.metrics import binary_metrics, spearman_correlation
from packages.harness.config import HarnessConfig, MemoryMode
from packages.harness.learner_memory import LearnerMemory
from packages.harness.model_client import ModelResult, TokenUsage, ToolRunResult


class FixedPredictor:
    def predict_after_chunk(self, **_: object) -> PredictionOutcome:
        return PredictionOutcome(
            probability_correct=0.65,
            rationale="Fixture probability",
            usage=TokenUsage(input=3, output=2, total=5),
            latency_ms=12.0,
        )


class FakeAssistmentsClient:
    def __init__(self) -> None:
        self.structured_calls: list[dict[str, object]] = []
        self.tool_calls: list[dict[str, object]] = []

    def generate_structured(self, **kwargs: object) -> ModelResult[NextItemPrediction]:
        self.structured_calls.append(kwargs)
        return ModelResult(
            parsed=NextItemPrediction(
                probability_correct=0.7,
                rationale="Fixture estimate",
            ),
            usage=TokenUsage(input=10, output=5, total=15),
            latency_ms=11.0,
            response_id="prediction-test",
        )

    def execute_required_tool(self, **kwargs: object) -> ToolRunResult:
        self.tool_calls.append(kwargs)
        tool = kwargs["tool"]
        result = tool.handler(
            {
                "student": "assist_fixture",
                "markdown": LearnerMemory.empty_note("assist_fixture"),
            }
        )
        return ToolRunResult(
            result=result,
            usage=TokenUsage(input=4, output=2, total=6),
            latency_ms=7.0,
            response_id="memory-test",
            continuation_input=(),
        )


def test_assistments_loader_filters_and_pseudonymizes(tmp_path: Path) -> None:
    source = tmp_path / "skill_builder_data_corrected.csv"
    rows: list[dict[str, object]] = []
    order = 0
    for student in ("raw-101", "raw-202"):
        for item in range(6):
            order += 1
            rows.append(
                {
                    "order_id": order,
                    "user_id": student,
                    "problem_id": f"{student}-p{item}",
                    "skill_id": item % 2 + 1,
                    "skill_name": f"skill-{item % 2 + 1}",
                    "correct": item % 2,
                    "attempt_count": 3 if item == 0 else 1,
                    "original": 1,
                }
            )
    rows.extend(
        [
            {**rows[0], "order_id": 100, "attempt_count": 2},
            {**rows[1], "order_id": 101, "original": 0},
            {**rows[2], "order_id": 102, "skill_id": None},
            {
                **rows[3],
                "order_id": 103,
                "user_id": "too-short",
                "problem_id": "short-1",
            },
        ]
    )
    pd.DataFrame(rows).to_csv(source, index=False)
    manifest = tmp_path / "manifest.json"
    write_verified_manifest(source, manifest)

    dataset = load_assistments(
        source,
        manifest_path=manifest,
        min_interactions=4,
        pseudonym_salt="fixture",
    )

    assert len(dataset.interactions) == 12
    assert dataset.source_encoding == "utf-8"
    assert len(dataset.students) == 2
    assert all(student.startswith("assist_") for student in dataset.students)
    assert "raw_student_id" not in dataset.interactions.columns
    assert dataset.interactions.groupby("student_id").size().tolist() == [6, 6]
    training, held_out = dataset.split_students(seed=7)
    assert len(training) == 1
    assert len(held_out) == 1


def test_assistments_loader_requires_verified_manifest(tmp_path: Path) -> None:
    source = tmp_path / "data.csv"
    source.write_text("order_id,user_id,problem_id,skill_id,correct\n", encoding="utf-8")
    with pytest.raises(AssistmentsDataError, match="provenance manifest"):
        load_assistments(source, min_interactions=2)


def test_assistments_loader_requires_original_problem_column(tmp_path: Path) -> None:
    source = tmp_path / "data.csv"
    source.write_text(
        "order_id,user_id,problem_id,skill_id,correct\n1,u1,p1,s1,1\n",
        encoding="utf-8",
    )
    manifest = tmp_path / "manifest.json"
    write_verified_manifest(source, manifest)

    with pytest.raises(AssistmentsDataError, match="original"):
        load_assistments(source, manifest_path=manifest, min_interactions=2)


def test_assistments_loader_records_legacy_windows_encoding(tmp_path: Path) -> None:
    source = tmp_path / "legacy.csv"
    source.write_bytes(
        (
            "order_id,user_id,problem_id,skill_id,skill_name,correct,original\n"
            "1,u1,p1,s1,price \u20ac,1,1\n"
            "2,u1,p2,s1,price \u20ac,0,1\n"
        ).encode("cp1252")
    )
    manifest = tmp_path / "manifest.json"
    write_verified_manifest(source, manifest)

    dataset = load_assistments(
        source,
        manifest_path=manifest,
        min_interactions=2,
    )

    assert dataset.source_encoding == "cp1252"
    assert len(dataset.interactions) == 2


def test_prediction_loop_uses_chronological_chunk_boundaries() -> None:
    interactions = pd.DataFrame(
        [
            {
                "student_id": "assist_fixture",
                "sequence_index": index,
                "order_id": index,
                "problem_id": f"p{index}",
                "skill_id": str(index % 3),
                "skill_name": f"skill-{index % 3}",
                "correct": index % 2,
            }
            for index in range(25)
        ]
    )
    predictions, usage = run_prediction_loop(
        interactions,
        ["assist_fixture"],
        FixedPredictor(),
        chunk_size=10,
    )
    targets = prediction_targets(
        interactions,
        ["assist_fixture"],
        chunk_size=10,
    )

    assert predictions["sequence_index"].tolist() == [10, 20]
    assert targets["sequence_index"].tolist() == [10, 20]
    assert usage == TokenUsage(input=6, output=4, total=10)

    capped_predictions, capped_usage = run_prediction_loop(
        interactions,
        ["assist_fixture"],
        FixedPredictor(),
        chunk_size=10,
        max_predictions=1,
    )
    assert capped_predictions["sequence_index"].tolist() == [10]
    assert capped_usage == TokenUsage(input=3, output=2, total=5)

    second_student = interactions.assign(student_id="assist_second")
    parallel_predictions, parallel_usage = run_prediction_loop(
        pd.concat([interactions, second_student], ignore_index=True),
        ["assist_fixture", "assist_second"],
        FixedPredictor(),
        chunk_size=10,
        max_predictions=3,
        max_workers=2,
    )
    assert parallel_predictions[["student_id", "sequence_index"]].to_records(
        index=False
    ).tolist() == [
        ("assist_fixture", 10),
        ("assist_fixture", 20),
        ("assist_second", 10),
    ]
    assert parallel_usage == TokenUsage(input=9, output=6, total=15)

    resumed_predictions, resumed_usage = run_prediction_loop(
        interactions,
        ["assist_fixture"],
        FixedPredictor(),
        chunk_size=10,
        completed_predictions={"assist_fixture": 1},
        memory_prepared_for=frozenset({"assist_fixture"}),
    )
    assert resumed_predictions["sequence_index"].tolist() == [20]
    assert resumed_usage == TokenUsage(input=3, output=2, total=5)


def test_resume_progress_recovers_predictions_memory_and_usage() -> None:
    interactions = pd.DataFrame(
        [
            {
                "student_id": "assist_fixture",
                "sequence_index": index,
                "skill_id": "s1",
                "skill_name": "fractions",
                "correct": index % 2,
            }
            for index in range(35)
        ]
    )
    events: list[dict[str, object]] = []
    for probability in (0.4, 0.6):
        events.extend(
            [
                {
                    "event_type": "model.response",
                    "payload": {},
                    "token_usage": {"input": 3, "output": 2, "total": 5},
                },
                {
                    "event_type": "tool.result",
                    "payload": {
                        "result": {
                            "ok": True,
                            "student": "assist_fixture",
                        }
                    },
                },
                {
                    "event_type": "eval.prediction",
                    "payload": {
                        "eval": "assistments",
                        "student": "assist_fixture",
                        "probability_correct": probability,
                    },
                    "latency_ms": 12.0,
                },
            ]
        )
    events.append(
        {
            "event_type": "tool.result",
            "payload": {
                "result": {
                    "ok": True,
                    "student": "assist_fixture",
                }
            },
        }
    )

    progress = recover_resume_progress(
        events,
        interactions,
        ["assist_fixture"],
        chunk_size=10,
    )

    assert progress.predictions["sequence_index"].tolist() == [10, 20]
    assert progress.predictions["probability"].tolist() == [0.4, 0.6]
    assert progress.completed_by_student == {"assist_fixture": 2}
    assert progress.memory_prepared_for == frozenset({"assist_fixture"})
    assert progress.usage == TokenUsage(input=6, output=4, total=10)


def test_full_context_is_raw_model_comparator_without_memory_write(
    tmp_path: Path,
) -> None:
    client = FakeAssistmentsClient()
    predictor = OpenAIAssistmentsPredictor(
        config=HarnessConfig(memory_mode=MemoryMode.FULL_CONTEXT),
        client=client,
        memory=LearnerMemory(tmp_path),
    )
    history = [{"skill_id": "s1", "correct": 1}]

    outcome = predictor.predict_after_chunk(
        student="assist_fixture",
        new_chunk=history,
        observed_history=history,
        next_skill_id="s2",
        next_skill_name="fractions",
    )

    assert client.tool_calls == []
    assert '"skill_id":"s1"' in str(client.structured_calls[0]["user_prompt"])
    assert outcome.usage == TokenUsage(input=10, output=5, total=15)


def test_notes_condition_updates_and_reads_persistent_memory(tmp_path: Path) -> None:
    client = FakeAssistmentsClient()
    memory = LearnerMemory(tmp_path)
    predictor = OpenAIAssistmentsPredictor(
        config=HarnessConfig(memory_mode=MemoryMode.NOTES),
        client=client,
        memory=memory,
    )

    outcome = predictor.predict_after_chunk(
        student="assist_fixture",
        new_chunk=[{"skill_id": "s1", "correct": 0}],
        observed_history=[{"skill_id": "s1", "correct": 0}],
        next_skill_id="s1",
        next_skill_name="fractions",
    )

    assert len(client.tool_calls) == 1
    assert "# Learner: assist_fixture" in str(
        client.structured_calls[0]["user_prompt"]
    )
    assert memory.read("assist_fixture").startswith("# Learner: assist_fixture")
    assert outcome.usage == TokenUsage(input=14, output=7, total=21)


def test_metrics_match_known_values() -> None:
    metrics = binary_metrics([0, 1, 0, 1], [0.1, 0.9, 0.2, 0.8])
    assert metrics.auc == pytest.approx(1.0)
    assert metrics.brier == pytest.approx(0.025)
    assert metrics.f1 == pytest.approx(1.0)
    assert spearman_correlation([1, 2, 3], [3, 2, 1]) == pytest.approx(-1.0)


def test_pybkt_baseline_fits_and_returns_finite_aligned_predictions() -> None:
    interactions = pd.DataFrame(
        [
            {
                "student_id": f"assist_{student}",
                "sequence_index": item,
                "order_id": student * 30 + item,
                "skill_id": f"s{item % 2}",
                "correct": int(item > 5 + student % 4),
            }
            for student in range(10)
            for item in range(30)
        ]
    )
    shuffled = interactions.sample(frac=1, random_state=13)
    training = shuffled[
        shuffled["student_id"].isin([f"assist_{i}" for i in range(8)])
    ]
    held_out = shuffled[shuffled["student_id"].isin(["assist_8", "assist_9"])]

    result = fit_predict_pybkt(training, held_out, seed=9)

    assert len(result.predictions) == len(held_out)
    assert result.fallback_count == 0
    assert np.isfinite(result.predictions["probability"]).all()
    assert result.predictions["probability"].between(0, 1).all()
    prediction_keys = result.predictions[["student_id", "sequence_index"]]
    held_out_keys = held_out[["student_id", "sequence_index"]]
    assert prediction_keys.to_records(index=False).tolist() == held_out_keys.to_records(
        index=False
    ).tolist()
