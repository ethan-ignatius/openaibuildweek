from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from fastapi import WebSocket


class BoardHub:
    """Owns projector state and fans validated actions out to connected boards."""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._elements: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            snapshot = list(self._elements.values())
            await websocket.send_json({"type": "board.snapshot", "elements": snapshot})
            self._connections.add(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            self._connections.discard(websocket)

    async def apply_and_broadcast(self, action: Mapping[str, Any]) -> None:
        action_copy = dict(action)
        async with self._lock:
            self._apply(action_copy)
            connections = tuple(self._connections)

        event = {"type": "board.action", "action": action_copy}
        failed_connections: list[WebSocket] = []
        for connection in connections:
            try:
                await connection.send_json(event)
            except RuntimeError:
                failed_connections.append(connection)

        if failed_connections:
            async with self._lock:
                for connection in failed_connections:
                    self._connections.discard(connection)

    async def snapshot(self) -> list[dict[str, Any]]:
        async with self._lock:
            return list(self._elements.values())

    async def reset(self) -> None:
        async with self._lock:
            self._elements.clear()

    def _apply(self, action: dict[str, Any]) -> None:
        action_type = action["type"]

        if action_type == "board.clear":
            region = action["region"]
            if region == "all":
                self._elements.clear()
                return
            self._elements = {
                element_id: element
                for element_id, element in self._elements.items()
                if element["action"].get("region") != region
            }
            return

        if action_type in {"board.highlight", "board.unhighlight"}:
            element = self._elements.get(action["element_id"])
            if element is None:
                return
            if action_type == "board.highlight":
                element["highlight"] = action["style"]
            else:
                element.pop("highlight", None)
            return

        if action_type == "board.show_slide":
            self._elements["__active_slide__"] = {"action": action}
            return

        self._elements[action["element_id"]] = {"action": action}


board_hub = BoardHub()
