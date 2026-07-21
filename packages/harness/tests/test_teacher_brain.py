from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from packages.harness.config import HarnessConfig
from packages.harness.journal import JournalReader
from packages.harness.learner_memory import LearnerMemory
from packages.harness.model_client import ModelResult, TokenUsage, ToolRunResult
from packages.harness.teacher_brain import (
    ClassroomConflictError,
    ClassroomStudent,
    InterruptionRequest,
    StartClassroomRequest,
    TeachRequest,
    TeacherBrain,
    TeachingTurnPlan,
)
from packages.shared.schema import validate_payload
from scripts.replay import replay
from server.app.main import app, get_teacher_brain_service


class RecordingBoard:
    def __init__(self) -> None:
        self.actions: list[dict[str, Any]] = []

    async def __call__(self, action: dict[str, Any]) -> None:
        self.actions.append(dict(action))


class FakeClassroomClient:
    def __init__(self) -> None:
        self.structured_calls: list[dict[str, Any]] = []
        self.memory_calls: list[dict[str, Any]] = []

    def generate_structured(self, **kwargs: Any) -> ModelResult[TeachingTurnPlan]:
        self.structured_calls.append(kwargs)
        interruption = "A student interrupted" in kwargs["user_prompt"]
        if interruption:
            plan = TeachingTurnPlan.model_validate(
                {
                    "board_actions": [
                        {"type": "board.clear", "region": "all"},
                        {
                            "type": "board.write_text",
                            "region": "top",
                            "text": "Una fracción compara una parte con el entero.",
                            "element_id": "fraction-definition",
                        },
                        {
                            "type": "board.draw_fraction_bars",
                            "fractions": ["3/4"],
                            "element_id": "three-fourths",
                        },
                    ],
                    "narration_segments": [
                        {
                            "text": "Tres cuartos significa tres de cuatro partes iguales.",
                            "language": "Spanish",
                            "highlight_element_id": "three-fourths",
                        }
                    ],
                    "check_for_understanding": "¿Cuántas partes están coloreadas?",
                    "pedagogical_rationale": "The area model makes the denominator visible.",
                    "resume_guidance": "Reconnect three-fourths to the number-line example.",
                }
            )
        else:
            plan = TeachingTurnPlan.model_validate(
                {
                    "board_actions": [
                        {"type": "board.clear", "region": "all"},
                        {
                            "type": "board.write_math",
                            "region": "center",
                            "latex": "3/4",
                            "element_id": "lesson-fraction",
                        },
                        {
                            "type": "board.highlight",
                            "element_id": "lesson-fraction",
                            "style": "pulse",
                        },
                    ],
                    "narration_segments": [
                        {
                            "text": "The denominator tells us the number of equal parts.",
                            "language": "English",
                            "highlight_element_id": "lesson-fraction",
                        }
                    ],
                    "check_for_understanding": "What does the numerator count?",
                    "pedagogical_rationale": "Name the whole before comparing the parts.",
                    "resume_guidance": "Continue with three-fourths on a number line.",
                }
            )
        return ModelResult(
            parsed=plan,
            usage=TokenUsage(input=100, output=40, total=140),
            latency_ms=25.0,
            response_id="classroom-fixture",
        )

    def execute_required_tool(self, **kwargs: Any) -> ToolRunResult:
        self.memory_calls.append(kwargs)
        student = kwargs["metadata"]["student"]
        note = LearnerMemory.empty_note(student).replace(
            "- None observed.",
            "- Asked how a denominator relates to equal parts; do not yet assume an error.",
        ).replace(
            "- Not provided in this evaluation.",
            "- Declared classroom language: Spanish.",
        )
        result = kwargs["tool"].handler({"student": student, "markdown": note})
        return ToolRunResult(
            result=result,
            usage=TokenUsage(input=60, output=30, total=90),
            latency_ms=15.0,
            response_id="memory-fixture",
            continuation_input=(),
        )


def make_brain(tmp_path: Path) -> tuple[TeacherBrain, RecordingBoard, FakeClassroomClient]:
    board = RecordingBoard()
    client = FakeClassroomClient()
    config = HarnessConfig(
        state_directory=tmp_path / "state",
        journal_directory=tmp_path / "journals",
    )
    brain = TeacherBrain(
        board_dispatcher=board,
        config=config,
        client_factory=lambda _config, _journal: client,
    )
    return brain, board, client


@pytest.mark.asyncio
async def test_teacher_brain_teaches_interrupts_remembers_and_replays(
    tmp_path: Path,
) -> None:
    brain, board, client = make_brain(tmp_path)
    session = brain.start_session(
        StartClassroomRequest(
            topic="Equivalent fractions",
            objective="Explain a fraction as equal parts of one whole.",
            source_material="Use area models before the number line.",
            source_ref="fractions-deck.pdf#page=3",
            students=[ClassroomStudent(name="Jordan", language="Spanish")],
        )
    )

    initialized_note = brain.get_learner_memory("Jordan").markdown
    assert "Declared classroom language: Spanish" in initialized_note

    teaching_turn = await brain.teach(
        session.session_id,
        TeachRequest(instruction="Introduce three-fourths with one visual."),
    )
    interruption_turn = await brain.interrupt(
        session.session_id,
        InterruptionRequest(
            student="Jordan",
            question="Why does the bottom number mean equal parts?",
        ),
    )

    assert teaching_turn.kind == "instruction"
    assert interruption_turn.kind == "interruption"
    assert interruption_turn.plan.board_actions[0].type == "board.clear"
    assert interruption_turn.plan.narration_segments[0].language == "Spanish"
    assert [action["type"] for action in board.actions] == [
        "board.clear",
        "board.write_math",
        "board.highlight",
        "board.clear",
        "board.write_text",
        "board.draw_fraction_bars",
    ]
    assert len(client.memory_calls) == 1
    assert "Why does the bottom number" in client.memory_calls[0]["user_prompt"]
    assert "equal parts" in brain.get_learner_memory("Jordan").markdown

    view = brain.get_session(session.session_id)
    assert view.status == "active"
    assert view.turn_index == 2
    assert "number-line" in str(view.resume_guidance)

    journal_path = tmp_path / "journals" / "classrooms" / f"{session.session_id}.jsonl"
    events = JournalReader(journal_path).read_all()
    event_types = [event["event_type"] for event in events]
    assert "session.interrupted" in event_types
    assert "voice.transcript" in event_types
    assert "session.resumed" in event_types

    replayed_actions: list[dict[str, Any]] = []
    summary = replay(journal_path, dispatch_board=replayed_actions.append)
    assert summary["board_actions"] == 6
    assert replayed_actions == board.actions

    ended = await brain.end_session(session.session_id)
    assert ended.status == "ended"
    with pytest.raises(ClassroomConflictError):
        await brain.teach(session.session_id, TeachRequest())


def test_teacher_brain_fastapi_surface(tmp_path: Path) -> None:
    brain, board, _client = make_brain(tmp_path)
    app.dependency_overrides[get_teacher_brain_service] = lambda: brain
    try:
        with TestClient(app) as http:
            created = http.post(
                "/api/teacher/sessions",
                json={
                    "topic": "Linear equations",
                    "objective": "Explain inverse operations.",
                    "students": [{"name": "Jordan", "language": "Spanish"}],
                },
            )
            assert created.status_code == 201
            session_id = created.json()["session_id"]

            taught = http.post(
                f"/api/teacher/sessions/{session_id}/teach",
                json={"instruction": "Model one equation."},
            )
            assert taught.status_code == 200
            assert taught.json()["kind"] == "instruction"

            interrupted = http.post(
                f"/api/teacher/sessions/{session_id}/interruptions",
                json={
                    "student": "Jordan",
                    "question": "Why do we subtract on both sides?",
                },
            )
            assert interrupted.status_code == 200
            assert interrupted.json()["student"] == "Jordan"
            assert interrupted.json()["plan"]["board_actions"][0] == {
                "type": "board.clear",
                "region": "all",
            }

            memory = http.get("/api/teacher/students/Jordan/memory")
            assert memory.status_code == 200
            assert "Observed misconceptions" in memory.json()["markdown"]

            unknown_student = http.post(
                f"/api/teacher/sessions/{session_id}/interruptions",
                json={"student": "Taylor", "question": "Can I ask something?"},
            )
            assert unknown_student.status_code == 404

            ended = http.post(f"/api/teacher/sessions/{session_id}/end")
            assert ended.status_code == 200
            assert ended.json()["status"] == "ended"
    finally:
        app.dependency_overrides.clear()

    assert board.actions


def test_fraction_bar_plan_rejects_browser_exhaustion_values() -> None:
    with pytest.raises(ValueError, match="denominators"):
        TeachingTurnPlan.model_validate(
            {
                "board_actions": [
                    {
                        "type": "board.draw_fraction_bars",
                        "fractions": ["1/1000000000"],
                        "element_id": "unsafe-fraction",
                    }
                ],
                "narration_segments": [
                    {"text": "Unsafe", "language": "English"}
                ],
                "check_for_understanding": "What do you notice?",
                "pedagogical_rationale": "Fixture",
                "resume_guidance": "Continue.",
            }
        )


def test_number_line_without_optional_labels_matches_shared_schema() -> None:
    plan = TeachingTurnPlan.model_validate(
        {
            "board_actions": [
                {
                    "type": "board.draw_number_line",
                    "min": 0,
                    "max": 1,
                    "marks": [{"value": 0.5}],
                    "element_id": "halves-line",
                }
            ],
            "narration_segments": [
                {
                    "text": "One half is midway between zero and one.",
                    "language": "English",
                    "highlight_element_id": "halves-line",
                }
            ],
            "check_for_understanding": "Where would one fourth go?",
            "pedagogical_rationale": "Connect area and magnitude representations.",
            "resume_guidance": "Compare one half and three fourths.",
        }
    )

    action = plan.board_actions[0].model_dump(mode="json", exclude_none=True)
    validate_payload("board-action", action)
    assert "label" not in action["marks"][0]


@pytest.mark.asyncio
async def test_failed_interruption_does_not_strand_the_classroom(
    tmp_path: Path,
) -> None:
    board = RecordingBoard()

    class FailingClient(FakeClassroomClient):
        def execute_required_tool(self, **kwargs: Any) -> ToolRunResult:
            raise RuntimeError("fixture model outage")

    brain = TeacherBrain(
        board_dispatcher=board,
        config=HarnessConfig(
            state_directory=tmp_path / "state",
            journal_directory=tmp_path / "journals",
        ),
        client_factory=lambda _config, _journal: FailingClient(),
    )
    session = brain.start_session(
        StartClassroomRequest(
            topic="Fractions",
            objective="Represent one half.",
            students=[ClassroomStudent(name="Jordan")],
        )
    )

    with pytest.raises(RuntimeError, match="fixture model outage"):
        await brain.interrupt(
            session.session_id,
            InterruptionRequest(student="Jordan", question="Why is it one half?"),
        )

    assert brain.get_session(session.session_id).status == "active"
