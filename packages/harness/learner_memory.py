from __future__ import annotations

import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from packages.harness.model_client import ToolDefinition
from packages.shared.schema import validate_payload

_STUDENT_ID = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
_REQUIRED_SECTIONS = (
    "## Mastery estimates",
    "## Observed misconceptions",
    "## Language",
    "## Participation notes",
    "## Strategies that worked",
)


class LearnerMemoryError(ValueError):
    """Raised when a learner note is unsafe or structurally invalid."""


class LearnerMemory:
    def __init__(self, state_directory: Path) -> None:
        self.directory = state_directory / "learners"

    def read(self, student: str) -> str:
        path = self._path_for(student)
        if not path.exists():
            return self.empty_note(student)
        return path.read_text(encoding="utf-8")

    def write(self, student: str, markdown: str) -> Path:
        path = self._path_for(student)
        self._validate_note(student, markdown)
        validate_payload(
            "learner-model",
            {
                "student": student,
                "markdown": markdown,
                "updated_at": datetime.now(UTC).isoformat(),
            },
        )

        self.directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=self.directory,
            prefix=f".{student}.",
            suffix=".tmp",
            delete=False,
        ) as temporary_file:
            temporary_file.write(markdown.rstrip())
            temporary_file.write("\n")
            temporary_path = Path(temporary_file.name)
        os.replace(temporary_path, path)
        return path

    def write_tool(self, expected_student: str | None = None) -> ToolDefinition:
        def handler(arguments: dict[str, Any]) -> dict[str, Any]:
            student = str(arguments["student"])
            if expected_student is not None and student != expected_student:
                raise LearnerMemoryError(
                    f"Tool may only update learner {expected_student}, not {student}"
                )
            path = self.write(student, str(arguments["markdown"]))
            return {"ok": True, "student": student, "path": str(path)}

        return ToolDefinition(
            name="learner_write",
            description=(
                "Update the complete human-readable learner model for one pseudonymous "
                "student. This API-safe function name implements learner.write."
            ),
            parameters={
                "type": "object",
                "additionalProperties": False,
                "required": ["student", "markdown"],
                "properties": {
                    "student": {
                        "type": "string",
                        "pattern": _STUDENT_ID.pattern,
                    },
                    "markdown": {
                        "type": "string",
                        "minLength": 1,
                        "maxLength": 100000,
                    },
                },
            },
            handler=handler,
        )

    def read_tool(self, expected_student: str | None = None) -> ToolDefinition:
        def handler(arguments: dict[str, Any]) -> dict[str, Any]:
            student = str(arguments["student"])
            if expected_student is not None and student != expected_student:
                raise LearnerMemoryError(
                    f"Tool may only read learner {expected_student}, not {student}"
                )
            return {"student": student, "markdown": self.read(student)}

        return ToolDefinition(
            name="learner_read",
            description=(
                "Read the current human-readable learner model for one pseudonymous "
                "student. This API-safe function name implements learner.read."
            ),
            parameters={
                "type": "object",
                "additionalProperties": False,
                "required": ["student"],
                "properties": {
                    "student": {
                        "type": "string",
                        "pattern": _STUDENT_ID.pattern,
                    }
                },
            },
            handler=handler,
        )

    @staticmethod
    def empty_note(student: str) -> str:
        LearnerMemory._validate_student(student)
        return (
            f"# Learner: {student}\n\n"
            "## Mastery estimates\n\n"
            "- No observations yet.\n\n"
            "## Observed misconceptions\n\n"
            "- None observed.\n\n"
            "## Language\n\n"
            "- Not provided in this evaluation.\n\n"
            "## Participation notes\n\n"
            "- No observations yet.\n\n"
            "## Strategies that worked\n\n"
            "- No observations yet.\n"
        )

    def _path_for(self, student: str) -> Path:
        self._validate_student(student)
        return self.directory / f"{student}.md"

    @staticmethod
    def _validate_student(student: str) -> None:
        if not _STUDENT_ID.fullmatch(student):
            raise LearnerMemoryError(
                "Student identifiers must be first names or safe pseudonyms"
            )

    @staticmethod
    def _validate_note(student: str, markdown: str) -> None:
        LearnerMemory._validate_student(student)
        if not markdown.startswith(f"# Learner: {student}\n"):
            raise LearnerMemoryError("Learner note must begin with its pseudonym heading")
        missing_sections = [
            section for section in _REQUIRED_SECTIONS if section not in markdown
        ]
        if missing_sections:
            raise LearnerMemoryError(
                f"Learner note is missing sections: {', '.join(missing_sections)}"
            )
