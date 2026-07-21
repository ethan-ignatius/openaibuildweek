from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any, Callable, TypeVar

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from packages.evals.ncte.data import SCORE_DIMENSIONS
from packages.harness.config import HarnessConfig
from packages.harness.journal import JournalWriter
from packages.harness.model_client import StructuredModelClient, TokenUsage

ResultT = TypeVar("ResultT")


class TurnMovePrediction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    high_uptake_probability: float = Field(ge=0.0, le=1.0)
    focusing_question_probability: float = Field(ge=0.0, le=1.0)
    rationale: str = Field(min_length=1, max_length=1200)


class ObservationScorePrediction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    clpc: float = Field(ge=1.0, le=7.0)
    clbm: float = Field(ge=1.0, le=7.0)
    clinstd: float = Field(ge=1.0, le=7.0)
    expl: float = Field(ge=1.0, le=3.0)
    remed: float = Field(ge=1.0, le=3.0)
    langimp: float = Field(ge=1.0, le=3.0)
    smqr: float = Field(ge=1.0, le=3.0)
    rationale: str = Field(min_length=1, max_length=2400)


@dataclass(frozen=True)
class NCTEPredictions:
    turn_moves: pd.DataFrame
    observation_scores: pd.DataFrame
    usage: TokenUsage


def predict_turn_moves(
    exchanges: pd.DataFrame,
    *,
    client: StructuredModelClient,
    config: HarnessConfig,
    journal: JournalWriter | None = None,
    max_exchanges: int | None = None,
    max_workers: int = 1,
) -> tuple[pd.DataFrame, TokenUsage]:
    selected = exchanges if max_exchanges is None else exchanges.iloc[:max_exchanges]
    if selected.empty:
        raise ValueError("At least one annotated exchange is required")
    if max_workers < 1:
        raise ValueError("max_workers must be positive")

    def predict(row: Any) -> tuple[dict[str, object], TokenUsage]:
        result = client.generate_structured(
            system_prompt=_turn_system_prompt(config),
            user_prompt=(
                f"Student: {row.student_text}\n"
                f"Teacher: {row.teacher_text}\n\n"
                "Return probabilities for the two annotated teacher discourse moves."
            ),
            response_model=TurnMovePrediction,
            metadata={"eval": "ncte", "task": "turn_move"},
        )
        record = {
            "exchange_id": row.exchange_id,
            "observation_id": row.observation_id,
            "high_uptake": int(row.high_uptake),
            "focusing_question": int(row.focusing_question),
            "high_uptake_probability": result.parsed.high_uptake_probability,
            "focusing_question_probability": result.parsed.focusing_question_probability,
            "rationale": result.parsed.rationale,
            "latency_ms": result.latency_ms,
        }
        if journal:
            journal.append(
                "eval.prediction",
                {"eval": "ncte", "task": "turn_move", **record},
                latency_ms=result.latency_ms,
            )
        return record, result.usage

    predictions = _ordered_map(
        predict,
        list(selected.itertuples(index=False)),
        max_workers=max_workers,
    )
    records = [record for record, _ in predictions]
    usage = TokenUsage()
    for _, item_usage in predictions:
        usage += item_usage
    return pd.DataFrame.from_records(records), usage


def predict_observation_scores(
    utterances: pd.DataFrame,
    observation_ids: list[str],
    *,
    client: StructuredModelClient,
    config: HarnessConfig,
    journal: JournalWriter | None = None,
    max_observations: int | None = 10,
    max_workers: int = 1,
) -> tuple[pd.DataFrame, TokenUsage]:
    selected_ids = observation_ids
    if max_observations is not None:
        selected_ids = selected_ids[:max_observations]
    if not selected_ids:
        raise ValueError("At least one scored transcript is required")
    if max_workers < 1:
        raise ValueError("max_workers must be positive")

    tasks: list[tuple[str, str]] = []
    for observation_id in selected_ids:
        transcript_rows = utterances[utterances["observation_id"] == observation_id]
        transcript = "\n".join(
            f"{row.speaker}: {row.text}" for row in transcript_rows.itertuples(index=False)
        )
        if not transcript:
            continue
        tasks.append((observation_id, transcript))

    def predict(task: tuple[str, str]) -> tuple[dict[str, object], TokenUsage]:
        observation_id, transcript = task
        result = client.generate_structured(
            system_prompt=_score_system_prompt(config),
            user_prompt=(
                "Score this anonymized elementary mathematics classroom transcript. "
                "Use only evidence in the transcript.\n\n"
                f"{transcript}"
            ),
            response_model=ObservationScorePrediction,
            metadata={"eval": "ncte", "task": "observation_score"},
        )
        parsed = result.parsed
        record: dict[str, object] = {
            "observation_id": observation_id,
            "CLPC_prediction": parsed.clpc,
            "CLBM_prediction": parsed.clbm,
            "CLINSTD_prediction": parsed.clinstd,
            "EXPL_prediction": parsed.expl,
            "REMED_prediction": parsed.remed,
            "LANGIMP_prediction": parsed.langimp,
            "SMQR_prediction": parsed.smqr,
            "rationale": parsed.rationale,
            "latency_ms": result.latency_ms,
        }
        if journal:
            journal.append(
                "eval.prediction",
                {
                    "eval": "ncte",
                    "task": "observation_score",
                    **record,
                },
                latency_ms=result.latency_ms,
            )
        return record, result.usage

    predictions = _ordered_map(predict, tasks, max_workers=max_workers)
    records = [record for record, _ in predictions]
    usage = TokenUsage()
    for _, item_usage in predictions:
        usage += item_usage
    if not records:
        raise ValueError("No observation score predictions were produced")
    output = pd.DataFrame.from_records(records)
    expected = {f"{dimension}_prediction" for dimension in SCORE_DIMENSIONS}
    if not expected.issubset(output.columns):
        raise ValueError("Observation predictions are missing required dimensions")
    return output, usage


def _ordered_map(
    function: Callable[[Any], ResultT],
    values: list[Any],
    *,
    max_workers: int,
) -> list[ResultT]:
    worker_count = min(max_workers, len(values))
    if worker_count <= 1:
        return [function(value) for value in values]
    with ThreadPoolExecutor(max_workers=worker_count) as executor:
        return list(executor.map(function, values))


def _turn_system_prompt(config: HarnessConfig) -> str:
    base = (
        "You classify an externally annotated NCTE student-teacher exchange. Return "
        "calibrated probabilities rather than thresholded labels. Do not infer student "
        "demographics, identity, emotion, or confusion."
    )
    if config.pedagogy_context == "off":
        return base
    return (
        f"{base}\n\n"
        "Use the evaluation vocabulary exactly:\n"
        "- High uptake: the teacher builds on, revoices, or connects the student's "
        "specific contribution. Generic praise or a topic change is not high uptake.\n"
        "- Focusing question: the teacher presses the student to articulate or justify "
        "their reasoning without funneling the student through prescribed steps."
    )


def _score_system_prompt(config: HarnessConfig) -> str:
    base = (
        "You score classroom instruction against human observation ratings. Return all "
        "seven numeric dimensions. CLASS dimensions use 1-7: CLPC Positive Climate, "
        "CLBM Behavior Management, CLINSTD Instructional Dialogue. MQI dimensions use "
        "1-3: EXPL Explanations, REMED Remediation of Student Errors and Difficulties, "
        "LANGIMP Imprecision in Language or Notation, SMQR Student Mathematical "
        "Questioning and Reasoning. Do not infer demographics or affect."
    )
    if config.pedagogy_context == "off":
        return base
    return (
        f"{base}\n\n"
        "Attend especially to high uptake, where a teacher builds on a student's "
        "contribution, and focusing questions, which press students to articulate "
        "reasoning. Distinguish these from generic praise and funneling questions. "
        "Anchor each rating in transcript evidence."
    )
