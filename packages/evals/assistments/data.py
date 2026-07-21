from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pandas as pd


class AssistmentsDataError(ValueError):
    """Raised when an ASSISTments source is missing, unverifiable, or malformed."""


@dataclass(frozen=True)
class AssistmentsDataset:
    interactions: pd.DataFrame
    source_path: Path
    source_sha256: str
    source_encoding: str

    @property
    def students(self) -> list[str]:
        return sorted(self.interactions["student_id"].unique().tolist())

    def split_students(
        self,
        *,
        held_out_fraction: float = 0.2,
        seed: int = 42,
    ) -> tuple[list[str], list[str]]:
        if not 0 < held_out_fraction < 1:
            raise ValueError("held_out_fraction must be between 0 and 1")
        ranked = sorted(
            self.students,
            key=lambda student: hashlib.sha256(
                f"{seed}:{student}".encode("utf-8")
            ).digest(),
        )
        held_out_count = max(1, round(len(ranked) * held_out_fraction))
        if held_out_count >= len(ranked):
            held_out_count = len(ranked) - 1
        if held_out_count < 1:
            raise AssistmentsDataError("At least two eligible students are required")
        return ranked[held_out_count:], ranked[:held_out_count]


_ALIASES: dict[str, tuple[str, ...]] = {
    "order": ("order_id", "order", "timestamp"),
    "student": ("user_id", "student_id", "Anon Student Id"),
    "problem": ("problem_id", "assistment_id", "problem"),
    "skill": ("skill_id", "skill", "KC(Default)"),
    "skill_name": ("skill_name", "KC(Default)", "skill_id", "skill"),
    "correct": ("correct", "Correct First Attempt", "is_correct"),
    "attempt": ("attempt_count", "attempt", "attempt_number"),
    "original": ("original", "is_original"),
}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_verified_manifest(source_path: Path, manifest_path: Path) -> dict[str, Any]:
    if not source_path.is_file():
        raise FileNotFoundError(source_path)
    manifest = {
        "variant": "corrected_deduplicated_skill_builder_2009_2010",
        "file": source_path.name,
        "sha256": sha256_file(source_path),
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return manifest


def load_assistments(
    source_path: Path,
    *,
    manifest_path: Path | None = None,
    require_verified: bool = True,
    min_interactions: int = 80,
    pseudonym_salt: str = "teacher-brain-assistments-v1",
) -> AssistmentsDataset:
    if not source_path.is_file():
        raise AssistmentsDataError(f"ASSISTments file not found: {source_path}")
    if min_interactions < 2:
        raise ValueError("min_interactions must be at least 2")

    source_sha256 = sha256_file(source_path)
    if require_verified:
        _verify_manifest(source_path, source_sha256, manifest_path)

    frame, source_encoding = _read_source(source_path)
    columns = {
        canonical: _find_column(frame, aliases)
        for canonical, aliases in _ALIASES.items()
    }
    required = (
        "order",
        "student",
        "problem",
        "skill",
        "correct",
        "original",
    )
    missing = [column for column in required if columns[column] is None]
    if missing:
        raise AssistmentsDataError(
            f"ASSISTments file is missing columns for: {', '.join(missing)}"
        )

    working = frame.copy()
    original = pd.to_numeric(working[columns["original"]], errors="coerce")
    working = working[original == 1]

    # Each corrected row is a student-problem summary. `correct` is the first-attempt
    # outcome; `attempt_count` is the total work on that problem and must not be used
    # as a row filter, or incorrect first attempts would be systematically removed.

    canonical_frame = pd.DataFrame(
        {
            "raw_student_id": working[columns["student"]].astype(str).str.strip(),
            "problem_id": working[columns["problem"]].map(_normalized_identifier),
            "skill_id": working[columns["skill"]].map(_normalized_identifier),
            "skill_name": working[columns["skill_name"]].astype(str).str.strip()
            if columns["skill_name"] is not None
            else working[columns["skill"]].map(_normalized_identifier),
            "correct": pd.to_numeric(working[columns["correct"]], errors="coerce"),
            "order_id": pd.to_numeric(working[columns["order"]], errors="coerce"),
        }
    )
    canonical_frame = canonical_frame[
        canonical_frame["raw_student_id"].ne("")
        & canonical_frame["skill_id"].ne("")
        & canonical_frame["skill_id"].ne("nan")
        & canonical_frame["problem_id"].ne("")
        & canonical_frame["correct"].isin([0, 1])
        & canonical_frame["order_id"].notna()
    ]
    canonical_frame["correct"] = canonical_frame["correct"].astype(int)
    canonical_frame["order_id"] = canonical_frame["order_id"].astype(int)
    canonical_frame = canonical_frame.sort_values(
        ["raw_student_id", "order_id"], kind="stable"
    )
    canonical_frame = canonical_frame.drop_duplicates(
        subset=["raw_student_id", "problem_id"], keep="first"
    )

    counts = canonical_frame.groupby("raw_student_id").size()
    eligible = counts[counts >= min_interactions].index
    canonical_frame = canonical_frame[
        canonical_frame["raw_student_id"].isin(eligible)
    ].copy()
    if canonical_frame.empty:
        raise AssistmentsDataError(
            f"No students have at least {min_interactions} filtered interactions"
        )

    canonical_frame["student_id"] = canonical_frame["raw_student_id"].map(
        lambda raw_id: _pseudonym(raw_id, pseudonym_salt)
    )
    canonical_frame["sequence_index"] = canonical_frame.groupby("student_id").cumcount()
    canonical_frame = canonical_frame.drop(columns=["raw_student_id"])
    canonical_frame = canonical_frame[
        [
            "student_id",
            "sequence_index",
            "order_id",
            "problem_id",
            "skill_id",
            "skill_name",
            "correct",
        ]
    ].reset_index(drop=True)
    return AssistmentsDataset(
        interactions=canonical_frame,
        source_path=source_path,
        source_sha256=source_sha256,
        source_encoding=source_encoding,
    )


def _verify_manifest(
    source_path: Path,
    source_sha256: str,
    manifest_path: Path | None,
) -> None:
    if manifest_path is None:
        manifest_path = source_path.parent / "manifest.json"
    if not manifest_path.is_file():
        raise AssistmentsDataError(
            "A provenance manifest is required. Run scripts/prepare_assistments.py "
            "after obtaining the corrected/deduplicated dataset."
        )
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise AssistmentsDataError(f"Invalid manifest JSON: {manifest_path}") from error
    if manifest.get("variant") != "corrected_deduplicated_skill_builder_2009_2010":
        raise AssistmentsDataError("Manifest does not identify the corrected dataset")
    if manifest.get("file") != source_path.name:
        raise AssistmentsDataError("Manifest file name does not match the source")
    if manifest.get("sha256") != source_sha256:
        raise AssistmentsDataError("ASSISTments source checksum does not match manifest")


def _find_column(frame: pd.DataFrame, aliases: tuple[str, ...]) -> str | None:
    by_lower = {str(column).lower(): str(column) for column in frame.columns}
    for alias in aliases:
        if alias in frame.columns:
            return alias
        match = by_lower.get(alias.lower())
        if match is not None:
            return match
    return None


def _read_source(source_path: Path) -> tuple[pd.DataFrame, str]:
    for encoding in ("utf-8", "cp1252"):
        try:
            return pd.read_csv(
                source_path,
                encoding=encoding,
                low_memory=False,
            ), encoding
        except UnicodeDecodeError:
            continue
        except (OSError, pd.errors.ParserError) as error:
            raise AssistmentsDataError(f"Could not read {source_path}: {error}") from error
    raise AssistmentsDataError(
        f"Could not decode {source_path} as UTF-8 or Windows-1252"
    )


def _normalized_identifier(value: Any) -> str:
    if pd.isna(value):
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _pseudonym(raw_student_id: str, salt: str) -> str:
    digest = hashlib.sha256(f"{salt}:{raw_student_id}".encode("utf-8")).hexdigest()
    return f"assist_{digest[:12]}"
