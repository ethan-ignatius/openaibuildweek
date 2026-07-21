from __future__ import annotations

import json
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Mapping

import numpy as np
import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from packages.evals.ncte.data import NCTEDataset
from packages.harness.config import HarnessConfig
from packages.harness.journal import JournalWriter
from packages.harness.model_client import (
    StructuredModelClient,
    TokenUsage,
    ToolDefinition,
)

ArenaCondition = Literal["bare", "scaffolded", "full"]
ARENA_CONDITIONS: tuple[ArenaCondition, ...] = ("bare", "scaffolded", "full")
_TURN_SUFFIX = re.compile(r"_(\d+)$")


class TeachingMove(BaseModel):
    """A next teaching move selected before the human response is revealed."""

    model_config = ConfigDict(extra="forbid")

    response: str = Field(min_length=1, max_length=1800)
    high_uptake_probability: float = Field(ge=0.0, le=1.0)
    focusing_question_probability: float = Field(ge=0.0, le=1.0)
    rationale: str = Field(min_length=1, max_length=1200)
    evidence_from_history: list[str] = Field(max_length=5)


class ClassroomState(BaseModel):
    """Bounded, anonymous state carried only by the full harness condition."""

    model_config = ConfigDict(extra="forbid")

    learner_notes_markdown: str = Field(max_length=5000)
    lesson_progress_summary: str = Field(max_length=1800)
    participation_observations: str = Field(max_length=1200)


class HarnessCommit(BaseModel):
    model_config = ConfigDict(extra="forbid")

    move: TeachingMove
    state_after: ClassroomState


@dataclass(frozen=True)
class GhostDecision:
    observation_id: str
    exchange_id: str
    student_turn_index: int
    transcript_prefix: str
    student_text: str
    actual_teacher_text: str
    high_uptake: int
    focusing_question: int


@dataclass(frozen=True)
class GhostEpisode:
    observation_id: str
    total_turns: int
    decisions: tuple[GhostDecision, ...]


@dataclass(frozen=True)
class ArenaRun:
    predictions: pd.DataFrame
    usage_by_condition: Mapping[str, TokenUsage]


class ArenaCheckpoint:
    """Append-only prediction checkpoint used for bounded-cost resume."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)

    def records(self) -> list[dict[str, Any]]:
        if not self.path.is_file():
            return []
        records: list[dict[str, Any]] = []
        with self.path.open(encoding="utf-8") as checkpoint_file:
            for line_number, line in enumerate(checkpoint_file, start=1):
                if not line.strip():
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError as error:
                    raise ValueError(
                        f"Invalid arena checkpoint at {self.path}:{line_number}: {error}"
                    ) from error
                if not isinstance(record, dict):
                    raise ValueError(
                        f"Arena checkpoint record {line_number} is not an object"
                    )
                records.append(record)
        return records

    def append(self, record: Mapping[str, Any]) -> None:
        encoded = json.dumps(record, ensure_ascii=True, separators=(",", ":"))
        with self._lock:
            with self.path.open("a", encoding="utf-8") as checkpoint_file:
                checkpoint_file.write(encoded + "\n")
                checkpoint_file.flush()


def select_arena_observations(
    dataset: NCTEDataset,
    *,
    count: int,
    exclude_observations: set[str] | None = None,
    minimum_decisions: int = 10,
    minimum_turns: int = 120,
    maximum_turns: int = 260,
) -> list[str]:
    """Select dense, bounded-length episodes without consulting label values."""

    if count < 1:
        raise ValueError("Observation count must be positive")
    excluded = exclude_observations or set()
    exchange_counts = (
        dataset.exchanges[~dataset.exchanges["observation_id"].isin(excluded)]
        .groupby("observation_id")
        .size()
        .rename("decision_count")
    )
    turn_counts = (
        dataset.utterances.groupby("observation_id").size().rename("turn_count")
    )
    candidates = pd.concat([exchange_counts, turn_counts], axis=1).dropna()
    candidates = candidates[
        (candidates["decision_count"] >= minimum_decisions)
        & (candidates["turn_count"] >= minimum_turns)
        & (candidates["turn_count"] <= maximum_turns)
    ].copy()
    candidates["annotation_density"] = (
        candidates["decision_count"] / candidates["turn_count"]
    )
    candidates["stable_id"] = candidates.index.astype(str)
    candidates = candidates.sort_values(
        ["annotation_density", "stable_id"],
        ascending=[False, True],
        kind="stable",
    )
    selected = candidates.index.astype(str).tolist()[:count]
    if len(selected) < count:
        raise ValueError(
            f"Only {len(selected)} NCTE observations satisfy the arena constraints; "
            f"{count} requested"
        )
    return selected


def build_ghost_episodes(
    dataset: NCTEDataset,
    observation_ids: list[str],
    *,
    decisions_per_observation: int,
) -> list[GhostEpisode]:
    if decisions_per_observation < 1:
        raise ValueError("decisions_per_observation must be positive")
    episodes: list[GhostEpisode] = []
    for observation_id in observation_ids:
        transcript = dataset.utterances[
            dataset.utterances["observation_id"] == observation_id
        ].sort_values("turn_index", kind="stable")
        exchanges = dataset.exchanges[
            dataset.exchanges["observation_id"] == observation_id
        ].copy()
        if transcript.empty or exchanges.empty:
            raise ValueError(f"Observation {observation_id} has no aligned transcript")

        exchanges["student_turn_index"] = exchanges["exchange_id"].map(
            _student_turn_index
        )
        exchanges = exchanges.sort_values("student_turn_index", kind="stable")
        if len(exchanges) < decisions_per_observation:
            raise ValueError(
                f"Observation {observation_id} has only {len(exchanges)} decisions"
            )
        positions = np.linspace(
            0,
            len(exchanges) - 1,
            num=decisions_per_observation,
        ).round().astype(int)
        selected = exchanges.iloc[positions]

        decisions: list[GhostDecision] = []
        for row in selected.itertuples(index=False):
            turn_index = int(row.student_turn_index)
            turn = transcript[transcript["turn_index"] == turn_index]
            if len(turn) != 1:
                raise ValueError(
                    f"Exchange {row.exchange_id} does not map to exactly one turn"
                )
            turn_row = turn.iloc[0]
            if str(turn_row["speaker"]).strip().casefold() not in {
                "student",
                "multiple students",
            }:
                raise ValueError(f"Exchange {row.exchange_id} is not a student turn")
            if _normalize_text(turn_row["text"]) != _normalize_text(row.student_text):
                raise ValueError(
                    f"Exchange {row.exchange_id} student text does not match transcript"
                )
            next_teacher = transcript[
                (transcript["turn_index"] > turn_index)
                & (transcript["speaker"].str.strip().str.casefold() == "teacher")
            ].head(1)
            if next_teacher.empty or _normalize_text(
                next_teacher.iloc[0]["text"]
            ) != _normalize_text(row.teacher_text):
                raise ValueError(
                    f"Exchange {row.exchange_id} teacher text does not match the next "
                    "teacher turn"
                )
            prefix_rows = transcript[transcript["turn_index"] <= turn_index]
            transcript_prefix = "\n".join(
                f"{_speaker_label(prefix.speaker)}: {prefix.text}"
                for prefix in prefix_rows.itertuples(index=False)
            )
            decisions.append(
                GhostDecision(
                    observation_id=observation_id,
                    exchange_id=str(row.exchange_id),
                    student_turn_index=turn_index,
                    transcript_prefix=transcript_prefix,
                    student_text=str(row.student_text),
                    actual_teacher_text=str(row.teacher_text),
                    high_uptake=int(row.high_uptake),
                    focusing_question=int(row.focusing_question),
                )
            )
        episodes.append(
            GhostEpisode(
                observation_id=observation_id,
                total_turns=len(transcript),
                decisions=tuple(decisions),
            )
        )
    return episodes


def run_arena(
    episodes: list[GhostEpisode],
    *,
    conditions: tuple[ArenaCondition, ...],
    clients: Mapping[str, StructuredModelClient],
    configs: Mapping[str, HarnessConfig],
    checkpoint: ArenaCheckpoint,
    journal: JournalWriter,
    max_workers: int = 1,
) -> ArenaRun:
    if not episodes:
        raise ValueError("At least one ghost-classroom episode is required")
    if max_workers < 1:
        raise ValueError("max_workers must be positive")
    invalid = set(conditions) - set(ARENA_CONDITIONS)
    if invalid:
        raise ValueError(f"Unknown arena conditions: {sorted(invalid)}")

    existing = checkpoint.records()
    records = list(existing)
    completed = {
        (str(record["condition"]), str(record["exchange_id"]))
        for record in existing
    }
    usage_by_condition = _checkpoint_usage(existing)

    for condition in conditions:
        if condition not in clients or condition not in configs:
            raise ValueError(f"Missing model client or config for {condition}")

        def run_episode(episode: GhostEpisode) -> list[dict[str, Any]]:
            prior_records = [
                record
                for record in records
                if record.get("condition") == condition
                and record.get("observation_id") == episode.observation_id
            ]
            state = _restored_state(prior_records) if condition == "full" else None
            produced: list[dict[str, Any]] = []
            for decision_number, decision in enumerate(episode.decisions, start=1):
                if (condition, decision.exchange_id) in completed:
                    continue
                record, usage = predict_next_move(
                    decision,
                    condition=condition,
                    client=clients[condition],
                    config=configs[condition],
                    state=state,
                    decision_number=decision_number,
                    decision_count=len(episode.decisions),
                )
                checkpoint.append(record)
                journal.append(
                    "eval.prediction",
                    {
                        "eval": "ncte-ghost-classroom",
                        **record,
                    },
                    latency_ms=float(record["latency_ms"]),
                    token_usage=usage.as_dict(),
                )
                produced.append(record)
                if condition == "full":
                    state = ClassroomState.model_validate(record["state_after"])
                print(
                    f"[{condition}] observation {episode.observation_id} "
                    f"decision {decision_number}/{len(episode.decisions)} complete",
                    flush=True,
                )
            return produced

        worker_count = min(max_workers, len(episodes))
        if worker_count <= 1:
            condition_records = [run_episode(episode) for episode in episodes]
        else:
            with ThreadPoolExecutor(max_workers=worker_count) as executor:
                condition_records = list(executor.map(run_episode, episodes))
        for episode_records in condition_records:
            records.extend(episode_records)
            for record in episode_records:
                usage_by_condition[condition] = usage_by_condition.get(
                    condition, TokenUsage()
                ) + _record_usage(record)

    output = pd.DataFrame.from_records(records)
    output = output.sort_values(
        ["condition", "observation_id", "student_turn_index"], kind="stable"
    ).reset_index(drop=True)
    return ArenaRun(predictions=output, usage_by_condition=usage_by_condition)


def predict_next_move(
    decision: GhostDecision,
    *,
    condition: ArenaCondition,
    client: StructuredModelClient,
    config: HarnessConfig,
    state: ClassroomState | None = None,
    decision_number: int = 1,
    decision_count: int = 1,
) -> tuple[dict[str, Any], TokenUsage]:
    system_prompt = _system_prompt(condition)
    user_prompt = _user_prompt(
        decision,
        condition=condition,
        state=state,
        decision_number=decision_number,
        decision_count=decision_count,
    )
    state_before = state or _empty_state()

    if condition == "full":
        captured: dict[str, HarnessCommit] = {}

        def commit_handler(arguments: dict[str, Any]) -> Mapping[str, Any]:
            commit = HarnessCommit.model_validate(arguments)
            captured["commit"] = commit
            return {
                "ok": True,
                "committed_state": commit.state_after.model_dump(mode="json"),
            }

        tool = ToolDefinition(
            name="commit_teaching_move",
            description=(
                "Commit the next teaching move and atomically replace the bounded, "
                "anonymous learner and lesson state. Use only transcript evidence."
            ),
            parameters=HarnessCommit.model_json_schema(),
            handler=commit_handler,
        )
        result = client.execute_required_tool(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            tool=tool,
            metadata={
                "eval": "ncte-ghost-classroom",
                "condition": condition,
                "observation": decision.observation_id,
            },
        )
        commit = captured.get("commit")
        if commit is None:
            raise RuntimeError("Full harness did not commit a teaching move")
        move = commit.move
        state_after = commit.state_after
        usage = result.usage
        latency_ms = result.latency_ms
        response_id = result.response_id
    else:
        result = client.generate_structured(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            response_model=TeachingMove,
            metadata={
                "eval": "ncte-ghost-classroom",
                "condition": condition,
                "observation": decision.observation_id,
            },
        )
        move = result.parsed
        state_after = state_before
        usage = result.usage
        latency_ms = result.latency_ms
        response_id = result.response_id

    record: dict[str, Any] = {
        "condition": condition,
        "observation_id": decision.observation_id,
        "exchange_id": decision.exchange_id,
        "student_turn_index": decision.student_turn_index,
        "student_text": decision.student_text,
        "actual_teacher_text": decision.actual_teacher_text,
        "high_uptake": decision.high_uptake,
        "focusing_question": decision.focusing_question,
        **move.model_dump(mode="json"),
        "state_before": state_before.model_dump(mode="json"),
        "state_after": state_after.model_dump(mode="json"),
        "latency_ms": latency_ms,
        "response_id": response_id,
        "input_tokens": usage.input,
        "output_tokens": usage.output,
        "total_tokens": usage.total,
    }
    return record, usage


def write_arena_replay(path: Path, predictions: pd.DataFrame) -> None:
    """Write a local-only replay containing licensed transcript excerpts."""

    lines = [
        "# NCTE Ghost Classroom Replay",
        "",
        "> Contains authorized NCTE transcript text. Keep this artifact in ignored state.",
    ]
    decision_keys = (
        predictions[["observation_id", "student_turn_index"]]
        .drop_duplicates()
        .sort_values(["observation_id", "student_turn_index"], kind="stable")
    )
    for key in decision_keys.itertuples(index=False):
        rows = predictions[
            (predictions["observation_id"] == key.observation_id)
            & (predictions["student_turn_index"] == key.student_turn_index)
        ]
        exemplar = rows.iloc[0]
        lines.extend(
            [
                "",
                f"## Observation {key.observation_id}, turn {key.student_turn_index}",
                "",
                f"**Student:** {exemplar['student_text']}",
                "",
                f"**Actual teacher:** {exemplar['actual_teacher_text']}",
                "",
                "**Human annotations:** "
                f"high uptake={int(exemplar['high_uptake'])}, "
                f"focusing question={int(exemplar['focusing_question'])}",
            ]
        )
        for condition in ARENA_CONDITIONS:
            condition_rows = rows[rows["condition"] == condition]
            if condition_rows.empty:
                continue
            row = condition_rows.iloc[0]
            lines.extend(
                [
                    "",
                    f"### {condition.title()}",
                    "",
                    str(row["response"]),
                    "",
                    f"Move probabilities: uptake={row['high_uptake_probability']:.3f}, "
                    f"focusing={row['focusing_question_probability']:.3f}",
                    "",
                    f"Rationale: {row['rationale']}",
                ]
            )
            if condition == "full":
                state_after = row["state_after"]
                lines.extend(
                    [
                        "",
                        "Harness learner notes after this decision:",
                        "",
                        str(state_after.get("learner_notes_markdown", "")),
                    ]
                )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _system_prompt(condition: ArenaCondition) -> str:
    base = (
        "You are GPT-5.6 choosing the next teacher move in an anonymized elementary "
        "mathematics classroom. The transcript stops immediately after a student turn. "
        "Respond as the teacher; do not predict or quote the hidden human response. "
        "The probability fields describe whether YOUR proposed response enacts each "
        "named discourse move. Use only transcript evidence. Never infer identity, "
        "demographics, age, emotion, or confusion."
    )
    if condition == "bare":
        return base
    pedagogy = (
        "\n\nPedagogical context:\n"
        "- High uptake: build on, revoice, or connect the student's specific "
        "contribution. Generic praise or a topic change is not high uptake.\n"
        "- Focusing question: press the student to articulate or justify reasoning "
        "without funneling them through prescribed steps.\n"
        "- On a student's first mathematical error, prefer a Socratic hint over giving "
        "the final answer. Preserve mathematically useful student thinking."
    )
    if condition == "scaffolded":
        return base + pedagogy
    return (
        base
        + pedagogy
        + "\n\nYou are operating inside Teacher Brain. You must call the commit tool "
        "once. Update bounded learner notes, lesson progress, and participation "
        "observations from the transcript. The transcript follows the recorded human "
        "teacher path, so later observed turns are authoritative; never assume an "
        "earlier proposed agent response actually occurred. Student speakers are "
        "anonymized, so do not invent student identities or individual profiles."
    )


def _user_prompt(
    decision: GhostDecision,
    *,
    condition: ArenaCondition,
    state: ClassroomState | None,
    decision_number: int,
    decision_count: int,
) -> str:
    prompt = (
        f"Decision {decision_number} of {decision_count} in this classroom episode.\n\n"
        "TRANSCRIPT PREFIX (the final line is the pause point):\n"
        f"{decision.transcript_prefix}\n\n"
        "Choose the teacher's next response now."
    )
    if condition != "full":
        return prompt
    state_json = json.dumps(
        (state or _empty_state()).model_dump(mode="json"),
        ensure_ascii=True,
        indent=2,
    )
    return f"{prompt}\n\nCURRENT TEACHER BRAIN STATE:\n{state_json}"


def _student_turn_index(exchange_id: object) -> int:
    match = _TURN_SUFFIX.search(str(exchange_id))
    if match is None:
        raise ValueError(f"Exchange ID does not encode a student turn: {exchange_id}")
    return int(match.group(1))


def _speaker_label(speaker: object) -> str:
    normalized = str(speaker).strip().casefold()
    if normalized == "teacher":
        return "Teacher"
    if normalized == "multiple students":
        return "Multiple students"
    return "Student"


def _normalize_text(value: object) -> str:
    text = str(value).translate(
        str.maketrans({"’": "'", "‘": "'", "“": '"', "”": '"'})
    )
    return " ".join(text.split()).casefold()


def _restored_state(records: list[Mapping[str, Any]]) -> ClassroomState:
    if not records:
        return _empty_state()
    latest = max(records, key=lambda record: int(record["student_turn_index"]))
    return ClassroomState.model_validate(latest["state_after"])


def _record_usage(record: Mapping[str, Any]) -> TokenUsage:
    return TokenUsage(
        input=int(record.get("input_tokens", 0)),
        output=int(record.get("output_tokens", 0)),
        total=int(record.get("total_tokens", 0)),
    )


def _empty_state() -> ClassroomState:
    return ClassroomState(
        learner_notes_markdown="",
        lesson_progress_summary="",
        participation_observations="",
    )


def _checkpoint_usage(records: list[Mapping[str, Any]]) -> dict[str, TokenUsage]:
    usage: dict[str, TokenUsage] = {}
    for record in records:
        condition = str(record["condition"])
        usage[condition] = usage.get(condition, TokenUsage()) + _record_usage(record)
    return usage
