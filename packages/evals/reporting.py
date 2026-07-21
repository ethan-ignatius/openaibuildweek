from __future__ import annotations

from dataclasses import dataclass

from packages.harness.model_client import TokenUsage

_PRICING_USD_PER_MILLION = {
    "gpt-5.6": (5.0, 30.0),
    "gpt-5.6-sol": (5.0, 30.0),
}


@dataclass(frozen=True)
class CostEstimate:
    model: str
    input_usd: float | None
    output_usd: float | None
    total_usd: float | None


def estimate_cost(model: str, usage: TokenUsage) -> CostEstimate:
    rates = _PRICING_USD_PER_MILLION.get(model)
    if rates is None:
        return CostEstimate(model, None, None, None)
    input_cost = usage.input / 1_000_000 * rates[0]
    output_cost = usage.output / 1_000_000 * rates[1]
    return CostEstimate(model, input_cost, output_cost, input_cost + output_cost)
