from __future__ import annotations

from pathlib import Path
from typing import Mapping

from packages.evals.metrics import BinaryMetrics, markdown_number
from packages.evals.ncte.data import SCORE_DIMENSIONS
from packages.evals.reporting import estimate_cost
from packages.harness.model_client import TokenUsage

PUBLISHED_ROBERTA_F1 = {
    "high_uptake": 0.688,
    "focusing_question": 0.501,
}

# Direct-assessment ("numerical") outputs released by Wang and Demszky (2023).
PUBLISHED_CHATGPT_SPEARMAN = {
    "CLPC": (100, 0.003617201332403922),
    "CLBM": (100, 0.3546240407039119),
    "CLINSTD": (100, -0.009015557596793403),
    "EXPL": (203, 0.020907765117638217),
    "REMED": (203, 0.04790134376789707),
    "LANGIMP": (203, -0.0009830236262789974),
    "SMQR": (203, 0.17406423113082012),
}


def write_ncte_report(
    path: Path,
    *,
    status: str,
    status_detail: str,
    turn_results: Mapping[str, BinaryMetrics] | None = None,
    score_results: Mapping[str, tuple[int, float]] | None = None,
    model: str = "gpt-5.6",
    condition: str = "full",
    usage: TokenUsage = TokenUsage(),
) -> None:
    cost = estimate_cost(model, usage)
    lines = [
        "# NCTE Transcript Evaluation",
        "",
        f"**Status: {status}**",
        "",
        status_detail,
        "",
        "## Turn-Level Discourse Moves",
        "",
        "| Label | Predictions | Teacher Brain F1 | Published RoBERTa F1 |",
        "| --- | ---: | ---: | ---: |",
    ]
    for label in ("high_uptake", "focusing_question"):
        result = turn_results.get(label) if turn_results else None
        lines.append(
            f"| `{label}` | {result.count if result else 0} | "
            f"{markdown_number(result.f1) if result else 'N/A'} | "
            f"{PUBLISHED_ROBERTA_F1[label]:.3f} |"
        )

    lines.extend(
        [
            "",
            "The RoBERTa references are the five-fold cross-validation values reported "
            "by the NCTE dataset authors. They are contextual bars, not results produced "
            "by this run.",
            "",
            "## Observation Scoring",
            "",
            "| Dimension | Teacher Brain N | Teacher Brain Spearman | "
            "Published ChatGPT N | Published ChatGPT Spearman |",
            "| --- | ---: | ---: | ---: | ---: |",
        ]
    )
    for dimension in SCORE_DIMENSIONS:
        score = score_results.get(dimension) if score_results else None
        baseline_count, baseline_correlation = PUBLISHED_CHATGPT_SPEARMAN[dimension]
        lines.append(
            f"| `{dimension}` | {score[0] if score else 0} | "
            f"{markdown_number(score[1]) if score else 'N/A'} | {baseline_count} | "
            f"{baseline_correlation:.4f} |"
        )

    lines.extend(
        [
            "",
            "The published ChatGPT references are recomputed from the authors' released "
            "GPT-3.5 direct-assessment outputs after applying their non-null prompt filter. "
            "They are not rerun or counted in this run's token accounting.",
            "",
            "## Run Accounting",
            "",
            f"- Condition: `{condition}`",
            f"- Model: `{model}`",
            f"- Input tokens: **{usage.input:,}**",
            f"- Output tokens: **{usage.output:,}**",
            f"- Total tokens processed: **{usage.total:,}**",
            f"- Estimated API cost: **{_cost_text(cost.total_usd)}**",
            "",
            "## Method",
            "",
            "Turn-level predictions receive only the student utterance and subsequent "
            "teacher utterance. F1 is measured against majority-rater high-uptake and "
            "focusing-question labels. Observation predictions receive anonymized "
            "transcript text without any human score columns. Duplicate human raters are "
            "mean-aggregated within OBSID before Spearman correlation.",
            "",
            "The full condition includes the exact NCTE discourse vocabulary in the "
            "pedagogical context; `pedagogy-off` removes those definitions. Journals retain "
            "model requests, responses, predictions, latency, and token usage for replay.",
            "",
            "## Interpretation Caveat",
            "",
            "The published reference samples and this run may differ in size and rating "
            "aggregation. Compare dimension-level correlations as reference bars, not as a "
            "controlled model-only experiment. Controlled harness lift requires running the "
            "same selected observations through both local conditions.",
            "",
            "Sources: [NCTE dataset paper](https://aclanthology.org/2023.bea-1.44/), "
            "[published ChatGPT baseline artifacts]"
            "(https://github.com/rosewang2008/zero-shot-teacher-feedback).",
        ]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _cost_text(value: float | None) -> str:
    return "N/A (pricing not configured)" if value is None else f"${value:.4f}"
