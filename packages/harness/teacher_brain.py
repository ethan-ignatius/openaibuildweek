from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any, Literal, Protocol, TypeAlias
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from packages.harness.config import HarnessConfig
from packages.harness.journal import JournalWriter
from packages.harness.learner_memory import LearnerMemory, LearnerMemoryError
from packages.harness.model_client import (
    ModelClientError,
    ModelResult,
    OpenAIModelClient,
    StructuredModelClient,
    TokenUsage,
)
from packages.shared.schema import validate_payload

BoardRegion: TypeAlias = Literal[
    "top", "left", "center", "right", "bottom", "scratch"
]
HighlightStyle: TypeAlias = Literal["pulse", "outline", "fill"]
SessionStatus: TypeAlias = Literal["active", "interrupted", "ended"]
TurnKind: TypeAlias = Literal["instruction", "interruption"]

_ELEMENT_ID = r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$"
_STUDENT_ID = r"^[A-Za-z][A-Za-z0-9_-]{0,63}$"


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class WriteTextAction(StrictModel):
    type: Literal["board.write_text"]
    region: BoardRegion
    text: str = Field(min_length=1, max_length=10000)
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)


class WriteMathAction(StrictModel):
    type: Literal["board.write_math"]
    region: BoardRegion
    latex: str = Field(min_length=1, max_length=10000)
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)


class PlotFunctionAction(StrictModel):
    type: Literal["board.plot_function"]
    expr: str = Field(min_length=1, max_length=1000)
    domain: tuple[float, float]
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)


class NumberLineMark(StrictModel):
    value: float
    label: str | None = Field(default=None, max_length=100)


class DrawNumberLineAction(StrictModel):
    type: Literal["board.draw_number_line"]
    min: float
    max: float
    marks: list[NumberLineMark] = Field(max_length=100)
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)

    @model_validator(mode="after")
    def validate_range(self) -> "DrawNumberLineAction":
        if self.max <= self.min:
            raise ValueError("A number line requires max greater than min")
        if any(mark.value < self.min or mark.value > self.max for mark in self.marks):
            raise ValueError("Number-line marks must be within the displayed range")
        return self


class DrawFractionBarsAction(StrictModel):
    type: Literal["board.draw_fraction_bars"]
    fractions: list[str] = Field(min_length=1, max_length=20)
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)

    @model_validator(mode="after")
    def validate_fractions(self) -> "DrawFractionBarsAction":
        for fraction in self.fractions:
            parts = fraction.split("/")
            if len(parts) != 2 or not all(part.isdigit() for part in parts):
                raise ValueError("Fraction bars require non-negative integer a/b values")
            numerator, denominator = map(int, parts)
            if denominator < 1 or denominator > 100:
                raise ValueError("Fraction-bar denominators must be between 1 and 100")
            if numerator > denominator:
                raise ValueError("Fraction bars represent values between zero and one")
        return self


class RenderCustomAction(StrictModel):
    type: Literal["board.render_custom"]
    svg: str = Field(min_length=1, max_length=100000)
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)


class HighlightAction(StrictModel):
    type: Literal["board.highlight"]
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)
    style: HighlightStyle


class UnhighlightAction(StrictModel):
    type: Literal["board.unhighlight"]
    element_id: str = Field(min_length=1, max_length=128, pattern=_ELEMENT_ID)


class ClearAction(StrictModel):
    type: Literal["board.clear"]
    region: BoardRegion | Literal["all"]


class ShowSlideAction(StrictModel):
    type: Literal["board.show_slide"]
    slide_ref: str = Field(min_length=1, max_length=2048)


BoardAction = Annotated[
    WriteTextAction
    | WriteMathAction
    | PlotFunctionAction
    | DrawNumberLineAction
    | DrawFractionBarsAction
    | RenderCustomAction
    | HighlightAction
    | UnhighlightAction
    | ClearAction
    | ShowSlideAction,
    Field(discriminator="type"),
]


class NarrationSegment(StrictModel):
    text: str = Field(min_length=1, max_length=10000)
    language: str = Field(min_length=2, max_length=35)
    highlight_element_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=_ELEMENT_ID,
    )


class TeachingTurnPlan(StrictModel):
    """Strict model output: speech plus the board actions that embody it."""

    board_actions: list[BoardAction] = Field(min_length=1, max_length=24)
    narration_segments: list[NarrationSegment] = Field(min_length=1, max_length=24)
    check_for_understanding: str = Field(min_length=1, max_length=2000)
    pedagogical_rationale: str = Field(min_length=1, max_length=2400)
    resume_guidance: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def validate_highlight_references(self) -> "TeachingTurnPlan":
        introduced: set[str] = set()
        cleared = False
        seen_rendered_action = False
        for action in self.board_actions:
            if isinstance(action, ClearAction):
                if seen_rendered_action:
                    raise ValueError(
                        "Board clears must precede the visuals rebuilt by a teaching turn"
                    )
                cleared = True
                continue
            if isinstance(action, (HighlightAction, UnhighlightAction)):
                if cleared and action.element_id not in introduced:
                    raise ValueError(
                        "After a board clear, highlight actions must follow the element "
                        f"they target: {action.element_id}"
                    )
                continue
            seen_rendered_action = True
            if isinstance(action, ShowSlideAction):
                introduced.add("active-slide")
            elif hasattr(action, "element_id"):
                introduced.add(action.element_id)
        highlighted = {
            segment.highlight_element_id
            for segment in self.narration_segments
            if segment.highlight_element_id is not None
        }
        missing = highlighted - introduced
        if missing and cleared:
            raise ValueError(
                "Narration after a board clear may only highlight elements introduced "
                f"by this turn: {', '.join(sorted(missing))}"
            )
        return self


class ClassroomStudent(StrictModel):
    name: str = Field(min_length=1, max_length=64, pattern=_STUDENT_ID)
    language: str = Field(
        default="English",
        min_length=2,
        max_length=35,
        pattern=r"^[^\r\n]+$",
    )


class StartClassroomRequest(StrictModel):
    topic: str = Field(min_length=1, max_length=500)
    objective: str = Field(min_length=1, max_length=2000)
    source_material: str | None = Field(default=None, max_length=50000)
    source_ref: str | None = Field(default=None, max_length=2048)
    students: list[ClassroomStudent] = Field(default_factory=list, max_length=60)

    @model_validator(mode="after")
    def reject_duplicate_students(self) -> "StartClassroomRequest":
        names = [student.name for student in self.students]
        if len(names) != len(set(names)):
            raise ValueError("Student names must be unique within a classroom")
        return self


class TeachRequest(StrictModel):
    instruction: str = Field(
        default="Begin or continue the lesson from the current teaching state.",
        min_length=1,
        max_length=5000,
    )


class InterruptionRequest(StrictModel):
    student: str = Field(min_length=1, max_length=64, pattern=_STUDENT_ID)
    question: str = Field(min_length=1, max_length=5000)
    language: str | None = Field(
        default=None,
        min_length=2,
        max_length=35,
        pattern=r"^[^\r\n]+$",
    )


class ClassroomSessionView(StrictModel):
    session_id: str
    topic: str
    objective: str
    source_ref: str | None
    students: list[ClassroomStudent]
    status: SessionStatus
    turn_index: int
    resume_guidance: str | None
    created_at: str


class TeachingTurnResult(StrictModel):
    session_id: str
    turn_index: int
    kind: TurnKind
    student: str | None = None
    plan: TeachingTurnPlan
    token_usage: dict[str, int]
    latency_ms: float


class LearnerMemoryView(StrictModel):
    student: str
    markdown: str


class ParticipationRecommendation(StrictModel):
    student: str
    reason: Literal[
        "has_not_spoken",
        "least_recent_participation",
        "concept_support",
    ]
    evidence: str
    participation_count: int


class TeacherBrainError(RuntimeError):
    """Base error for classroom orchestration failures."""


class ClassroomNotFoundError(TeacherBrainError):
    pass


class ClassroomConflictError(TeacherBrainError):
    pass


class StudentNotFoundError(TeacherBrainError):
    pass


class BoardDispatcher(Protocol):
    async def __call__(self, action: Mapping[str, Any]) -> None: ...


ModelClientFactory = Callable[
    [HarnessConfig, JournalWriter | None], StructuredModelClient
]


@dataclass
class _ClassroomSession:
    session_id: str
    topic: str
    objective: str
    source_material: str | None
    source_ref: str | None
    students: dict[str, ClassroomStudent]
    journal: JournalWriter | None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    status: SessionStatus = "active"
    turn_index: int = 0
    resume_guidance: str | None = None
    recent_turns: list[dict[str, Any]] = field(default_factory=list)
    participation_counts: dict[str, int] = field(default_factory=dict)
    last_participation_turn: dict[str, int] = field(default_factory=dict)
    client: StructuredModelClient | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def view(self) -> ClassroomSessionView:
        return ClassroomSessionView(
            session_id=self.session_id,
            topic=self.topic,
            objective=self.objective,
            source_ref=self.source_ref,
            students=list(self.students.values()),
            status=self.status,
            turn_index=self.turn_index,
            resume_guidance=self.resume_guidance,
            created_at=self.created_at.isoformat(),
        )


def _openai_client_factory(
    config: HarnessConfig,
    journal: JournalWriter | None,
) -> StructuredModelClient:
    return OpenAIModelClient(config, journal=journal)


class TeacherBrain:
    """Learner-aware classroom agent with a validated smartboard action surface."""

    def __init__(
        self,
        *,
        board_dispatcher: BoardDispatcher,
        config: HarnessConfig | None = None,
        memory: LearnerMemory | None = None,
        client_factory: ModelClientFactory = _openai_client_factory,
    ) -> None:
        self.config = config or HarnessConfig.from_environment()
        self.memory = memory or LearnerMemory(self.config.state_directory)
        self.board_dispatcher = board_dispatcher
        self.client_factory = client_factory
        self._sessions: dict[str, _ClassroomSession] = {}

    def start_session(self, request: StartClassroomRequest) -> ClassroomSessionView:
        session_id = f"classroom-{uuid4().hex[:16]}"
        journal = self._journal(session_id)
        students = {student.name: student for student in request.students}
        for student in request.students:
            self._initialize_learner(student)
        session = _ClassroomSession(
            session_id=session_id,
            topic=request.topic,
            objective=request.objective,
            source_material=request.source_material,
            source_ref=request.source_ref,
            students=students,
            journal=journal,
            participation_counts={student: 0 for student in students},
            last_participation_turn={student: -1 for student in students},
        )
        self._sessions[session_id] = session
        if journal:
            journal.append(
                "session.started",
                {
                    "kind": "classroom",
                    "topic": request.topic,
                    "objective": request.objective,
                    "source_ref": request.source_ref,
                    "students": [student.name for student in request.students],
                },
            )
        return session.view()

    def get_session(self, session_id: str) -> ClassroomSessionView:
        return self._session(session_id).view()

    def get_learner_memory(self, student: str) -> LearnerMemoryView:
        try:
            markdown = self.memory.read(student)
        except LearnerMemoryError as error:
            raise StudentNotFoundError(str(error)) from error
        if not (self.memory.directory / f"{student}.md").is_file():
            raise StudentNotFoundError(f"No learner memory exists for: {student}")
        return LearnerMemoryView(student=student, markdown=markdown)

    async def teach(
        self,
        session_id: str,
        request: TeachRequest,
    ) -> TeachingTurnResult:
        session = self._session(session_id)
        async with session.lock:
            self._require_active(session)
            result = await self._generate_turn(
                session,
                kind="instruction",
                user_prompt=self._instruction_prompt(session, request),
            )
            return await self._commit_turn(session, "instruction", result)

    async def interrupt(
        self,
        session_id: str,
        request: InterruptionRequest,
    ) -> TeachingTurnResult:
        session = self._session(session_id)
        async with session.lock:
            self._require_active(session)
            student = session.students.get(request.student)
            if student is None:
                raise StudentNotFoundError(
                    f"Student {request.student} is not enrolled in {session_id}"
                )
            language = request.language or student.language
            session.status = "interrupted"
            if session.journal:
                session.journal.append(
                    "session.interrupted",
                    {
                        "student": request.student,
                        "question": request.question,
                        "language": language,
                        "turn_index": session.turn_index,
                    },
                )
                session.journal.append(
                    "voice.transcript",
                    {
                        "speaker": request.student,
                        "text": request.question,
                        "language": language,
                    },
                )

            try:
                await self._update_learner_memory(session, request, language)
                interruption_prompt = self._interruption_prompt(
                    session, request, language
                )
                result = await self._generate_turn(
                    session,
                    kind="interruption",
                    user_prompt=interruption_prompt,
                )
                try:
                    self._validate_interruption_plan(result.parsed, language)
                except ModelClientError as first_error:
                    corrected = await self._generate_turn(
                        session,
                        kind="interruption",
                        user_prompt=(
                            interruption_prompt
                            + "\n\nThe prior candidate failed this mandatory delivery "
                            f"contract: {first_error}. Produce one corrected plan now."
                        ),
                    )
                    self._validate_interruption_plan(corrected.parsed, language)
                    result = ModelResult(
                        parsed=corrected.parsed,
                        usage=result.usage + corrected.usage,
                        latency_ms=result.latency_ms + corrected.latency_ms,
                        response_id=corrected.response_id,
                    )
                committed = await self._commit_turn(
                    session,
                    "interruption",
                    result,
                    student=request.student,
                )
                session.participation_counts[request.student] += 1
                session.last_participation_turn[request.student] = committed.turn_index
            except Exception as error:
                session.status = "active"
                if session.journal:
                    session.journal.append(
                        "session.resumed",
                        {
                            "student": request.student,
                            "turn_index": session.turn_index,
                            "recovery": "interruption_failed",
                            "error_type": type(error).__name__,
                        },
                    )
                raise
            session.status = "active"
            if session.journal:
                session.journal.append(
                    "session.resumed",
                    {
                        "student": request.student,
                        "turn_index": session.turn_index,
                        "resume_guidance": session.resume_guidance,
                    },
                )
            return committed

    async def recommend_student(
        self,
        session_id: str,
        *,
        concept: str | None = None,
    ) -> ParticipationRecommendation:
        session = self._session(session_id)
        async with session.lock:
            self._require_active(session)
            if not session.students:
                raise StudentNotFoundError(
                    f"No students are enrolled in {session_id}"
                )
            if concept is not None and len(concept) > 200:
                raise TeacherBrainError("Participation concept must be 200 characters or fewer")

            normalized_concept = (concept or "").strip().casefold()
            concept_candidates: list[str] = []
            if normalized_concept:
                for student in session.students:
                    misconception_evidence = _markdown_section(
                        self.memory.read(student),
                        "## Observed misconceptions",
                    ).casefold()
                    if (
                        normalized_concept in misconception_evidence
                        and "none observed" not in misconception_evidence
                    ):
                        concept_candidates.append(student)

            candidates = concept_candidates or list(session.students)
            student = min(
                candidates,
                key=lambda name: (
                    session.participation_counts[name],
                    session.last_participation_turn[name],
                    list(session.students).index(name),
                ),
            )
            count = session.participation_counts[student]
            if concept_candidates:
                reason = "concept_support"
                evidence = (
                    f"The private learner note contains observed evidence related to "
                    f"'{concept}'. Use a low-stakes check without publicly labeling the learner."
                )
            elif count == 0:
                reason = "has_not_spoken"
                evidence = (
                    "This enrolled student has no recorded participation in the current "
                    "session. Invite, but do not require, a response."
                )
            else:
                reason = "least_recent_participation"
                evidence = (
                    "This student has participated least often or least recently in the "
                    "current session. Invite, but do not require, a response."
                )
            recommendation = ParticipationRecommendation(
                student=student,
                reason=reason,
                evidence=evidence,
                participation_count=count,
            )
            if session.journal:
                session.journal.append(
                    "participation.recommended",
                    {
                        "student": recommendation.student,
                        "reason": recommendation.reason,
                        "concept": concept,
                        "participation_count": count,
                    },
                )
            return recommendation

    async def end_session(self, session_id: str) -> ClassroomSessionView:
        session = self._session(session_id)
        async with session.lock:
            if session.status == "ended":
                return session.view()
            session.status = "ended"
            if session.journal:
                session.journal.append(
                    "session.ended",
                    {
                        "status": "complete",
                        "kind": "classroom",
                        "turns": session.turn_index,
                    },
                )
            return session.view()

    async def _update_learner_memory(
        self,
        session: _ClassroomSession,
        request: InterruptionRequest,
        language: str,
    ) -> None:
        current_note = self.memory.read(request.student)
        client = self._client(session)
        await asyncio.to_thread(
            client.execute_required_tool,
            system_prompt=(
                "Maintain a concise, evidence-based learner note for a real classroom. "
                f"You must call learner_write exactly once for {request.student}. "
                "Preserve every required Markdown section. Record the student's exact "
                "question as participation evidence and update mastery or misconceptions "
                "only when the wording supports it. Never infer demographics, emotion, "
                "confusion, disability, age, or background. Preserve useful evidence from "
                "the existing note."
            ),
            user_prompt=(
                f"Declared response language: {language}\n"
                f"Current lesson topic: {session.topic}\n"
                f"Current objective: {session.objective}\n"
                f"Student question: {request.question}\n\n"
                f"Existing learner note:\n{current_note}\n\n"
                "Write the complete replacement note now."
            ),
            tool=self.memory.write_tool(expected_student=request.student),
            metadata={
                "surface": "classroom",
                "session_id": session.session_id,
                "student": request.student,
                "task": "learner_memory",
            },
        )

    async def _generate_turn(
        self,
        session: _ClassroomSession,
        *,
        kind: TurnKind,
        user_prompt: str,
    ) -> Any:
        client = self._client(session)
        return await asyncio.to_thread(
            client.generate_structured,
            system_prompt=self._teaching_system_prompt(kind),
            user_prompt=user_prompt,
            response_model=TeachingTurnPlan,
            metadata={
                "surface": "classroom",
                "session_id": session.session_id,
                "task": kind,
            },
        )

    async def _commit_turn(
        self,
        session: _ClassroomSession,
        kind: TurnKind,
        model_result: Any,
        *,
        student: str | None = None,
    ) -> TeachingTurnResult:
        plan: TeachingTurnPlan = model_result.parsed
        actions = [
            action.model_dump(mode="json", exclude_none=True)
            for action in plan.board_actions
        ]
        for action in actions:
            validate_payload("board-action", action)
            if session.journal:
                session.journal.append(
                    "tool.call",
                    {"name": action["type"], "arguments": _without_type(action)},
                )
            try:
                await self.board_dispatcher(action)
            except Exception as error:
                if session.journal:
                    session.journal.append(
                        "tool.result",
                        {"name": action["type"], "ok": False, "error": str(error)},
                    )
                raise
            if session.journal:
                session.journal.append(
                    "tool.result",
                    {"name": action["type"], "ok": True},
                )

        session.turn_index += 1
        session.resume_guidance = plan.resume_guidance
        session.recent_turns.append(
            {
                "turn_index": session.turn_index,
                "kind": kind,
                "student": student,
                "check_for_understanding": plan.check_for_understanding,
                "resume_guidance": plan.resume_guidance,
            }
        )
        session.recent_turns = session.recent_turns[-12:]
        if session.journal:
            session.journal.append(
                "plan.revision",
                {
                    "kind": kind,
                    "student": student,
                    "turn_index": session.turn_index,
                    "check_for_understanding": plan.check_for_understanding,
                    "resume_guidance": plan.resume_guidance,
                },
                latency_ms=model_result.latency_ms,
            )
        usage: TokenUsage = model_result.usage
        return TeachingTurnResult(
            session_id=session.session_id,
            turn_index=session.turn_index,
            kind=kind,
            student=student,
            plan=plan,
            token_usage=usage.as_dict(),
            latency_ms=model_result.latency_ms,
        )

    def _instruction_prompt(
        self,
        session: _ClassroomSession,
        request: TeachRequest,
    ) -> str:
        return (
            self._lesson_context(session)
            + "\n\nTeacher/operator instruction:\n"
            + request.instruction
            + "\n\nCreate the next short, coherent teaching turn. Use the board as a "
            "worked visual explanation, keep narration synchronized with highlights, "
            "and finish with one accessible check for understanding."
        )

    def _interruption_prompt(
        self,
        session: _ClassroomSession,
        request: InterruptionRequest,
        language: str,
    ) -> str:
        note = self.memory.read(request.student)
        return (
            self._lesson_context(session)
            + f"\n\nA student interrupted the lesson.\nStudent: {request.student}"
            + f"\nDeclared response language: {language}"
            + f"\nQuestion: {request.question}"
            + f"\n\nPersistent learner note:\n{note}"
            + "\n\nPause the prior explanation and answer the actual question first. "
            "Use a focusing or Socratic move where appropriate, but do not evade a direct "
            "answer. Correct mathematical or factual errors explicitly and kindly. You may "
            "Begin with board.clear for the entire board, then rebuild every visual you "
            "reference so the interrupted explanation cannot remain on screen. Respond in "
            "the declared language and ask one check-for-understanding question. If the "
            "declared language is Spanish, put the Spanish explanation first, then add one "
            "brief English narration segment so the whole class can follow; label those "
            "segments Spanish and English exactly. Finish by stating exactly how to "
            "reconnect to the interrupted lesson."
        )

    @staticmethod
    def _validate_interruption_plan(
        plan: TeachingTurnPlan,
        language: str,
    ) -> None:
        first_action = plan.board_actions[0]
        if not isinstance(first_action, ClearAction) or first_action.region != "all":
            raise ModelClientError(
                "An interruption plan must begin by clearing the entire board"
            )
        if _is_spanish(language):
            narration_languages = [
                segment.language.strip().casefold()
                for segment in plan.narration_segments
            ]
            spanish_positions = [
                index
                for index, value in enumerate(narration_languages)
                if value == "es" or value.startswith("es-") or "spanish" in value
            ]
            english_positions = [
                index
                for index, value in enumerate(narration_languages)
                if value == "en" or value.startswith("en-") or "english" in value
            ]
            if (
                not spanish_positions
                or not english_positions
                or spanish_positions[0] > english_positions[0]
            ):
                raise ModelClientError(
                    "A Spanish interruption must narrate in Spanish first and include "
                    "a brief English recap"
                )

    def _lesson_context(self, session: _ClassroomSession) -> str:
        source = session.source_material or "No teacher-authored source text was supplied."
        learner_context = self._learner_context(session)
        recent = json.dumps(
            session.recent_turns,
            ensure_ascii=True,
            separators=(",", ":"),
        )
        return (
            f"Lesson topic: {session.topic}\n"
            f"Learning objective: {session.objective}\n"
            f"Source reference: {session.source_ref or 'not provided'}\n"
            f"Teacher-authored source material:\n{source}\n\n"
            f"Learner context (first names or pseudonyms only):\n{learner_context}\n\n"
            f"Recent teaching-state summaries: {recent}\n"
            f"Current resume guidance: {session.resume_guidance or 'Start the lesson.'}"
        )

    @staticmethod
    def _teaching_system_prompt(kind: TurnKind) -> str:
        return (
            "You are Teacher Brain, an embodied classroom teaching agent. Produce one "
            f"{kind} turn as strict structured output. Your board_actions are your hands: "
            "write only instructionally useful text or math, use concrete representations "
            "before abstraction, keep element IDs stable, and highlight an element only "
            "while narrating it. board.clear can wipe one region or the entire board. "
            "Use render_custom only for simple self-contained SVG diagrams with no scripts, "
            "external resources, or foreignObject. Avoid decorative clutter.\n\n"
            "Pedagogy policy: preserve the teacher's objective and source material; explain "
            "one conceptual step at a time; distinguish observed evidence from hypotheses; "
            "surface and repair a misconception without shaming; use focusing questions "
            "instead of funneling; provide a direct answer when one is needed; never infer "
            "demographics, emotion, confusion, disability, or background; and always include "
            "a brief check for understanding. The pedagogical_rationale is for the operator "
            "and must not claim guarantees about learning. Narration must contain the words "
            "the agent should actually say."
        )

    def _initialize_learner(self, student: ClassroomStudent) -> None:
        current = self.memory.read(student.name)
        language_header = "## Language\n\n"
        next_header = "\n\n## Participation notes"
        before, separator, remainder = current.partition(language_header)
        language_body, next_separator, after = remainder.partition(next_header)
        if not separator or not next_separator:
            raise LearnerMemoryError("Learner note has an invalid Language section")
        replacement = f"- Declared classroom language: {student.language}."
        if language_body.strip() == replacement:
            return
        initialized = (
            before
            + language_header
            + replacement
            + next_separator
            + after
        )
        self.memory.write(student.name, initialized)

    def _learner_context(self, session: _ClassroomSession) -> str:
        if not session.students:
            return "No enrolled learner notes are available."
        remaining = 30000
        notes: list[str] = []
        for student in session.students:
            note = self.memory.read(student)
            excerpt = note[: min(4000, remaining)]
            if len(excerpt) < len(note):
                excerpt += "\n[learner note truncated for this teaching turn]"
            notes.append(excerpt)
            remaining -= len(excerpt)
            if remaining <= 0:
                notes.append("[additional learner notes omitted from this teaching turn]")
                break
        return "\n\n".join(notes)

    def _journal(self, session_id: str) -> JournalWriter | None:
        if not self.config.journaling:
            return None
        path = self.config.journal_directory / "classrooms" / f"{session_id}.jsonl"
        return JournalWriter(path, session_id)

    def _client(self, session: _ClassroomSession) -> StructuredModelClient:
        if session.client is None:
            session.client = self.client_factory(self.config, session.journal)
        return session.client

    def _session(self, session_id: str) -> _ClassroomSession:
        session = self._sessions.get(session_id)
        if session is None:
            raise ClassroomNotFoundError(f"Classroom session not found: {session_id}")
        return session

    @staticmethod
    def _require_active(session: _ClassroomSession) -> None:
        if session.status == "ended":
            raise ClassroomConflictError(
                f"Classroom session has already ended: {session.session_id}"
            )
        if session.status == "interrupted":
            raise ClassroomConflictError(
                f"Classroom session is already handling an interruption: {session.session_id}"
            )


def _without_type(action: Mapping[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in action.items() if key != "type"}


def _is_spanish(language: str) -> bool:
    normalized = language.strip().casefold()
    return normalized == "es" or normalized.startswith("es-") or "spanish" in normalized


def _markdown_section(markdown: str, heading: str) -> str:
    _, separator, remainder = markdown.partition(f"{heading}\n")
    if not separator:
        return ""
    return remainder.split("\n## ", 1)[0].strip()


__all__ = [
    "BoardAction",
    "ClassroomConflictError",
    "ClassroomNotFoundError",
    "ClassroomSessionView",
    "ClassroomStudent",
    "InterruptionRequest",
    "LearnerMemoryView",
    "ParticipationRecommendation",
    "StartClassroomRequest",
    "StudentNotFoundError",
    "TeachRequest",
    "TeacherBrain",
    "TeacherBrainError",
    "TeachingTurnPlan",
    "TeachingTurnResult",
]
