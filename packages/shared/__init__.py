"""Shared runtime contracts for Teacher Brain."""

from packages.shared.schema import (
    SharedSchemaError,
    get_validator,
    load_schema,
    validate_payload,
)

__all__ = [
    "SharedSchemaError",
    "get_validator",
    "load_schema",
    "validate_payload",
]
