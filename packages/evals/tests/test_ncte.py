from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from packages.evals.ncte.agent import (
    ObservationScorePrediction,
    TurnMovePrediction,
    predict_observation_scores,
    predict_turn_moves,
)
from packages.evals.ncte.data import NCTEDataError, load_ncte
from packages.evals.ncte.report import write_ncte_report
from packages.harness.config import HarnessConfig
from packages.harness.model_client import ModelResult, TokenUsage


class FakeStructuredClient:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def generate_structured(self, **kwargs: Any) -> ModelResult[Any]:
        self.calls.append(kwargs)
        response_model = kwargs["response_model"]
        if response_model is TurnMovePrediction:
            parsed = TurnMovePrediction(
                high_uptake_probability=0.8,
                focusing_question_probability=0.2,
                rationale="The response explicitly revoices the student's idea.",
            )
        elif response_model is ObservationScorePrediction:
            parsed = ObservationScorePrediction(
                clpc=5,
                clbm=6,
                clinstd=4,
                expl=2,
                remed=2,
                langimp=1,
                smqr=3,
                rationale="Scores are anchored in the anonymized transcript.",
            )
        else:
            raise AssertionError(f"Unexpected response model: {response_model}")
        return ModelResult(
            parsed=parsed,
            usage=TokenUsage(input=10, output=5, total=15),
            latency_ms=12.0,
            response_id="response-test",
        )


def test_ncte_loader_uses_external_labels_and_averages_raters(tmp_path: Path) -> None:
    _write_ncte_fixture(tmp_path)

    dataset = load_ncte(tmp_path)

    assert len(dataset.exchanges) == 3
    assert dataset.exchanges["high_uptake"].tolist() == [1, 0, 1]
    assert dataset.observation_ids == ["101", "102"]
    scores = dataset.observation_scores.set_index("observation_id")
    assert scores.loc["101", "CLPC"] == pytest.approx(4.0)
    assert scores.loc["101", "EXPL"] == pytest.approx(2.0)
    assert dataset.utterances["turn_index"].tolist() == [0, 1, 0, 1]


def test_ncte_loader_fails_closed_without_authorized_files(tmp_path: Path) -> None:
    with pytest.raises(NCTEDataError, match="Each user must request transcript access"):
        load_ncte(tmp_path)


def test_ncte_predictions_hide_labels_and_apply_pedagogy_ablation(
    tmp_path: Path,
) -> None:
    _write_ncte_fixture(tmp_path)
    dataset = load_ncte(tmp_path)
    full_client = FakeStructuredClient()
    full_config = HarnessConfig(pedagogy_context="on")

    turn_predictions, turn_usage = predict_turn_moves(
        dataset.exchanges,
        client=full_client,
        config=full_config,
        max_exchanges=2,
        max_workers=2,
    )
    score_predictions, score_usage = predict_observation_scores(
        dataset.utterances,
        dataset.observation_ids,
        client=full_client,
        config=full_config,
        max_observations=2,
        max_workers=2,
    )

    assert len(turn_predictions) == 2
    assert len(score_predictions) == 2
    assert turn_usage.total == 30
    assert score_usage.total == 30
    assert "High uptake" in full_client.calls[0]["system_prompt"]
    assert "high_uptake" not in full_client.calls[0]["user_prompt"]
    assert "focusing_question" not in full_client.calls[0]["user_prompt"]
    assert "CLPC_prediction" in score_predictions

    off_client = FakeStructuredClient()
    predict_turn_moves(
        dataset.exchanges,
        client=off_client,
        config=HarnessConfig(pedagogy_context="off"),
        max_exchanges=1,
    )
    assert "High uptake" not in off_client.calls[0]["system_prompt"]


def test_ncte_report_labels_published_bars_as_external(tmp_path: Path) -> None:
    report = tmp_path / "report.md"
    write_ncte_report(
        report,
        status="UNAVAILABLE",
        status_detail="Authorized transcript files are absent.",
    )

    content = report.read_text(encoding="utf-8")
    assert "Published RoBERTa F1" in content
    assert "0.688" in content
    assert "0.501" in content
    assert "Published ChatGPT Spearman" in content
    assert "not results produced by this run" in content
    assert "Total tokens processed: **0**" in content


def _write_ncte_fixture(directory: Path) -> None:
    pd.DataFrame(
        {
            "exchange_idx": ["e1", "e2", "e3", "e4"],
            "OBSID": [101, 101, 102, 102],
            "student_text": ["It is four.", "I multiplied.", "Half.", ""],
            "teacher_text": [
                "You used four as the unit.",
                "Why did you multiply?",
                "Okay.",
                "Tell me more.",
            ],
            "high_uptake": [1, 0, 1, 0],
            "focusing_question": [0, 1, 0, 1],
        }
    ).to_csv(directory / "paired_annotations.csv", index=False)
    pd.DataFrame(
        {
            "OBSID": [101, 101, 102, 102],
            "turn_idx": [0, 1, 0, 1],
            "speaker": ["Student A", "Teacher", "Student B", "Teacher"],
            "utterance": ["It is four.", "How did you know?", "Half.", "Why?"],
        }
    ).to_csv(directory / "single_utterances.csv", index=False)
    pd.DataFrame(
        {
            "OBSID": [101, 101, 102],
            "CLPC": [3, 5, 6],
            "CLBM": [4, 6, 5],
            "CLINSTD": [2, 4, 5],
        }
    ).to_csv(directory / "class_data.csv", index=False)
    pd.DataFrame(
        {
            "OBSID": [101, 101, 102],
            "EXPL": [1, 3, 2],
            "REMED": [2, 2, 3],
            "LANGIMP": [1, 1, 2],
            "SMQR": [2, 3, 3],
        }
    ).to_csv(directory / "mqi_data.csv", index=False)
