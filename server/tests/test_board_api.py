from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from server.app.hub import board_hub
from server.app.main import app

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIRECTORY = REPOSITORY_ROOT / "packages" / "shared" / "schemas"


def test_shared_schemas_are_valid_draft_2020_12_documents() -> None:
    schema_paths = sorted(SCHEMA_DIRECTORY.glob("*.schema.json"))
    assert {path.name for path in schema_paths} == {
        "board-action.schema.json",
        "journal-event.schema.json",
        "learner-model.schema.json",
        "lecture-plan.schema.json",
    }

    for schema_path in schema_paths:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)


def test_health_and_websocket_echo() -> None:
    with TestClient(app) as client:
        assert client.get("/health").json() == {"status": "ok"}
        with client.websocket_connect("/ws") as websocket:
            websocket.send_json({"hello": "classroom"})
            assert websocket.receive_json() == {
                "type": "echo",
                "payload": {"hello": "classroom"},
            }


def test_board_action_is_validated_broadcast_and_retained() -> None:
    action = {
        "type": "board.write_math",
        "region": "center",
        "latex": r"3x + 5 = 20",
        "element_id": "m0-equation",
    }

    with TestClient(app) as client:
        client.post("/api/board/actions", json={"type": "board.clear", "region": "all"})
        with client.websocket_connect("/ws/board") as websocket:
            assert websocket.receive_json() == {"type": "board.snapshot", "elements": []}
            response = client.post("/api/board/actions", json=action)
            assert response.status_code == 202
            assert websocket.receive_json() == {"type": "board.action", "action": action}

        with client.websocket_connect("/ws/board") as late_joiner:
            assert late_joiner.receive_json() == {
                "type": "board.snapshot",
                "elements": [{"action": action}],
            }


def test_invalid_board_action_is_rejected_without_broadcast() -> None:
    invalid_action = {
        "type": "board.write_math",
        "region": "center",
        "element_id": "missing-latex",
    }

    with TestClient(app) as client:
        response = client.post("/api/board/actions", json=invalid_action)

    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "schema_validation"
