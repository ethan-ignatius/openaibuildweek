from __future__ import annotations

import json
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Generic, Protocol, TypeVar

from jsonschema import Draft202012Validator
from openai import APIConnectionError, APITimeoutError, InternalServerError, OpenAI, RateLimitError
from pydantic import BaseModel

from packages.harness.config import HarnessConfig
from packages.harness.journal import JournalWriter

ResponseT = TypeVar("ResponseT", bound=BaseModel)


class ModelClientError(RuntimeError):
    """Raised when a model call exhausts its bounded retry policy."""


class ToolExecutionError(ModelClientError):
    """Raised when a required model tool call cannot be validated or executed."""


@dataclass(frozen=True)
class TokenUsage:
    input: int = 0
    output: int = 0
    total: int = 0

    def __add__(self, other: "TokenUsage") -> "TokenUsage":
        return TokenUsage(
            input=self.input + other.input,
            output=self.output + other.output,
            total=self.total + other.total,
        )

    def as_dict(self) -> dict[str, int]:
        return {"input": self.input, "output": self.output, "total": self.total}


@dataclass(frozen=True)
class ModelResult(Generic[ResponseT]):
    parsed: ResponseT
    usage: TokenUsage
    latency_ms: float
    response_id: str


@dataclass(frozen=True)
class ToolRunResult:
    result: Mapping[str, Any]
    usage: TokenUsage
    latency_ms: float
    response_id: str
    continuation_input: tuple[Any, ...]


@dataclass(frozen=True)
class ToolDefinition:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Callable[[dict[str, Any]], Mapping[str, Any]]

    def as_openai_tool(self) -> dict[str, Any]:
        return {
            "type": "function",
            "name": self.name,
            "description": self.description,
            "parameters": self.parameters,
            "strict": True,
        }


class StructuredModelClient(Protocol):
    def generate_structured(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        response_model: type[ResponseT],
        metadata: Mapping[str, str] | None = None,
    ) -> ModelResult[ResponseT]: ...

    def execute_required_tool(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        tool: ToolDefinition,
        metadata: Mapping[str, str] | None = None,
    ) -> ToolRunResult: ...

    def generate_with_required_tool(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        tool: ToolDefinition,
        response_model: type[ResponseT],
        metadata: Mapping[str, str] | None = None,
    ) -> ModelResult[ResponseT]: ...


class OpenAIModelClient:
    """Single Responses API boundary with retries, timeouts, and accounting."""

    _RETRYABLE = (APIConnectionError, APITimeoutError, InternalServerError, RateLimitError)

    def __init__(
        self,
        config: HarnessConfig,
        *,
        journal: JournalWriter | None = None,
        client: OpenAI | None = None,
    ) -> None:
        self.config = config
        self.journal = journal
        self.client = client or OpenAI(timeout=config.model_timeout_seconds, max_retries=0)
        self.total_usage = TokenUsage()

    def generate_structured(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        response_model: type[ResponseT],
        metadata: Mapping[str, str] | None = None,
    ) -> ModelResult[ResponseT]:
        request_input: list[dict[str, str]] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        return self._parse_response(
            request_input=request_input,
            response_model=response_model,
            metadata=metadata,
        )

    def generate_with_required_tool(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        tool: ToolDefinition,
        response_model: type[ResponseT],
        metadata: Mapping[str, str] | None = None,
    ) -> ModelResult[ResponseT]:
        tool_run = self.execute_required_tool(
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            tool=tool,
            metadata=metadata,
        )
        parsed_result = self._parse_response(
            request_input=tool_run.continuation_input,
            response_model=response_model,
            metadata=metadata,
        )
        return ModelResult(
            parsed=parsed_result.parsed,
            usage=tool_run.usage + parsed_result.usage,
            latency_ms=tool_run.latency_ms + parsed_result.latency_ms,
            response_id=parsed_result.response_id,
        )

    def execute_required_tool(
        self,
        *,
        system_prompt: str,
        user_prompt: str,
        tool: ToolDefinition,
        metadata: Mapping[str, str] | None = None,
    ) -> ToolRunResult:
        request_input: list[Any] = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]
        tool_usage = TokenUsage()
        tool_latency = 0.0
        function_call: Any | None = None
        tool_result: dict[str, Any] | None = None
        response_id = ""

        for _repair_attempt in range(2):
            response, latency_ms = self._request(
                "model.request",
                {
                    "model": self.config.model,
                    "input": request_input,
                    "tools": [tool.as_openai_tool()],
                    "tool_choice": {"type": "function", "name": tool.name},
                    "reasoning": {"effort": self.config.reasoning_effort},
                    "metadata": dict(metadata or {}),
                },
                lambda client: client.responses.create(
                    model=self.config.model,
                    input=request_input,
                    tools=[tool.as_openai_tool()],
                    tool_choice={"type": "function", "name": tool.name},
                    reasoning={"effort": self.config.reasoning_effort},
                    metadata=dict(metadata or {}),
                    store=False,
                ),
            )
            usage = self._usage_from_response(response)
            tool_usage += usage
            tool_latency += latency_ms
            response_id = response.id
            self._record_response(response, latency_ms, usage)

            function_call = next(
                (
                    item
                    for item in response.output
                    if getattr(item, "type", None) == "function_call"
                    and getattr(item, "name", None) == tool.name
                ),
                None,
            )
            if function_call is None:
                request_input.extend(response.output)
                request_input.append(
                    {
                        "role": "user",
                        "content": f"Repair: call the required {tool.name} tool now.",
                    }
                )
                continue

            try:
                arguments = json.loads(function_call.arguments)
                error = next(Draft202012Validator(tool.parameters).iter_errors(arguments), None)
                if error is not None:
                    raise ValueError(error.message)
                if self.journal:
                    self.journal.append(
                        "tool.call",
                        {"name": tool.name, "arguments": arguments},
                    )
                tool_result = dict(tool.handler(arguments))
                if self.journal:
                    self.journal.append(
                        "tool.result",
                        {"name": tool.name, "result": tool_result},
                    )
                request_input.extend(response.output)
                request_input.append(
                    {
                        "type": "function_call_output",
                        "call_id": function_call.call_id,
                        "output": json.dumps(tool_result, ensure_ascii=True),
                    }
                )
                break
            except (json.JSONDecodeError, ValueError, TypeError) as error:
                if self.journal:
                    self.journal.append(
                        "tool.result",
                        {"name": tool.name, "error": str(error), "repair": True},
                    )
                request_input.extend(response.output)
                request_input.append(
                    {
                        "type": "function_call_output",
                        "call_id": function_call.call_id,
                        "output": json.dumps({"ok": False, "error": str(error)}),
                    }
                )
        else:
            raise ToolExecutionError(f"Model did not produce a valid {tool.name} call")

        if tool_result is None:
            raise ToolExecutionError(f"The required {tool.name} call produced no result")
        return ToolRunResult(
            result=tool_result,
            usage=tool_usage,
            latency_ms=tool_latency,
            response_id=response_id,
            continuation_input=tuple(request_input),
        )

    def _parse_response(
        self,
        *,
        request_input: Sequence[Any],
        response_model: type[ResponseT],
        metadata: Mapping[str, str] | None,
    ) -> ModelResult[ResponseT]:
        response, latency_ms = self._request(
            "model.request",
            {
                "model": self.config.model,
                "input": list(request_input),
                "text_format": response_model.__name__,
                "reasoning": {"effort": self.config.reasoning_effort},
                "metadata": dict(metadata or {}),
            },
            lambda client: client.responses.parse(
                model=self.config.model,
                input=list(request_input),
                text_format=response_model,
                reasoning={"effort": self.config.reasoning_effort},
                metadata=dict(metadata or {}),
                store=False,
            ),
        )
        usage = self._usage_from_response(response)
        self._record_response(response, latency_ms, usage)
        if response.output_parsed is None:
            raise ModelClientError("Responses API returned no parsed structured output")
        return ModelResult(
            parsed=response.output_parsed,
            usage=usage,
            latency_ms=latency_ms,
            response_id=response.id,
        )

    def _request(
        self,
        event_type: str,
        request_payload: Mapping[str, Any],
        call: Callable[[OpenAI], Any],
    ) -> tuple[Any, float]:
        deadline = time.monotonic() + self.config.model_timeout_seconds
        last_error: Exception | None = None
        for attempt in range(1, self.config.model_max_attempts + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            if self.journal:
                self.journal.append(
                    event_type,
                    {**request_payload, "attempt": attempt},
                )
            started = time.perf_counter()
            try:
                response = call(self.client.with_options(timeout=remaining))
                return response, (time.perf_counter() - started) * 1000
            except self._RETRYABLE as error:
                last_error = error
                if self.journal:
                    self.journal.append(
                        "model.response",
                        {
                            "attempt": attempt,
                            "error_type": type(error).__name__,
                            "error": str(error),
                            "retryable": True,
                        },
                        latency_ms=(time.perf_counter() - started) * 1000,
                        token_usage=TokenUsage().as_dict(),
                    )
                if attempt == self.config.model_max_attempts:
                    break
                delay = min(0.5 * 2 ** (attempt - 1), max(0.0, remaining - 0.1))
                if delay > 0:
                    time.sleep(delay)

        raise ModelClientError(
            f"Model call failed after {self.config.model_max_attempts} attempts"
        ) from last_error

    def _record_response(self, response: Any, latency_ms: float, usage: TokenUsage) -> None:
        self.total_usage += usage
        if self.journal:
            response_payload = (
                response.model_dump(mode="json", warnings=False)
                if hasattr(response, "model_dump")
                else {"response": repr(response)}
            )
            self.journal.append(
                "model.response",
                response_payload,
                latency_ms=latency_ms,
                token_usage=usage.as_dict(),
            )

    @staticmethod
    def _usage_from_response(response: Any) -> TokenUsage:
        usage = getattr(response, "usage", None)
        if usage is None:
            return TokenUsage()
        return TokenUsage(
            input=int(getattr(usage, "input_tokens", 0) or 0),
            output=int(getattr(usage, "output_tokens", 0) or 0),
            total=int(getattr(usage, "total_tokens", 0) or 0),
        )
