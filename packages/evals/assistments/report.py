from __future__ import annotations

from pathlib import Path
from typing import Mapping

from packages.evals.metrics import BinaryMetrics, markdown_number
from packages.evals.reporting import estimate_cost
from packages.harness.model_client import TokenUsage


def write_assistments_report(
    path: Path,
    *,
    status: str,
    status_detail: str,
    source_sha256: str | None = None,
    eligible_students: int | None = None,
    interactions: int | None = None,
    results: Mapping[str, BinaryMetrics] | None = None,
    model: str = "gpt-5.6",
    usage: TokenUsage = TokenUsage(),
    pybkt_fallback_count: int = 0,
) -> None:
    cost = estimate_cost(model, usage)
    lines = [
        "# ASSISTments Long-Horizon Calibration",
        "",
        f"**Status: {status}**",
        "",
        status_detail,
        "",
        "## Results",
        "",
        "| System | Predictions | AUC | Brier | F1 @ 0.5 |",
        "| --- | ---: | ---: | ---: | ---: |",
    ]
    if results:
        for name, metrics in results.items():
            lines.append(
                f"| {name} | {metrics.count} | {markdown_number(metrics.auc)} | "
                f"{markdown_number(metrics.brier)} | {markdown_number(metrics.f1)} |"
            )
    else:
        lines.append("| Not run | 0 | N/A | N/A | N/A |")

    lines.extend(
        [
            "",
            "## Run Accounting",
            "",
            f"- Model: `{model}`",
            f"- Input tokens: **{usage.input:,}**",
            f"- Output tokens: **{usage.output:,}**",
            f"- Total tokens processed: **{usage.total:,}**",
            f"- Estimated API cost: **{_cost_text(cost.total_usd)}**",
            f"- pyBKT non-finite fallbacks: **{pybkt_fallback_count:,}**",
            f"- Eligible students: **{_optional_count(eligible_students)}**",
            f"- Filtered interactions: **{_optional_count(interactions)}**",
            f"- Source SHA-256: `{source_sha256 or 'N/A'}`",
            "",
            "## Method",
            "",
            "The loader uses the corrected/deduplicated ASSISTments 2009-10 "
            "skill-builder release, retains first attempts on original problems, drops "
            "missing skill IDs, and selects students with at least 80 filtered "
            "interactions. Student IDs are converted to stable pseudonyms before any "
            "notes or journals are written. Held-out students are split deterministically.",
            "",
            "After each chronological chunk, the notes condition updates a Markdown "
            "learner model without seeing the next item. The probability request receives "
            "only that note and the next skill tag. Full-context and no-memory conditions "
            "use the same prediction points.",
            "",
            "## Contamination Note",
            "",
            "This is row-level next-response prediction from chronological context for "
            "anonymized IDs. The target response is withheld, and memorized public text "
            "cannot reveal the outcome of a particular anonymized student-item row.",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _cost_text(value: float | None) -> str:
    return "N/A (pricing not configured)" if value is None else f"${value:.4f}"


def _optional_count(value: int | None) -> str:
    return "N/A" if value is None else f"{value:,}"
