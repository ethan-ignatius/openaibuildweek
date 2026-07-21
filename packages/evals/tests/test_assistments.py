from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from packages.evals.assistments.agent import (
    PredictionOutcome,
    prediction_targets,
    run_prediction_loop,
)
from packages.evals.assistments.baseline import fit_predict_pybkt
from packages.evals.assistments.data import (
    AssistmentsDataError,
    load_assistments,
    write_verified_manifest,
)
from packages.evals.metrics import binary_metrics, spearman_correlation
from packages.harness.model_client import TokenUsage


class FixedPredictor:
    def predict_after_chunk(self, **_: object) -> PredictionOutcome:
        return PredictionOutcome(
            probability_correct=0.65,
            rationale="Fixture probability",
            usage=TokenUsage(input=3, output=2, total=5),
            latency_ms=12.0,
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
                    "attempt_count": 1,
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


def test_assistments_loader_requires_first_attempt_filter_columns(tmp_path: Path) -> None:
    source = tmp_path / "data.csv"
    source.write_text(
        "order_id,user_id,problem_id,skill_id,correct\n1,u1,p1,s1,1\n",
        encoding="utf-8",
    )
    manifest = tmp_path / "manifest.json"
    write_verified_manifest(source, manifest)

    with pytest.raises(AssistmentsDataError, match="attempt, original"):
        load_assistments(source, manifest_path=manifest, min_interactions=2)


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
    training = interactions[interactions["student_id"].isin([f"assist_{i}" for i in range(8)])]
    held_out = interactions[interactions["student_id"].isin(["assist_8", "assist_9"])]

    result = fit_predict_pybkt(training, held_out, seed=9)

    assert len(result.predictions) == len(held_out)
    assert np.isfinite(result.predictions["probability"]).all()
    assert result.predictions["probability"].between(0, 1).all()
    prediction_keys = result.predictions[["student_id", "sequence_index"]]
    held_out_keys = held_out[["student_id", "sequence_index"]]
    assert prediction_keys.to_records(index=False).tolist() == held_out_keys.to_records(
        index=False
    ).tolist()
