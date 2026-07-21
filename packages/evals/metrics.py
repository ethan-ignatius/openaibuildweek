from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np
from scipy.stats import spearmanr
from sklearn.metrics import brier_score_loss, f1_score, roc_auc_score


@dataclass(frozen=True)
class BinaryMetrics:
    count: int
    auc: float
    brier: float
    f1: float

    def as_dict(self) -> dict[str, int | float]:
        return {
            "count": self.count,
            "auc": self.auc,
            "brier": self.brier,
            "f1": self.f1,
        }


def binary_metrics(
    labels: list[int] | np.ndarray,
    probabilities: list[float] | np.ndarray,
    *,
    threshold: float = 0.5,
) -> BinaryMetrics:
    truth = np.asarray(labels, dtype=int)
    predicted = np.asarray(probabilities, dtype=float)
    if truth.shape != predicted.shape:
        raise ValueError("Labels and probabilities must have the same shape")
    if truth.size == 0:
        raise ValueError("At least one prediction is required")
    if not np.isin(truth, [0, 1]).all():
        raise ValueError("Binary labels must be 0 or 1")
    if not np.isfinite(predicted).all() or ((predicted < 0) | (predicted > 1)).any():
        raise ValueError("Probabilities must be finite values in [0, 1]")

    auc = float("nan")
    if np.unique(truth).size == 2:
        auc = float(roc_auc_score(truth, predicted))
    return BinaryMetrics(
        count=int(truth.size),
        auc=auc,
        brier=float(brier_score_loss(truth, predicted)),
        f1=float(f1_score(truth, predicted >= threshold, zero_division=0)),
    )


def spearman_correlation(
    expected: list[float] | np.ndarray,
    predicted: list[float] | np.ndarray,
) -> float:
    truth = np.asarray(expected, dtype=float)
    estimates = np.asarray(predicted, dtype=float)
    if truth.shape != estimates.shape:
        raise ValueError("Expected and predicted scores must have the same shape")
    if truth.size < 2 or np.unique(truth).size < 2 or np.unique(estimates).size < 2:
        return float("nan")
    result = spearmanr(truth, estimates, nan_policy="omit")
    return float(result.statistic)


def markdown_number(value: Any, digits: int = 4) -> str:
    if isinstance(value, float):
        if math.isnan(value):
            return "N/A"
        return f"{value:.{digits}f}"
    return str(value)
