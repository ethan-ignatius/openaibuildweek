from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

import pandas as pd

from packages.evals.metrics import BinaryMetrics, binary_metrics, markdown_number
from packages.evals.reporting import estimate_cost
from packages.harness.journal import JournalReader, sum_token_usage
from packages.harness.model_client import TokenUsage

_CONDITIONS = ("none", "full_context", "notes")


@dataclass(frozen=True)
class AssistmentsComparison:
    predictions: Mapping[str, pd.DataFrame]
    metrics: Mapping[str, BinaryMetrics]
    usage: Mapping[str, TokenUsage]
    model: str


def compare_assistments_sessions(
    root: Path,
    sessions: Mapping[str, str],
) -> AssistmentsComparison:
    if set(sessions) != set(_CONDITIONS):
        raise ValueError(f"Sessions must contain exactly: {', '.join(_CONDITIONS)}")
    predictions: dict[str, pd.DataFrame] = {}
    usage: dict[str, TokenUsage] = {}
    models: set[str] = set()
    reference_targets: pd.DataFrame | None = None

    for condition in _CONDITIONS:
        session_id = sessions[condition]
        prediction_path = root / session_id / "agent_predictions.csv"
        journal_path = root / f"{session_id}.jsonl"
        if not prediction_path.is_file() or not journal_path.is_file():
            raise FileNotFoundError(
                f"Missing predictions or journal for {condition}: {session_id}"
            )
        frame = pd.read_csv(prediction_path, dtype={"student_id": "string"})
        required = {
            "student_id",
            "sequence_index",
            "skill_id",
            "correct",
            "probability",
        }
        if not required.issubset(frame.columns):
            raise ValueError(f"Session {session_id} predictions are missing columns")
        if frame.duplicated(["student_id", "sequence_index"]).any():
            raise ValueError(f"Session {session_id} has duplicate prediction targets")
        frame = frame.sort_values(
            ["student_id", "sequence_index"], kind="stable"
        ).reset_index(drop=True)
        targets = frame[
            ["student_id", "sequence_index", "skill_id", "correct"]
        ].copy()
        if reference_targets is None:
            reference_targets = targets
        elif not targets.equals(reference_targets):
            raise ValueError(
                f"Session {session_id} does not use the exact same external targets"
            )

        events = JournalReader(journal_path).read_all()
        started = next(
            (event for event in events if event["event_type"] == "session.started"),
            None,
        )
        if started is None:
            raise ValueError(f"Session {session_id} has no session.started event")
        payload = started["payload"]
        if payload.get("memory_mode") != condition:
            raise ValueError(
                f"Session {session_id} declares memory mode {payload.get('memory_mode')}"
            )
        models.add(str(payload.get("model", "gpt-5.6")))
        totals = sum_token_usage(events)
        usage[condition] = TokenUsage(**totals)
        predictions[condition] = frame

    if len(models) != 1:
        raise ValueError(f"Comparison sessions used different models: {sorted(models)}")
    metrics = {
        condition: binary_metrics(
            frame["correct"].tolist(), frame["probability"].tolist()
        )
        for condition, frame in predictions.items()
    }
    return AssistmentsComparison(
        predictions=predictions,
        metrics=metrics,
        usage=usage,
        model=models.pop(),
    )


def write_assistments_comparison_report(
    path: Path,
    comparison: AssistmentsComparison,
    *,
    sessions: Mapping[str, str],
    chunk_size: int,
    skipped_development_students: int,
    maximum_student_interactions: int,
) -> None:
    lines = [
        "# Teacher Brain Learner-Memory Arena",
        "",
        "**Status: COMPLETE**",
        "",
        "The same GPT-5.6 model predicted identical, externally observed next answers "
        "under three memory conditions.",
        "",
        "## Controlled Comparison",
        "",
        "| Condition | Predictions | AUC | Brier | F1 @ 0.5 |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    labels = {
        "none": "Stateless GPT-5.6",
        "full_context": "GPT-5.6 full history",
        "notes": "Teacher Brain notes",
    }
    for condition in _CONDITIONS:
        metric = comparison.metrics[condition]
        lines.append(
            f"| {labels[condition]} | {metric.count} | {markdown_number(metric.auc)} | "
            f"{markdown_number(metric.brier)} | {markdown_number(metric.f1)} |"
        )

    notes = comparison.metrics["notes"]
    stateless = comparison.metrics["none"]
    full_context = comparison.metrics["full_context"]
    notes_usage = comparison.usage["notes"]
    full_context_usage = comparison.usage["full_context"]
    input_reduction = 1 - (notes_usage.input / full_context_usage.input)
    total_reduction = 1 - (notes_usage.total / full_context_usage.total)
    lines.extend(
        [
            "",
            "## Harness Lift",
            "",
            f"- Notes-minus-stateless AUC: **{notes.auc - stateless.auc:+.4f}**",
            "- Notes-over-stateless Brier improvement: "
            f"**{stateless.brier - notes.brier:+.4f}**",
            f"- Notes-minus-full-history AUC: **{notes.auc - full_context.auc:+.4f}**",
            "- Notes-over-full-history Brier improvement: "
            f"**{full_context.brier - notes.brier:+.4f}**",
            f"- Notes input-token reduction versus full history: **{input_reduction:.1%}**",
            f"- Notes total-token reduction versus full history: **{total_reduction:.1%}**",
            "",
            "Positive AUC lift and positive Brier improvement favor Teacher Brain.",
            "",
            "## Run Accounting",
            "",
            "| Condition | Input tokens | Output tokens | Total tokens | Estimated cost |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    total_usage = TokenUsage()
    for condition in _CONDITIONS:
        item_usage = comparison.usage[condition]
        total_usage += item_usage
        cost = estimate_cost(comparison.model, item_usage).total_usd
        lines.append(
            f"| `{condition}` | {item_usage.input:,} | {item_usage.output:,} | "
            f"{item_usage.total:,} | {_cost(cost)} |"
        )
    total_cost = estimate_cost(comparison.model, total_usage).total_usd
    students = comparison.predictions["notes"]["student_id"].nunique()
    lines.extend(
        [
            "",
            f"Total tokens processed: **{total_usage.total:,}**",
            "",
            f"Estimated total API cost: **{_cost(total_cost)}**",
            "",
            "## Protocol",
            "",
            f"- Model: `{comparison.model}`",
            f"- Held-out students: **{students}**",
            f"- Chronological chunk size: **{chunk_size} interactions**",
            f"- Previously used development students skipped: **{skipped_development_students}**",
            f"- Maximum selected trajectory length: **{maximum_student_interactions}**",
            "- `none`: next skill tag only; no prior learner evidence.",
            "- `full_context`: all observed rows are resent on every prediction; no "
            "persistent notes or memory tool.",
            "- `notes`: the model must update a bounded Markdown learner file through a "
            "validated tool, then predict using only that file and the next skill tag.",
            "- The next response is withheld in every condition. A comparison is refused "
            "unless student, sequence, skill, and outcome targets match exactly.",
            "",
            "## Sessions",
            "",
        ]
    )
    for condition in _CONDITIONS:
        lines.append(f"- `{condition}`: `{sessions[condition]}`")
    lines.extend(
        [
            "",
            "## Interpretation",
            "",
            "This directly tests learner-state utility against future student outcomes, "
            "not similarity to a teacher's wording. The sample is intentionally small and "
            "development-scale. Any confirmatory claim requires freezing this protocol and "
            "running new held-out students. Full history is a strong information-rich "
            "comparator; notes are useful when they preserve calibration while reducing "
            "context growth and remaining human-readable.",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _cost(value: float | None) -> str:
    return "N/A" if value is None else f"${value:.4f}"
