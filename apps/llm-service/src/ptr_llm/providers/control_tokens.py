"Same idempotent control-token neutralization as the TS provider choke point."

import re
from typing import Any

GEMMA4_SPECIAL_TOKENS = [
    "<pad>",
    "<eos>",
    "<bos>",
    "<unk>",
    "<mask>",
    "<|tool>",
    "<tool|>",
    "<|tool_call>",
    "<tool_call|>",
    "<|tool_response>",
    "<tool_response|>",
    '<|"|>',
    "<|think|>",
    "<|channel>",
    "<channel|>",
    "<|turn>",
    "<turn|>",
    "<|image>",
    "<|audio>",
    "<|image|>",
    "<|audio|>",
    "<image|>",
    "<audio|>",
    "<|video|>",
]
CONTROL = re.compile(
    (
        "<\\|[^<>\\s|‹]{0,40}\\|?>|<[^<>\\s|‹]{1,40}\\|>|</?(?:bos|eos|pad|unk|"
        "mask|s|start_of_turn|end_of_turn|start_of_image|end_of_image|imag"
        "e_soft_token|audio_soft_token)>|<</?SYS>>|\\[/?INST\\]"
    ),
    re.IGNORECASE,
)


def neutralize_control_tokens(text: str) -> str:
    return CONTROL.sub(
        lambda match: ("［" if match[0].startswith("[") else "‹") + match[0][1:], text
    )


def neutralize_messages(messages: list[dict[str, str]]) -> list[dict[str, str]]:
    return [
        {"role": m["role"], "content": neutralize_control_tokens(m["content"])} for m in messages
    ]


def neutralize_json_strings(value: Any) -> Any:
    if isinstance(value, str):
        return neutralize_control_tokens(value)
    if isinstance(value, list):
        return [neutralize_json_strings(v) for v in value]
    if isinstance(value, dict):
        return {k: neutralize_json_strings(v) for k, v in value.items()}
    return value
