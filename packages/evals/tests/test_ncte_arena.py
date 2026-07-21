from __future__ import annotations

from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from packages.evals.metrics import BinaryMetrics
from packages.evals.ncte.arena import (
    ArenaCheckpoint,
    ClassroomState,
    HarnessCommit,
    TeachingMove,
    build_ghost_episodes,
    predict_next_move,
    select_arena_observations,
)
from packages.evals.ncte.arena_report import write_arena_report
from packages.evals.ncte.data import NCTEDataset
from packages.harness.config import HarnessConfig
from packages.harness.model_client import ModelResult, TokenUsage, ToolRunResult


class FakeArenaClient:
    def __init__(self) -> None:
        self.structured_calls: list[dict[str, Any]] = []
        self.tool_calls: list[dict[str, Any]] = []

    def generate_structured(self, **kwargs: Any) -> ModelResult[Any]:
        self.structured_calls.append(kwargs)
        return ModelResult(
            parsed=TeachingMove(
                response="You noticed the denominator. What does it count?",
                high_uptake_probability=0.8,
                focusing_question_probability=0.9,
                rationale="It uses the student's denominator observation.",
                evidence_from_history=["The student named the denominator."],
            ),
            usage=TokenUsage(input=20, output=10, total=30),
            latency_ms=15.0,
            response_id="bare-response",
        )

    def execute_required_tool(self, **kwargs: Any) -> ToolRunResult:
        self.tool_calls.append(kwargs)
        prior_retained = "denominator evidence" in kwargs["user_prompt"]
        arguments = HarnessCommit(
            move=TeachingMove(
                response="You connected the denominator to equal parts. Why four parts?",
                high_uptake_probability=0.95,
                focusing_question_probability=0.9,
                rationale="The move revoices and presses for reasoning.",
                evidence_from_history=["The student referred to four equal parts."],
            ),
            state_after=ClassroomState(
                learner_notes_markdown="denominator evidence retained",
                lesson_progress_summary="Fractions are under discussion.",
                participation_observations="Speakers are anonymous.",
            ),
        ).model_dump(mode="json")
        result = kwargs["tool"].handler(arguments)
        assert result["ok"] is True
        if len(self.tool_calls) > 1:
            assert prior_retained
        return ToolRunResult(
            result=result,
            usage=TokenUsage(input=25, output=15, total=40),
            latency_ms=18.0,
            response_id="full-response",
            continuation_input=(),
        )


def test_ghost_episodes_align_turns_and_hide_teacher_response() -> None:
    dataset = _arena_dataset()

    episodes = build_ghost_episodes(
        dataset,
        ["201"],
        decisions_per_observation=2,
    )

    assert len(episodes) == 1
    assert [item.student_turn_index for item in episodes[0].decisions] == [1, 5]
    first = episodes[0].decisions[0]
    assert first.transcript_prefix.endswith("Student: It has four parts.")
    assert "How do the four parts help us name it?" not in first.transcript_prefix
    assert first.actual_teacher_text == "How do the four parts help us name it?"

    misaligned = _arena_dataset()
    misaligned.exchanges.loc[0, "teacher_text"] = "A different hidden reply."
    with pytest.raises(ValueError, match="next teacher turn"):
        build_ghost_episodes(
            misaligned,
            ["201"],
            decisions_per_observation=2,
        )


def test_arena_selection_uses_density_not_label_values() -> None:
    dataset = _arena_dataset(include_selection_candidates=True)

    selected = select_arena_observations(
        dataset,
        count=1,
        exclude_observations={"201"},
        minimum_decisions=2,
        minimum_turns=4,
        maximum_turns=20,
    )

    assert selected == ["202"]


def test_full_condition_commits_and_reuses_bounded_state() -> None:
    decision = build_ghost_episodes(
        _arena_dataset(),
        ["201"],
        decisions_per_observation=2,
    )[0].decisions
    client = FakeArenaClient()
    config = HarnessConfig()

    first, usage = predict_next_move(
        decision[0],
        condition="full",
        client=client,
        config=config,
        decision_number=1,
        decision_count=2,
    )
    second, _ = predict_next_move(
        decision[1],
        condition="full",
        client=client,
        config=config,
        state=ClassroomState.model_validate(first["state_after"]),
        decision_number=2,
        decision_count=2,
    )

    assert usage.total == 40
    assert len(client.tool_calls) == 2
    assert not client.structured_calls
    assert "denominator evidence" in second["state_before"]["learner_notes_markdown"]
    schema = HarnessCommit.model_json_schema()
    assert set(schema["required"]) == {"move", "state_after"}
    assert set(schema["$defs"]["ClassroomState"]["required"]) == {
        "learner_notes_markdown",
        "lesson_progress_summary",
        "participation_observations",
    }


def test_arena_checkpoint_round_trip_and_report_lift(tmp_path: Path) -> None:
    checkpoint = ArenaCheckpoint(tmp_path / "predictions.jsonl")
    checkpoint.append({"condition": "bare", "exchange_id": "201_1"})
    assert checkpoint.records() == [
        {"condition": "bare", "exchange_id": "201_1"}
    ]

    report = tmp_path / "report.md"
    metrics = {
        "bare": {
            "high_uptake": BinaryMetrics(4, 0.5, 0.3, 0.4),
            "focusing_question": BinaryMetrics(4, 0.5, 0.3, 0.4),
        },
        "full": {
            "high_uptake": BinaryMetrics(4, 0.8, 0.2, 0.7),
            "focusing_question": BinaryMetrics(4, 0.8, 0.2, 0.7),
        },
    }
    predictions = pd.DataFrame(
        {
            "condition": ["bare", "full"],
            "latency_ms": [20.0, 25.0],
        }
    )
    write_arena_report(
        report,
        status="COMPLETE",
        status_detail="Fixture run.",
        model="gpt-5.6",
        predictions=predictions,
        metrics=metrics,
        usage_by_condition={
            "bare": TokenUsage(input=10, output=5, total=15),
            "full": TokenUsage(input=12, output=6, total=18),
        },
        observation_ids=["201"],
        decisions_per_observation=2,
        session_directory=tmp_path,
    )

    content = report.read_text(encoding="utf-8")
    assert "Macro F1 full-minus-bare: **+0.3000**" in content
    assert "Total tokens processed: **33**" in content
    assert "off-policy" in content


def _arena_dataset(*, include_selection_candidates: bool = False) -> NCTEDataset:
    utterance_rows = [
        ("201", 0, "teacher", "What fraction is shaded?"),
        ("201", 1, "student", "It has four parts."),
        ("201", 2, "teacher", "How do the four parts help us name it?"),
        ("201", 3, "student", "They are equal."),
        ("201", 4, "teacher", "Yes, equal-sized parts matter."),
        ("201", 5, "student", "So the bottom number is four."),
        ("201", 6, "teacher", "What does that four tell us?"),
        ("201", 7, "student", "How many equal parts there are."),
    ]
    exchange_rows = [
        ("201_1", "201", "It has four parts.", "How do the four parts help us name it?", 1, 1),
        ("201_3", "201", "They are equal.", "Yes, equal-sized parts matter.", 1, 0),
        ("201_5", "201", "So the bottom number is four.", "What does that four tell us?", 1, 1),
    ]
    if include_selection_candidates:
        utterance_rows.extend(
            ("202", index, "student" if index % 2 else "teacher", f"Turn {index}")
            for index in range(6)
        )
        exchange_rows.extend(
            [
                ("202_1", "202", "Turn 1", "Reply one", 0, 0),
                ("202_3", "202", "Turn 3", "Reply two", 0, 0),
            ]
        )
    utterances = pd.DataFrame(
        utterance_rows,
        columns=["observation_id", "turn_index", "speaker", "text"],
    )
    exchanges = pd.DataFrame(
        exchange_rows,
        columns=[
            "exchange_id",
            "observation_id",
            "student_text",
            "teacher_text",
            "high_uptake",
            "focusing_question",
        ],
    )
    scores = pd.DataFrame({"observation_id": ["201", "202"]})
    return NCTEDataset(
        exchanges=exchanges,
        utterances=utterances,
        observation_scores=scores,
    )
