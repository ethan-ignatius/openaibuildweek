from __future__ import annotations

import json
import math
import re
import threading
from collections.abc import Iterable, Iterator, Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

from packages.shared.schema import validate_payload

_SENSITIVE_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "password",
    "secret",
    "session_token",
}
_SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/-]+=*", re.IGNORECASE),
)


def redact(value: Any) -> Any:
    """Recursively redact credentials while preserving model/eval content."""

    if isinstance(value, Mapping):
        return {
            str(key): "[REDACTED]"
            if str(key).lower() in _SENSITIVE_KEYS
            else redact(item)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(item) for item in value]
    if isinstance(value, str):
        redacted = value
        for pattern in _SECRET_PATTERNS:
            redacted = pattern.sub("[REDACTED]", redacted)
        return redacted
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if hasattr(value, "model_dump"):
        return redact(value.model_dump(mode="json"))
    return repr(value)


class JournalWriter:
    """Append-only, schema-validated JSONL event writer."""

    def __init__(self, path: Path, session_id: str) -> None:
        self.path = path
        self.session_id = session_id
        self._sequence = 0
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)

    def append(
        self,
        event_type: str,
        payload: Mapping[str, Any],
        *,
        latency_ms: float | None = None,
        token_usage: Mapping[str, int] | None = None,
    ) -> dict[str, Any]:
        with self._lock:
            event: dict[str, Any] = {
                "event_id": str(uuid4()),
                "session_id": self.session_id,
                "timestamp": datetime.now(UTC).isoformat(),
                "event_type": event_type,
                "payload": redact(dict(payload)),
                "sequence": self._sequence,
            }
            if latency_ms is not None:
                event["latency_ms"] = max(0.0, latency_ms)
            if token_usage is not None:
                event["token_usage"] = {
                    "input": int(token_usage.get("input", 0)),
                    "output": int(token_usage.get("output", 0)),
                    "total": int(token_usage.get("total", 0)),
                }

            validate_payload("journal-event", event)
            with self.path.open("a", encoding="utf-8") as journal_file:
                journal_file.write(
                    json.dumps(
                        event,
                        ensure_ascii=True,
                        separators=(",", ":"),
                        allow_nan=False,
                    )
                )
                journal_file.write("\n")
                journal_file.flush()

            self._sequence += 1
            return event


class JournalReader:
    def __init__(self, path: Path) -> None:
        self.path = path

    def __iter__(self) -> Iterator[dict[str, Any]]:
        with self.path.open(encoding="utf-8") as journal_file:
            for line_number, line in enumerate(journal_file, start=1):
                if not line.strip():
                    continue
                try:
                    event: dict[str, Any] = json.loads(line)
                    validate_payload("journal-event", event)
                except (json.JSONDecodeError, ValueError) as error:
                    raise ValueError(
                        f"Invalid journal event at {self.path}:{line_number}: {error}"
                    ) from error
                yield event

    def read_all(self) -> list[dict[str, Any]]:
        return list(self)


def sum_token_usage(events: Iterable[Mapping[str, Any]]) -> dict[str, int]:
    totals = {"input": 0, "output": 0, "total": 0}
    for event in events:
        if event.get("event_type") != "model.response":
            continue
        usage = event.get("token_usage")
        if not isinstance(usage, Mapping):
            continue
        for key in totals:
            totals[key] += int(usage.get(key, 0))
    return totals
