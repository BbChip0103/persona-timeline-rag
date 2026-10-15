"""Regenerate compile-time TypeScript types from the single wire JSON Schema."""

import json
from pathlib import Path

HERE = Path(__file__).parent
schema = json.loads((HERE / "schema.json").read_text())


def ts(node):
    if "$ref" in node:
        return node["$ref"].rsplit("/", 1)[-1]
    if "const" in node:
        return json.dumps(node["const"])
    if "enum" in node:
        return " | ".join(json.dumps(value) for value in node["enum"])
    if "oneOf" in node or "anyOf" in node:
        return "(" + " | ".join(ts(value) for value in node.get("oneOf", node.get("anyOf"))) + ")"
    kind = node.get("type")
    if kind == "object":
        required = node.get("required", [])
        return (
            "{"
            + "; ".join(
                json.dumps(key) + ("" if key in required else "?") + ": " + ts(value)
                for key, value in node["properties"].items()
            )
            + "}"
        )
    if kind == "array":
        return "Array<" + ts(node["items"]) + ">"
    return {
        "string": "string",
        "integer": "number",
        "number": "number",
        "boolean": "boolean",
        "null": "null",
    }[kind]


(HERE / "generated.ts").write_text(
    "// GENERATED from schema.json by generate.py. Do not maintain a second wire policy.\n"
    + "\n".join(
        "export type " + key + " = " + ts(value) + ";" for key, value in schema["$defs"].items()
    )
    + "\n"
)
