from __future__ import annotations

import os
from enum import StrEnum
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, model_validator


class MemoryMode(StrEnum):
    NOTES = "notes"
    FULL_CONTEXT = "full_context"
    NONE = "none"


class HarnessConfig(BaseModel):
    """Runtime configuration; layer flags double as evaluation ablations."""

    tool_surface: bool = True
    memory_mode: MemoryMode = MemoryMode.NOTES
    pedagogy_context: Literal["on", "off"] = "on"
    orchestration: bool = True
    journaling: bool = True

    model: str = "gpt-5.6-sol"
    reasoning_effort: Literal["none", "low", "medium", "high", "xhigh", "max"] = "low"
    model_timeout_seconds: float = Field(default=90.0, gt=0)
    model_max_attempts: int = Field(default=3, ge=1, le=6)
    state_directory: Path = Path("state")
    journal_directory: Path = Path("state/journals")

    @model_validator(mode="after")
    def validate_layer_dependencies(self) -> "HarnessConfig":
        if not self.tool_surface and self.memory_mode == MemoryMode.NOTES:
            raise ValueError("memory_mode=notes requires tool_surface=true")
        return self

    @classmethod
    def from_environment(cls) -> "HarnessConfig":
        def env_bool(name: str, default: bool) -> bool:
            raw = os.getenv(name)
            if raw is None:
                return default
            return raw.strip().lower() in {"1", "true", "yes", "on"}

        return cls(
            tool_surface=env_bool("TEACHER_BRAIN_TOOL_SURFACE", True),
            memory_mode=os.getenv("TEACHER_BRAIN_MEMORY_MODE", MemoryMode.NOTES.value),
            pedagogy_context=os.getenv("TEACHER_BRAIN_PEDAGOGY_CONTEXT", "on"),
            orchestration=env_bool("TEACHER_BRAIN_ORCHESTRATION", True),
            journaling=env_bool("TEACHER_BRAIN_JOURNALING", True),
            model=os.getenv("OPENAI_MODEL", "gpt-5.6-sol"),
            reasoning_effort=os.getenv("OPENAI_REASONING_EFFORT", "low"),
            model_timeout_seconds=float(os.getenv("OPENAI_TIMEOUT_SECONDS", "90")),
            model_max_attempts=int(os.getenv("OPENAI_MAX_ATTEMPTS", "3")),
            state_directory=Path(os.getenv("TEACHER_BRAIN_STATE_DIR", "state")),
            journal_directory=Path(
                os.getenv("TEACHER_BRAIN_JOURNAL_DIR", "state/journals")
            ),
        )
