from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from jsonschema.exceptions import best_match

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_DIRECTORY = REPOSITORY_ROOT / "packages" / "shared" / "schemas"


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


@lru_cache(maxsize=None)
def get_validator(schema_name: str) -> Draft202012Validator:
    return Draft202012Validator(load_schema(schema_name))


def validate_payload(schema_name: str, payload: object) -> None:
    error = best_match(get_validator(schema_name).iter_errors(payload))
    if error is None:
        return

    raise SharedSchemaError(
        schema_name=schema_name,
        message=error.message,
        path=list(error.absolute_path),
    )
