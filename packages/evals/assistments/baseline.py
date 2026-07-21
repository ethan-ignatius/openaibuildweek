from __future__ import annotations

import warnings
from collections.abc import Callable, Iterable
from contextlib import contextmanager
from dataclasses import dataclass
from threading import Lock
from typing import Any, TypeVar

import numpy as np
import pandas as pd
from pyBKT.fit import EM_fit
from pyBKT.models import Model

ResultT = TypeVar("ResultT")
_PYBKT_PATCH_LOCK = Lock()


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
    num_fits: int = 5,
) -> PyBKTPredictions:
    """Fit pyBKT on training students and predict held-out sequences online."""

    if training_interactions.empty or held_out_interactions.empty:
        raise ValueError("pyBKT requires non-empty training and held-out interactions")

    training = _to_pybkt_frame(training_interactions).sort_values(
        ["skill_name", "user_id", "order_id"],
        kind="stable",
    )
    held_out = _to_pybkt_frame(held_out_interactions)
    held_out["_row_id"] = np.arange(len(held_out), dtype=int)
    held_out = held_out.sort_values(
        ["skill_name", "user_id", "order_id"],
        kind="stable",
    )

    model = Model(seed=seed, num_fits=num_fits, parallel=False)
    with _pybkt_estep_compatibility(), warnings.catch_warnings(
        record=True
    ) as caught_warnings:
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


class _SerialPool:
    """Pool-compatible serial map used by the pyBKT 1.4.x import workaround."""

    def __init__(self, *_: Any) -> None:
        pass

    def __enter__(self) -> "_SerialPool":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def map(
        self,
        function: Callable[[Any], ResultT],
        values: Iterable[Any],
    ) -> list[ResultT]:
        return [function(value) for value in values]

    def close(self) -> None:
        return None


@contextmanager
def _pybkt_estep_compatibility() -> Iterable[None]:
    """Execute pyBKT's guarded E-step when the package is imported as a library.

    pyBKT 1.4.x wraps its worker-pool call in an ``if __name__ == '__main__'``
    guard inside ``EM_fit.run``. Imported usage therefore returns zero soft counts.
    The maintained upstream source still contains this guard. The adapter activates
    that path with a serial Pool replacement for the bounded fit/predict section.
    """

    with _PYBKT_PATCH_LOCK:
        original_name = EM_fit.__name__
        original_pool = EM_fit.Pool
        EM_fit.__name__ = "__main__"
        EM_fit.Pool = _SerialPool
        try:
            yield
        finally:
            EM_fit.__name__ = original_name
            EM_fit.Pool = original_pool
