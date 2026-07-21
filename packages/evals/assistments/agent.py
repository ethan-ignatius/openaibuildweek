from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Protocol

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from packages.harness.config import HarnessConfig, MemoryMode
from packages.harness.journal import JournalWriter
from packages.harness.learner_memory import LearnerMemory
from packages.harness.model_client import (
    StructuredModelClient,
    TokenUsage,
)


class NextItemPrediction(BaseModel):
    model_config = ConfigDict(extra="forbid")

    probability_correct: float = Field(ge=0.0, le=1.0)
    rationale: str = Field(min_length=1, max_length=1000)


@dataclass(frozen=True)
class PredictionOutcome:
    probability_correct: float
    rationale: str
    usage: TokenUsage
    latency_ms: float


class AssistmentsPredictor(Protocol):
    def predict_after_chunk(
        self,
        *,
        student: str,
        new_chunk: Sequence[Mapping[str, object]],
        observed_history: Sequence[Mapping[str, object]],
        next_skill_id: str,
        next_skill_name: str,
    ) -> PredictionOutcome: ...


class OpenAIAssistmentsPredictor:
    def __init__(
        self,
        *,
        config: HarnessConfig,
        client: StructuredModelClient,
        memory: LearnerMemory,
        journal: JournalWriter | None = None,
    ) -> None:
        self.config = config
        self.client = client
        self.memory = memory
        self.journal = journal

    def predict_after_chunk(
        self,
        *,
        student: str,
        new_chunk: Sequence[Mapping[str, object]],
        observed_history: Sequence[Mapping[str, object]],
        next_skill_id: str,
        next_skill_name: str,
    ) -> PredictionOutcome:
        metadata = {"eval": "assistments", "student": student}
        total_usage = TokenUsage()
        total_latency = 0.0

        if self.journal:
            self.journal.append(
                "eval.observation",
                {
                    "eval": "assistments",
                    "student": student,
                    "chunk": list(new_chunk),
                    "memory_mode": self.config.memory_mode.value,
                },
            )

        if self.config.memory_mode == MemoryMode.NOTES:
            current_note = self.memory.read(student)
            tool_run = self.client.execute_required_tool(
                system_prompt=_memory_system_prompt(student),
                user_prompt=_memory_update_prompt(current_note, new_chunk),
                tool=self.memory.write_tool(expected_student=student),
                metadata=metadata,
            )
            total_usage += tool_run.usage
            total_latency += tool_run.latency_ms

        prediction_context = self._prediction_context(student, observed_history)
        prediction = self.client.generate_structured(
            system_prompt=_prediction_system_prompt(),
            user_prompt=(
                f"Context available under the active memory ablation:\n"
                f"{prediction_context}\n\n"
                f"Next item skill ID: {next_skill_id}\n"
                f"Next item skill name: {next_skill_name}\n\n"
                "Estimate P(correct) for this next item. Do not assume access to the "
                "next response or any student identity outside the pseudonym."
            ),
            response_model=NextItemPrediction,
            metadata=metadata,
        )
        total_usage += prediction.usage
        total_latency += prediction.latency_ms
        outcome = PredictionOutcome(
            probability_correct=prediction.parsed.probability_correct,
            rationale=prediction.parsed.rationale,
            usage=total_usage,
            latency_ms=total_latency,
        )
        if self.journal:
            self.journal.append(
                "eval.prediction",
                {
                    "eval": "assistments",
                    "student": student,
                    "next_skill_id": next_skill_id,
                    "probability_correct": outcome.probability_correct,
                    "memory_mode": self.config.memory_mode.value,
                },
                latency_ms=outcome.latency_ms,
            )
        return outcome

    def _prediction_context(
        self,
        student: str,
        observed_history: Sequence[Mapping[str, object]],
    ) -> str:
        if self.config.memory_mode == MemoryMode.NOTES:
            return self.memory.read(student)
        if self.config.memory_mode == MemoryMode.FULL_CONTEXT:
            return json.dumps(list(observed_history), ensure_ascii=True, separators=(",", ":"))
        return "No learner history or notes are available."


def run_prediction_loop(
    interactions: pd.DataFrame,
    held_out_students: Sequence[str],
    predictor: AssistmentsPredictor,
    *,
    chunk_size: int = 10,
    max_students: int | None = None,
    max_predictions: int | None = None,
    max_workers: int = 1,
) -> tuple[pd.DataFrame, TokenUsage]:
    if chunk_size < 1:
        raise ValueError("chunk_size must be positive")
    if max_predictions is not None and max_predictions < 1:
        raise ValueError("max_predictions must be positive")
    if max_workers < 1:
        raise ValueError("max_workers must be positive")
    selected_students = list(held_out_students)
    if max_students is not None:
        selected_students = selected_students[:max_students]

    tasks: list[tuple[str, list[dict[str, object]], int | None]] = []
    remaining_predictions = max_predictions
    for student in selected_students:
        student_rows = interactions[interactions["student_id"] == student].sort_values(
            "sequence_index", kind="stable"
        )
        observations = student_rows.to_dict(orient="records")
        available = max(0, (len(observations) - 1) // chunk_size)
        limit = None
        if remaining_predictions is not None:
            limit = min(available, remaining_predictions)
            remaining_predictions -= limit
        if available and (limit is None or limit > 0):
            tasks.append((student, observations, limit))
        if remaining_predictions == 0:
            break

    def predict_student(
        task: tuple[str, list[dict[str, object]], int | None],
    ) -> tuple[list[dict[str, object]], TokenUsage]:
        student, observations, prediction_limit = task
        student_records: list[dict[str, object]] = []
        student_usage = TokenUsage()
        for boundary in range(chunk_size, len(observations), chunk_size):
            if prediction_limit is not None and len(student_records) >= prediction_limit:
                break
            new_chunk = observations[boundary - chunk_size : boundary]
            history = observations[:boundary]
            next_item = observations[boundary]
            outcome = predictor.predict_after_chunk(
                student=student,
                new_chunk=new_chunk,
                observed_history=history,
                next_skill_id=str(next_item["skill_id"]),
                next_skill_name=str(next_item["skill_name"]),
            )
            student_usage += outcome.usage
            student_records.append(
                {
                    "student_id": student,
                    "sequence_index": int(next_item["sequence_index"]),
                    "skill_id": str(next_item["skill_id"]),
                    "correct": int(next_item["correct"]),
                    "probability": outcome.probability_correct,
                    "rationale": outcome.rationale,
                    "latency_ms": outcome.latency_ms,
                    "input_tokens": outcome.usage.input,
                    "output_tokens": outcome.usage.output,
                    "total_tokens": outcome.usage.total,
                    "model": "agent",
                }
            )
        return student_records, student_usage

    worker_count = min(max_workers, len(tasks))
    if worker_count == 0:
        raise ValueError("No prediction points were produced for the selected students")
    if worker_count == 1:
        student_results = [predict_student(task) for task in tasks]
    else:
        with ThreadPoolExecutor(max_workers=worker_count) as executor:
            student_results = list(executor.map(predict_student, tasks))

    records: list[dict[str, object]] = []
    total_usage = TokenUsage()
    for student_records, student_usage in student_results:
        records.extend(student_records)
        total_usage += student_usage
    return pd.DataFrame.from_records(records), total_usage


def prediction_targets(
    interactions: pd.DataFrame,
    held_out_students: Sequence[str],
    *,
    chunk_size: int,
    max_students: int | None = None,
    max_predictions: int | None = None,
) -> pd.DataFrame:
    selected_students = list(held_out_students)
    if max_students is not None:
        selected_students = selected_students[:max_students]
    targets: list[dict[str, object]] = []
    for student in selected_students:
        rows = interactions[interactions["student_id"] == student].sort_values(
            "sequence_index", kind="stable"
        )
        for boundary in range(chunk_size, len(rows), chunk_size):
            if max_predictions is not None and len(targets) >= max_predictions:
                break
            targets.append(
                {
                    "student_id": student,
                    "sequence_index": int(rows.iloc[boundary]["sequence_index"]),
                }
            )
        if max_predictions is not None and len(targets) >= max_predictions:
            break
    return pd.DataFrame.from_records(targets)


def _memory_system_prompt(student: str) -> str:
    return (
        "You maintain a calibrated, human-readable learner model from externally "
        "observed ASSISTments outcomes. Update only evidence-supported mastery estimates "
        "and misconceptions. Never infer demographics, emotion, age, or language. You "
        f"must call learner_write exactly once for pseudonym {student}. Preserve these "
        "Markdown sections exactly: Mastery estimates, Observed misconceptions, Language, "
        "Participation notes, Strategies that worked. Do not mention or anticipate any "
        "future item."
    )


def _memory_update_prompt(
    current_note: str,
    new_chunk: Sequence[Mapping[str, object]],
) -> str:
    return (
        f"Current learner note:\n{current_note}\n\n"
        "New chronological first-attempt outcomes:\n"
        f"{json.dumps(list(new_chunk), ensure_ascii=True, separators=(',', ':'))}\n\n"
        "Write the complete replacement learner note now."
    )


def _prediction_system_prompt() -> str:
    return (
        "You are a probability forecaster for knowledge tracing. Return a calibrated "
        "probability, not a binary judgment. The response will be scored with AUC and "
        "Brier score against a real held-out ASSISTments response. Use only the context "
        "shown and the next skill tag. Memorization of student or problem IDs cannot help."
    )
