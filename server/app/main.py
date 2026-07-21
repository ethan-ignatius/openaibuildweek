from __future__ import annotations

from typing import Any

from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAIError

from packages.harness.learner_memory import LearnerMemoryError
from packages.harness.model_client import ModelClientError
from packages.harness.teacher_brain import (
    ClassroomConflictError,
    ClassroomNotFoundError,
    ClassroomSessionView,
    InterruptionRequest,
    LearnerMemoryView,
    StartClassroomRequest,
    StudentNotFoundError,
    TeachRequest,
    TeacherBrain,
    TeachingTurnResult,
)
from packages.shared.schema import SharedSchemaError, validate_payload
from server.app.hub import board_hub

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

teacher_brain_service = TeacherBrain(
    board_dispatcher=board_hub.apply_and_broadcast,
)


def get_teacher_brain_service() -> TeacherBrain:
    return teacher_brain_service


TeacherBrainDependency = Annotated[TeacherBrain, Depends(get_teacher_brain_service)]


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


@app.post(
    "/api/teacher/sessions",
    response_model=ClassroomSessionView,
    status_code=status.HTTP_201_CREATED,
)
async def start_classroom_session(
    request: StartClassroomRequest,
    brain: TeacherBrainDependency,
) -> ClassroomSessionView:
    try:
        return brain.start_session(request)
    except LearnerMemoryError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"code": "learner_memory", "message": str(error)},
        ) from error


@app.get(
    "/api/teacher/sessions/{session_id}",
    response_model=ClassroomSessionView,
)
async def get_classroom_session(
    session_id: str,
    brain: TeacherBrainDependency,
) -> ClassroomSessionView:
    try:
        return brain.get_session(session_id)
    except ClassroomNotFoundError as error:
        raise _teacher_http_error(error) from error


@app.post(
    "/api/teacher/sessions/{session_id}/teach",
    response_model=TeachingTurnResult,
)
async def teach_classroom_turn(
    session_id: str,
    request: TeachRequest,
    brain: TeacherBrainDependency,
) -> TeachingTurnResult:
    try:
        return await brain.teach(session_id, request)
    except (
        ClassroomNotFoundError,
        ClassroomConflictError,
        ModelClientError,
        OpenAIError,
        SharedSchemaError,
    ) as error:
        raise _teacher_http_error(error) from error


@app.post(
    "/api/teacher/sessions/{session_id}/interruptions",
    response_model=TeachingTurnResult,
)
async def interrupt_classroom_turn(
    session_id: str,
    request: InterruptionRequest,
    brain: TeacherBrainDependency,
) -> TeachingTurnResult:
    try:
        return await brain.interrupt(session_id, request)
    except (
        ClassroomNotFoundError,
        ClassroomConflictError,
        StudentNotFoundError,
        LearnerMemoryError,
        ModelClientError,
        OpenAIError,
        SharedSchemaError,
    ) as error:
        raise _teacher_http_error(error) from error


@app.post(
    "/api/teacher/sessions/{session_id}/end",
    response_model=ClassroomSessionView,
)
async def end_classroom_session(
    session_id: str,
    brain: TeacherBrainDependency,
) -> ClassroomSessionView:
    try:
        return await brain.end_session(session_id)
    except ClassroomNotFoundError as error:
        raise _teacher_http_error(error) from error


@app.get(
    "/api/teacher/students/{student}/memory",
    response_model=LearnerMemoryView,
)
async def get_student_memory(
    student: str,
    brain: TeacherBrainDependency,
) -> LearnerMemoryView:
    try:
        return brain.get_learner_memory(student)
    except (StudentNotFoundError, LearnerMemoryError) as error:
        raise _teacher_http_error(error) from error


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


def _teacher_http_error(error: Exception) -> HTTPException:
    if isinstance(error, (ClassroomNotFoundError, StudentNotFoundError)):
        return HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "not_found", "message": str(error)},
        )
    if isinstance(error, ClassroomConflictError):
        return HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "classroom_conflict", "message": str(error)},
        )
    if isinstance(error, (ModelClientError, OpenAIError)):
        return HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail={"code": "teacher_model_failure", "message": str(error)},
        )
    if isinstance(error, SharedSchemaError):
        return HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={
                "code": "schema_validation",
                "schema": error.schema_name,
                "message": error.message,
                "path": error.path,
            },
        )
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={"code": "teacher_brain", "message": str(error)},
    )
