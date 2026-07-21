from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pandas as pd

CLASS_DIMENSIONS = ("CLPC", "CLBM", "CLINSTD")
MQI_DIMENSIONS = ("EXPL", "REMED", "LANGIMP", "SMQR")
SCORE_DIMENSIONS = CLASS_DIMENSIONS + MQI_DIMENSIONS


class NCTEDataError(RuntimeError):
    """Raised when authorized NCTE inputs are missing or malformed."""


@dataclass(frozen=True)
class NCTEDataset:
    exchanges: pd.DataFrame
    utterances: pd.DataFrame
    observation_scores: pd.DataFrame

    @property
    def observation_ids(self) -> list[str]:
        available = set(self.utterances["observation_id"])
        return [
            observation_id
            for observation_id in self.observation_scores["observation_id"]
            if observation_id in available
        ]


def load_ncte(data_directory: Path) -> NCTEDataset:
    """Load transcript text, turn labels, and externally authored human scores."""

    paired_path = _required_file(
        data_directory,
        "paired_annotations.csv",
        "paired_annotations_release.csv",
    )
    utterances_path = _required_file(
        data_directory,
        "single_utterances.csv",
        "ncte_single_utterances.csv",
    )
    class_path = _required_file(data_directory, "class_data.csv")
    mqi_path = _required_file(data_directory, "mqi_data.csv")

    exchanges = _load_exchanges(paired_path)
    utterances = _load_utterances(utterances_path)
    class_scores = _load_score_file(class_path, CLASS_DIMENSIONS)
    mqi_scores = _load_score_file(mqi_path, MQI_DIMENSIONS)
    scores = class_scores.merge(
        mqi_scores,
        on="observation_id",
        how="outer",
        validate="one_to_one",
    )

    if not set(scores["observation_id"]).intersection(utterances["observation_id"]):
        raise NCTEDataError(
            "No OBSID values overlap between single_utterances.csv and the score files"
        )
    return NCTEDataset(
        exchanges=exchanges,
        utterances=utterances,
        observation_scores=scores,
    )


def _load_exchanges(path: Path) -> pd.DataFrame:
    frame = _read_csv(path)
    student_col = _column(frame, "student_text", "student_utterance")
    teacher_col = _column(frame, "teacher_text", "teacher_utterance")
    uptake_col = _column(frame, "high_uptake")
    focusing_col = _column(frame, "focusing_question")
    exchange_col = _optional_column(frame, "exchange_idx", "exchange_id", "comb_idx")
    observation_col = _optional_column(frame, "OBSID", "observation_id")

    output = pd.DataFrame(
        {
            "exchange_id": (
                frame[exchange_col].astype("string")
                if exchange_col
                else pd.Series([f"exchange-{index}" for index in range(len(frame))])
            ),
            "observation_id": (
                frame[observation_col].map(_canonical_id)
                if observation_col
                else pd.Series(["unknown"] * len(frame), dtype="string")
            ),
            "student_text": frame[student_col].astype("string").str.strip(),
            "teacher_text": frame[teacher_col].astype("string").str.strip(),
            "high_uptake": pd.to_numeric(frame[uptake_col], errors="coerce"),
            "focusing_question": pd.to_numeric(frame[focusing_col], errors="coerce"),
        }
    )
    valid = (
        output["student_text"].notna()
        & output["student_text"].ne("")
        & output["teacher_text"].notna()
        & output["teacher_text"].ne("")
        & output["high_uptake"].isin([0, 1])
        & output["focusing_question"].isin([0, 1])
    )
    output = output.loc[valid].copy()
    if output.empty:
        raise NCTEDataError(f"{path} has no complete binary discourse annotations")
    output[["high_uptake", "focusing_question"]] = output[
        ["high_uptake", "focusing_question"]
    ].astype(int)
    return output.reset_index(drop=True)


def _load_utterances(path: Path) -> pd.DataFrame:
    frame = _read_csv(path)
    observation_col = _column(frame, "OBSID", "observation_id")
    text_col = _column(frame, "utterance", "text", "content")
    speaker_col = _column(frame, "speaker", "speaker_name", "role")
    turn_col = _optional_column(frame, "turn_idx", "turn_index", "utterance_index")

    if turn_col:
        turn_index = pd.to_numeric(frame[turn_col], errors="coerce")
    else:
        turn_index = frame.groupby(observation_col, sort=False).cumcount()
    output = pd.DataFrame(
        {
            "observation_id": frame[observation_col].map(_canonical_id),
            "turn_index": turn_index,
            "speaker": frame[speaker_col].astype("string").str.strip(),
            "text": frame[text_col].astype("string").str.strip(),
        }
    )
    output = output.dropna(subset=["observation_id", "turn_index", "speaker", "text"])
    output = output[(output["speaker"] != "") & (output["text"] != "")].copy()
    if output.empty:
        raise NCTEDataError(f"{path} has no usable utterances")
    output["turn_index"] = output["turn_index"].astype(int)
    return output.sort_values(
        ["observation_id", "turn_index"], kind="stable"
    ).reset_index(drop=True)


def _load_score_file(path: Path, dimensions: tuple[str, ...]) -> pd.DataFrame:
    frame = _read_csv(path)
    observation_col = _column(frame, "OBSID", "observation_id")
    selected: dict[str, pd.Series] = {
        "observation_id": frame[observation_col].map(_canonical_id)
    }
    for dimension in dimensions:
        score_col = _column(frame, dimension)
        selected[dimension] = pd.to_numeric(frame[score_col], errors="coerce")
    scores = pd.DataFrame(selected).dropna(subset=["observation_id"])
    scores = scores.groupby("observation_id", sort=False, as_index=False).mean(
        numeric_only=True
    )
    if scores[list(dimensions)].notna().sum().sum() == 0:
        raise NCTEDataError(f"{path} has no usable human observation scores")
    return scores


def _required_file(directory: Path, *names: str) -> Path:
    for name in names:
        candidate = directory / name
        if candidate.is_file():
            return candidate
    expected = " or ".join(str(directory / name) for name in names)
    raise NCTEDataError(
        f"Missing authorized NCTE input: {expected}. Each user must request transcript "
        "access at https://forms.gle/1yWybvsjciqL8Y9p8."
    )


def _read_csv(path: Path) -> pd.DataFrame:
    try:
        return pd.read_csv(path, low_memory=False)
    except (OSError, UnicodeDecodeError, pd.errors.ParserError) as error:
        raise NCTEDataError(f"Could not read {path}: {error}") from error


def _column(frame: pd.DataFrame, *aliases: str) -> str:
    column = _optional_column(frame, *aliases)
    if column is None:
        raise NCTEDataError(
            f"Missing required column ({', '.join(aliases)}); found: "
            f"{', '.join(map(str, frame.columns))}"
        )
    return column


def _optional_column(frame: pd.DataFrame, *aliases: str) -> str | None:
    normalized = {str(column).strip().lower(): str(column) for column in frame.columns}
    for alias in aliases:
        if alias.strip().lower() in normalized:
            return normalized[alias.strip().lower()]
    return None


def _canonical_id(value: object) -> str | None:
    if pd.isna(value):
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()
