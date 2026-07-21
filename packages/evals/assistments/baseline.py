from __future__ import annotations

import warnings
from dataclasses import dataclass

import numpy as np
import pandas as pd
from pyBKT.models import Model


@dataclass(frozen=True)
class PyBKTPredictions:
    predictions: pd.DataFrame
    fallback_count: int
    warnings: tuple[str, ...]


def fit_predict_pybkt(
    training_interactions: pd.DataFrame,
    held_out_interactions: pd.DataFrame,
    *,
    seed: int = 42,
    num_fits: int = 1,
) -> PyBKTPredictions:
    """Fit pyBKT on training students and predict held-out sequences online."""

    if training_interactions.empty or held_out_interactions.empty:
        raise ValueError("pyBKT requires non-empty training and held-out interactions")

    training = _to_pybkt_frame(training_interactions)
    held_out = _to_pybkt_frame(held_out_interactions)
    held_out["_row_id"] = np.arange(len(held_out), dtype=int)

    model = Model(seed=seed, num_fits=num_fits, parallel=False)
    with warnings.catch_warnings(record=True) as caught_warnings:
        warnings.simplefilter("always")
        model.fit(data=training)
        predicted = model.predict(data=held_out).sort_values("_row_id", kind="stable")

    skill_rates = training.groupby("skill_name")["correct"].mean().to_dict()
    global_rate = float(training["correct"].mean())
    probabilities = pd.to_numeric(
        predicted["correct_predictions"], errors="coerce"
    ).to_numpy(dtype=float, copy=True)
    invalid = ~np.isfinite(probabilities) | (probabilities < 0) | (probabilities > 1)
    for index in np.flatnonzero(invalid):
        skill = str(predicted.iloc[index]["skill_name"])
        probabilities[index] = float(skill_rates.get(skill, global_rate))

    output = held_out_interactions.reset_index(drop=True)[
        ["student_id", "sequence_index", "skill_id", "correct"]
    ].copy()
    output["probability"] = probabilities
    output["model"] = "pyBKT"
    return PyBKTPredictions(
        output,
        int(invalid.sum()),
        tuple(str(warning.message) for warning in caught_warnings),
    )


def _to_pybkt_frame(interactions: pd.DataFrame) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "order_id": interactions["order_id"].astype(int).to_numpy(),
            "user_id": interactions["student_id"].astype(str).to_numpy(),
            "skill_name": interactions["skill_id"].astype(str).to_numpy(),
            "correct": interactions["correct"].astype(int).to_numpy(),
        }
    )
