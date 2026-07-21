from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Sequence
from datetime import datetime
from pathlib import Path
from typing import Any, TextIO

from packages.harness.journal import JournalReader
from packages.shared.schema import validate_payload

BoardDispatcher = Callable[[dict[str, Any]], None]


def replay(
    journal_path: Path,
    *,
    speed: float = 0.0,
    dispatch_board: BoardDispatcher | None = None,
    output: TextIO | None = None,
    sleeper: Callable[[float], None] = time.sleep,
) -> dict[str, int | str]:
    """Validate and replay one journal in sequence order."""

    if speed < 0:
        raise ValueError("Replay speed cannot be negative")
    events = JournalReader(journal_path).read_all()
    _validate_session_order(events)
    stream = output
    board_actions = 0
    previous_timestamp: datetime | None = None

    for event in events:
        timestamp = datetime.fromisoformat(event["timestamp"])
        if speed > 0 and previous_timestamp is not None:
            delay = max(0.0, (timestamp - previous_timestamp).total_seconds()) / speed
            if delay:
                sleeper(delay)
        previous_timestamp = timestamp

        action = _board_action(event)
        if action is not None and dispatch_board is not None:
            dispatch_board(action)
            board_actions += 1
        if stream is not None:
            stream.write(json.dumps(event, ensure_ascii=True, sort_keys=True))
            stream.write("\n")

    return {
        "session_id": str(events[0]["session_id"]) if events else "",
        "events": len(events),
        "board_actions": board_actions,
    }


def http_board_dispatcher(base_url: str) -> BoardDispatcher:
    endpoint = f"{base_url.rstrip('/')}/api/board/actions"

    def dispatch(action: dict[str, Any]) -> None:
        request = urllib.request.Request(
            endpoint,
            data=json.dumps(action, ensure_ascii=True).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                if response.status != 202:
                    raise RuntimeError(
                        f"Board replay endpoint returned HTTP {response.status}"
                    )
        except (urllib.error.URLError, TimeoutError) as error:
            raise RuntimeError(
                f"Could not dispatch replay action to {endpoint}: {error}"
            ) from error

    return dispatch


def _validate_session_order(events: Sequence[dict[str, Any]]) -> None:
    if not events:
        raise ValueError("Journal is empty")
    session_ids = {event["session_id"] for event in events}
    if len(session_ids) != 1:
        raise ValueError("Journal contains multiple session IDs")
    sequences = [event.get("sequence") for event in events]
    if sequences != list(range(len(events))):
        raise ValueError("Journal sequence values must be contiguous and start at zero")


def _board_action(event: dict[str, Any]) -> dict[str, Any] | None:
    if event["event_type"] != "tool.call":
        return None
    payload = event["payload"]
    name = payload.get("name")
    arguments = payload.get("arguments")
    if not isinstance(name, str) or not name.startswith("board."):
        return None
    if not isinstance(arguments, dict):
        raise ValueError(f"Board tool call at sequence {event['sequence']} has no arguments")
    action = {"type": name, **arguments}
    validate_payload("board-action", action)
    return action


def main() -> None:
    parser = argparse.ArgumentParser(description="Deterministically replay a session journal.")
    parser.add_argument("journal", type=Path)
    parser.add_argument(
        "--speed",
        type=float,
        default=0.0,
        help="Timing multiplier; 0 replays immediately, 1 preserves wall-clock gaps.",
    )
    parser.add_argument(
        "--board-url",
        help="Dispatch recorded board tool calls to this Teacher Brain server.",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="Print only the replay summary instead of each event.",
    )
    arguments = parser.parse_args()
    dispatcher = http_board_dispatcher(arguments.board_url) if arguments.board_url else None

    import sys

    summary = replay(
        arguments.journal,
        speed=arguments.speed,
        dispatch_board=dispatcher,
        output=None if arguments.quiet else sys.stdout,
    )
    print(json.dumps(summary, ensure_ascii=True, sort_keys=True))


if __name__ == "__main__":
    main()
