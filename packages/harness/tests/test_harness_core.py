from __future__ import annotations

import json
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from openai import APIConnectionError
from pydantic import BaseModel, ConfigDict

from packages.harness.config import HarnessConfig, MemoryMode
from packages.harness.journal import JournalReader, JournalWriter, sum_token_usage
from packages.harness.learner_memory import LearnerMemory, LearnerMemoryError
from packages.harness.model_client import OpenAIModelClient, ToolDefinition
from packages.shared.schema import SharedSchemaError, validate_payload
from scripts.replay import replay


class FixtureResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")
    value: int


class FakeAPIResponse:
    def __init__(
        self,
        *,
        response_id: str,
        output: list[Any] | None = None,
        parsed: BaseModel | None = None,
        input_tokens: int = 2,
        output_tokens: int = 1,
    ) -> None:
        self.id = response_id
        self.output = output or []
        self.output_parsed = parsed
        self.usage = SimpleNamespace(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        )

    def model_dump(self, **_: object) -> dict[str, object]:
        return {"id": self.id, "output": [], "usage": {"total_tokens": self.usage.total_tokens}}


class FakeResponses:
    def create(self, **_: object) -> FakeAPIResponse:
        function_call = SimpleNamespace(
            type="function_call",
            name="fixture_tool",
            arguments=json.dumps({"value": 7}),
            call_id="call-1",
        )
        return FakeAPIResponse(response_id="tool-response", output=[function_call])

    def parse(self, **_: object) -> FakeAPIResponse:
        return FakeAPIResponse(
            response_id="parsed-response",
            parsed=FixtureResponse(value=11),
            input_tokens=4,
            output_tokens=2,
        )


class FakeOpenAI:
    def __init__(self) -> None:
        self.responses = FakeResponses()

    def with_options(self, **_: object) -> "FakeOpenAI":
        return self


class FlakyResponses(FakeResponses):
    def __init__(self) -> None:
        self.parse_calls = 0

    def parse(self, **kwargs: object) -> FakeAPIResponse:
        self.parse_calls += 1
        if self.parse_calls < 3:
            raise APIConnectionError(
                request=httpx.Request("POST", "https://api.openai.com/v1/responses")
            )
        return super().parse(**kwargs)


class FlakyOpenAI(FakeOpenAI):
    def __init__(self) -> None:
        self.responses = FlakyResponses()
        self.timeouts: list[float] = []

    def with_options(self, **kwargs: object) -> "FlakyOpenAI":
        self.timeouts.append(float(kwargs["timeout"]))
        return self


def test_shared_registry_resolves_lecture_plan_board_action_reference() -> None:
    plan = {
        "id": "lesson-1",
        "title": "Linear equations",
        "source_ref": "teacher-deck.pdf#page=2",
        "beats": [
            {
                "id": "beat-1",
                "objective": "Isolate x",
                "board_actions": [
                    {
                        "type": "board.write_math",
                        "region": "center",
                        "latex": "3x=12",
                        "element_id": "equation-1",
                    }
                ],
                "narration_segments": [{"text": "Divide by three.", "language": "en"}],
            }
        ],
    }
    validate_payload("lecture-plan", plan)
    plan["beats"][0]["board_actions"][0]["region"] = "invalid"
    with pytest.raises(SharedSchemaError):
        validate_payload("lecture-plan", plan)


def test_journal_redacts_credentials_validates_and_counts_model_tokens(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    journal = JournalWriter(path, "fixture-session")
    journal.append("session.started", {"api_key": "sk-abcdefghijklmnop"})
    journal.append(
        "model.response",
        {"authorization": "Bearer private-token-value", "answer": "ok"},
        token_usage={"input": 8, "output": 3, "total": 11},
    )
    journal.append(
        "eval.prediction",
        {"probability": 0.5},
        token_usage={"input": 8, "output": 3, "total": 11},
    )

    events = JournalReader(path).read_all()
    assert events[0]["payload"]["api_key"] == "[REDACTED]"
    assert events[1]["payload"]["authorization"] == "[REDACTED]"
    assert [event["sequence"] for event in events] == [0, 1, 2]
    assert sum_token_usage(events) == {"input": 8, "output": 3, "total": 11}

    resumed = JournalWriter(path, "fixture-session", resume=True)
    resumed.append("session.resumed", {"prior_events": 3})
    resumed_events = JournalReader(path).read_all()
    assert resumed_events[-1]["sequence"] == 3


def test_learner_memory_enforces_pseudonym_and_required_sections(tmp_path: Path) -> None:
    memory = LearnerMemory(tmp_path)
    note = memory.empty_note("Student_A")
    path = memory.write("Student_A", note)
    assert path.read_text(encoding="utf-8") == note
    assert memory.read("Student_A") == note

    with pytest.raises(LearnerMemoryError, match="first names or safe pseudonyms"):
        memory.read("../private")
    with pytest.raises(LearnerMemoryError, match="missing sections"):
        memory.write("Student_A", "# Learner: Student_A\n")

    limited_tool = memory.write_tool(
        expected_student="Student_A",
        maximum_markdown_length=10,
    )
    with pytest.raises(LearnerMemoryError, match="maximum length"):
        limited_tool.handler({"student": "Student_A", "markdown": note})


def test_harness_ablation_config_rejects_notes_without_tools() -> None:
    with pytest.raises(ValueError, match="requires tool_surface"):
        HarnessConfig(tool_surface=False, memory_mode=MemoryMode.NOTES)
    assert HarnessConfig(tool_surface=False, memory_mode=MemoryMode.NONE)


def test_model_client_executes_required_tool_then_parses_structured_output(
    tmp_path: Path,
) -> None:
    handled: list[int] = []
    tool = ToolDefinition(
        name="fixture_tool",
        description="Store one fixture integer.",
        parameters={
            "type": "object",
            "additionalProperties": False,
            "required": ["value"],
            "properties": {"value": {"type": "integer"}},
        },
        handler=lambda arguments: handled.append(arguments["value"]) or {"ok": True},
    )
    journal_path = tmp_path / "model-client.jsonl"
    journal = JournalWriter(journal_path, "model-client-test")
    client = OpenAIModelClient(
        HarnessConfig(),
        client=FakeOpenAI(),  # type: ignore[arg-type]
        journal=journal,
    )

    result = client.generate_with_required_tool(
        system_prompt="Use the tool.",
        user_prompt="Store seven, then return a fixture response.",
        tool=tool,
        response_model=FixtureResponse,
    )

    assert handled == [7]
    assert result.parsed == FixtureResponse(value=11)
    assert result.usage.as_dict() == {"input": 6, "output": 3, "total": 9}
    events = JournalReader(journal_path).read_all()
    assert [event["event_type"] for event in events].count("model.request") == 2
    assert [event["event_type"] for event in events].count("model.response") == 2


def test_model_client_reserves_timeout_budget_for_retries(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("packages.harness.model_client.time.sleep", lambda _: None)
    api = FlakyOpenAI()
    client = OpenAIModelClient(
        HarnessConfig(model_timeout_seconds=9, model_max_attempts=3),
        client=api,  # type: ignore[arg-type]
    )

    result = client.generate_structured(
        system_prompt="Return the fixture.",
        user_prompt="Retry transient connection failures.",
        response_model=FixtureResponse,
    )

    assert result.parsed == FixtureResponse(value=11)
    assert api.responses.parse_calls == 3
    assert len(api.timeouts) == 3
    assert api.timeouts[0] == pytest.approx(4.5, rel=0.05)
    assert all(0 < timeout <= 9 for timeout in api.timeouts)


def test_replay_validates_order_and_dispatches_board_actions(tmp_path: Path) -> None:
    path = tmp_path / "session.jsonl"
    journal = JournalWriter(path, "replay-session")
    journal.append("session.started", {"lesson": "fixture"})
    journal.append(
        "tool.call",
        {
            "name": "board.write_math",
            "arguments": {
                "region": "center",
                "latex": "x=4",
                "element_id": "answer",
            },
        },
    )
    journal.append("session.ended", {"status": "complete"})
    actions: list[dict[str, object]] = []
    output = StringIO()

    summary = replay(
        path,
        dispatch_board=actions.append,
        output=output,
    )

    assert summary == {
        "session_id": "replay-session",
        "events": 3,
        "board_actions": 1,
    }
    assert actions == [
        {
            "type": "board.write_math",
            "region": "center",
            "latex": "x=4",
            "element_id": "answer",
        }
    ]
    assert len(output.getvalue().splitlines()) == 3
