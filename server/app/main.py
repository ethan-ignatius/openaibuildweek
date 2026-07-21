from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware

from server.app.hub import board_hub
from packages.shared.schema import SharedSchemaError, validate_payload

app = FastAPI(
    title="Teacher Brain API",
    version="0.1.0",
    description="Classroom state and WebSocket hub for Teacher Brain.",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/board/actions", status_code=status.HTTP_202_ACCEPTED)
async def post_board_action(action: dict[str, Any]) -> dict[str, Any]:
    try:
        validate_payload("board-action", action)
    except SharedSchemaError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "schema_validation",
                "schema": error.schema_name,
                "message": error.message,
                "path": error.path,
            },
        ) from error

    await board_hub.apply_and_broadcast(action)
    return {"accepted": True, "action": action}


@app.get("/api/board/state")
async def get_board_state() -> dict[str, Any]:
    return {"elements": await board_hub.snapshot()}


@app.websocket("/ws")
async def websocket_echo(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            payload = await websocket.receive_json()
            await websocket.send_json({"type": "echo", "payload": payload})
    except WebSocketDisconnect:
        return


@app.websocket("/ws/board")
async def websocket_board(websocket: WebSocket) -> None:
    await board_hub.connect(websocket)
    try:
        while True:
            payload = await websocket.receive_json()
            await websocket.send_json({"type": "echo", "payload": payload})
    except WebSocketDisconnect:
        await board_hub.disconnect(websocket)
