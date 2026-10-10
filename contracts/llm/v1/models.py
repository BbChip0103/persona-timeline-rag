"""Pydantic adapters generated from the one versioned JSON Schema corpus.

No coercion or unknown fields. All validators use the same schema as TypeScript.
The dynamic root adapters deliberately avoid a second hand-maintained wire policy.
"""
from __future__ import annotations
import json
import math
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from jsonschema import Draft202012Validator, FormatChecker, validators
from pydantic import RootModel, model_validator

SCHEMA = json.loads(Path(__file__).with_name('schema.json').read_text())
FORMATS = FormatChecker()
@FORMATS.checks('timezone', raises=(ZoneInfoNotFoundError, ValueError))
def _timezone(value: Any) -> bool:
    if not isinstance(value, str):
        return True
    ZoneInfo(value)
    return True

def _bytes(validator: Any, maximum: int, instance: Any, schema: Any):
    from jsonschema.exceptions import ValidationError
    if isinstance(instance, str) and len(instance.encode('utf-8')) > maximum:
        yield ValidationError('UTF8 byte limit exceeded')

Validator = validators.extend(Draft202012Validator, {'x-maxUtf8Bytes': _bytes})

def validate_wire(name: str, value: Any) -> dict[str, Any]:
    def finite(v: Any) -> bool:
        if isinstance(v, float):
            return math.isfinite(v)
        if isinstance(v, dict):
            return all(finite(item) for item in v.values())
        if isinstance(v, list):
            return all(finite(item) for item in v)
        return True
    if name not in SCHEMA['$defs'] or not finite(value) or not isinstance(value, dict):
        raise ValueError('INVALID_WIRE_CONTRACT')
    document = {**SCHEMA, '$ref': f'#/$defs/{name}'}
    if not Validator(document, format_checker=FORMATS).is_valid(value):
        raise ValueError('INVALID_WIRE_CONTRACT')
    return value

def _adapter(name: str):
    class Adapter(RootModel[dict[str, Any]]):
        @model_validator(mode='before')
        @classmethod
        def strict_wire(cls, value: Any) -> Any:
            return validate_wire(name, value)
    Adapter.__name__ = name
    return Adapter

MODELS = {name: _adapter(name) for name in SCHEMA['$defs'] if name.endswith(('Request', 'Response')) or name in ('Grant', 'Binding', 'Context', 'Reply')}
globals().update(MODELS)
