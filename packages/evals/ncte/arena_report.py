from __future__ import annotations

from pathlib import Path
from typing import Mapping

import pandas as pd

from packages.evals.metrics import BinaryMetrics, markdown_number
from packages.evals.reporting import estimate_cost
from packages.harness.model_client import TokenUsage

_LABELS = ("high_uptake", "focusing_question")


def write_arena_report(
    path: Path,
    *,
    status: str,
    status_detail: str,
    model: str,
    predictions: pd.DataFrame | None = None,
    metrics: Mapping[str, Mapping[str, BinaryMetrics]] | None = None,
    usage_by_condition: Mapping[str, TokenUsage] | None = None,
    observation_ids: list[str] | None = None,
    decisions_per_observation: int = 0,
    session_directory: Path | None = None,
) -> None:
    metrics = metrics or {}
    usage_by_condition = usage_by_condition or {}
    conditions = [
        condition
        for condition in ("bare", "scaffolded", "full")
        if condition in metrics or condition in usage_by_condition
    ]
    lines = [
        "# Teacher Brain Long-Horizon Arena",
        "",
        f"**Status: {status}**",
        "",
        status_detail,
        "",
        "## Controlled Comparison",
        "",
        "All conditions use the same model, reasoning effort, real transcript prefixes, "
        "decision points, and externally authored NCTE annotations.",
        "",
        "| Condition | High-uptake F1 | Focusing-question F1 | Macro F1 | "
        "High-uptake Brier | Focusing-question Brier |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for condition in conditions:
        condition_metrics = metrics.get(condition, {})
        uptake = condition_metrics.get("high_uptake")
        focusing = condition_metrics.get("focusing_question")
        macro = (
            (uptake.f1 + focusing.f1) / 2 if uptake and focusing else float("nan")
        )
        lines.append(
            f"| `{condition}` | {_metric(uptake, 'f1')} | "
            f"{_metric(focusing, 'f1')} | {markdown_number(macro)} | "
            f"{_metric(uptake, 'brier')} | {_metric(focusing, 'brier')} |"
        )

    lines.extend(["", "## Harness Lift", ""])
    if "bare" in metrics and "full" in metrics:
        for label in _LABELS:
            bare = metrics["bare"][label]
            full = metrics["full"][label]
            lines.append(
                f"- `{label}` full-minus-bare F1: "
                f"**{full.f1 - bare.f1:+.4f}**; Brier improvement: "
                f"**{bare.brier - full.brier:+.4f}**"
            )
        bare_macro = sum(metrics["bare"][label].f1 for label in _LABELS) / 2
        full_macro = sum(metrics["full"][label].f1 for label in _LABELS) / 2
        lines.append(
            f"- Macro F1 full-minus-bare: **{full_macro - bare_macro:+.4f}**"
        )
    else:
        lines.append("No complete bare/full pair is available yet.")
    if "scaffolded" in metrics and "full" in metrics:
        scaffold_macro = (
            sum(metrics["scaffolded"][label].f1 for label in _LABELS) / 2
        )
        full_macro = sum(metrics["full"][label].f1 for label in _LABELS) / 2
        lines.append(
            "- Persistent-state/tool lift over pedagogical scaffolding alone, macro F1: "
            f"**{full_macro - scaffold_macro:+.4f}**"
        )

    lines.extend(
        [
            "",
            "Positive F1 lift and positive Brier improvement favor Teacher Brain. Brier "
            "captures probability calibration; lower raw Brier is better.",
            "",
            "## Run Accounting",
            "",
            "| Condition | Decisions | Input tokens | Output tokens | Total tokens | "
            "Estimated cost | Median latency |",
            "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
        ]
    )
    total_usage = TokenUsage()
    for condition in conditions:
        usage = usage_by_condition.get(condition, TokenUsage())
        total_usage += usage
        condition_rows = (
            predictions[predictions["condition"] == condition]
            if predictions is not None and not predictions.empty
            else pd.DataFrame()
        )
        count = len(condition_rows)
        latency = (
            float(condition_rows["latency_ms"].median())
            if not condition_rows.empty
            else float("nan")
        )
        cost = estimate_cost(model, usage).total_usd
        lines.append(
            f"| `{condition}` | {count} | {usage.input:,} | {usage.output:,} | "
            f"{usage.total:,} | {_cost(cost)} | {markdown_number(latency, 1)} ms |"
        )
    total_cost = estimate_cost(model, total_usage).total_usd
    lines.extend(
        [
            "",
            f"Total tokens processed: **{total_usage.total:,}**",
            "",
            f"Estimated total API cost: **{_cost(total_cost)}**",
            "",
            "## Protocol",
            "",
            f"- Model: `{model}`",
            f"- Fresh observations: `{', '.join(observation_ids or [])}`",
            f"- Decision points per observation: **{decisions_per_observation}**",
            "- `bare`: transcript prefix plus a structured next-move response; no "
            "pedagogy definitions, tools, or persistent harness state.",
            "- `scaffolded`: same prefix and output contract with NCTE discourse "
            "definitions; no tools or persistent state.",
            "- `full`: same prefix with pedagogy context plus a strict commit tool that "
            "atomically updates bounded learner, lesson, and participation state.",
            "- Episodes are serialized within each observation. Independent "
            "observations may run concurrently.",
            "- The real teacher response and human labels are hidden until after the "
            "model commits its move. Selection uses annotation density and transcript "
            "length, never label values.",
            "",
            "The annotation target is the discourse-move choice at the same real "
            "classroom decision point. The generated response and state diffs are retained "
            "for qualitative inspection, but no model judge contributes to headline scores.",
            "",
            "## Replay",
            "",
            (
                f"The JSONL journal, checkpoint, and licensed-text replay are under "
                f"`{session_directory}`. The directory is gitignored."
                if session_directory
                else "No completed replay directory is available."
            ),
            "",
            "## Interpretation Caveats",
            "",
            "This is a controlled development-scale comparison, not a population estimate. "
            "NCTE speakers are anonymized, so the harness maintains classroom-level learner "
            "evidence and does not invent individual identities. The transcript follows the "
            "recorded human teacher path after each decision, not the counterfactual path the "
            "agent's response might have caused; persistent-agent results are therefore "
            "off-policy and should be interpreted as next-move quality with carried state.",
            "",
            "A generated response can also fail to realize its declared move probability. "
            "The replay is required for that qualitative audit. Larger confirmatory runs "
            "must freeze this protocol and use a new held-out observation set.",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _metric(metric: BinaryMetrics | None, attribute: str) -> str:
    return markdown_number(getattr(metric, attribute)) if metric else "N/A"


def _cost(value: float | None) -> str:
    return "N/A" if value is None else f"${value:.4f}"
