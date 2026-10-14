"""Synthetic PublicEndpoint matching OpenRouter's documented ZDR response schema.

https://github.com/OpenRouterTeam/docs/blob/59835a266951509516b58cfe07070e3474a4f798/openapi/openapi.yaml#L26898-L27307
"""

from typing import Any


def zdr_endpoint(
    *,
    model_id: str = "google/gemma-4-26b-a4b-it",
    provider_name: str = "DeepInfra",
    tag: str = "deepinfra",
) -> dict[str, Any]:
    return {
        "name": f"{provider_name}: Synthetic model",
        "model_id": model_id,
        "model_name": "Synthetic model",
        "context_length": 8192,
        "pricing": {"prompt": "0.0000001", "completion": "0.0000005"},
        "provider_name": provider_name,
        "tag": tag,
        "quantization": "fp16",
        "max_completion_tokens": 4096,
        "max_prompt_tokens": 8192,
        "supported_parameters": [],
        "supports_tool_choice": {
            "none": True,
            "auto": True,
            "required": True,
            "function": True,
        },
        "uptime_last_30m": 99.5,
        "uptime_last_5m": 100,
        "uptime_last_1d": 99.8,
        "supports_implicit_caching": True,
        "native_tools": {},
        "latency_last_30m": {"p50": 25.5, "p75": 35.2, "p90": 48.7, "p99": 85.3},
        "throughput_last_30m": {"p50": 45.2, "p75": 38.5, "p90": 28.3, "p99": 15.1},
    }
