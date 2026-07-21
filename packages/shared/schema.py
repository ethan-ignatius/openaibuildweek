from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from jsonschema.exceptions import best_match
from referencing import Registry, Resource

SCHEMA_DIRECTORY = Path(__file__).resolve().parent / "schemas"


class SharedSchemaError(ValueError):
    """Raised when a payload does not conform to a checked-in shared schema."""

    def __init__(self, schema_name: str, message: str, path: list[str | int]) -> None:
        super().__init__(message)
        self.schema_name = schema_name
        self.message = message
        self.path = path


@lru_cache(maxsize=None)
def load_schema(schema_name: str) -> dict[str, Any]:
    schema_path = SCHEMA_DIRECTORY / f"{schema_name}.schema.json"
    if not schema_path.is_file():
        raise FileNotFoundError(f"Shared schema does not exist: {schema_path}")

    with schema_path.open(encoding="utf-8") as schema_file:
        schema: dict[str, Any] = json.load(schema_file)

    Draft202012Validator.check_schema(schema)
    return schema


@lru_cache(maxsize=1)
def schema_registry() -> Registry:
    registry = Registry()
    for schema_path in sorted(SCHEMA_DIRECTORY.glob("*.schema.json")):
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        resource = Resource.from_contents(schema)
        registry = registry.with_resource(schema["$id"], resource)
    return registry


@lru_cache(maxsize=None)
def get_validator(schema_name: str) -> Draft202012Validator:
    return Draft202012Validator(
        load_schema(schema_name),
        registry=schema_registry(),
        format_checker=FormatChecker(),
    )


def validate_payload(schema_name: str, payload: object) -> None:
    error = best_match(get_validator(schema_name).iter_errors(payload))
    if error is None:
        return

    raise SharedSchemaError(
        schema_name=schema_name,
        message=error.message,
        path=list(error.absolute_path),
    )
