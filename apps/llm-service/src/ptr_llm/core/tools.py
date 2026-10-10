"""Native single-tool dispatch; scope and JSON-action transcript stay application-owned."""

from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from langgraph.prebuilt import ToolNode
from langgraph.runtime import Runtime
from pydantic import BaseModel, ConfigDict, field_validator

from .errors import CoreError
from .langchain import private_ainvoke
from .safety import contains_credential, contains_internal_path


class TimelineSearchArguments(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")
    query: str

    @field_validator("query")
    @classmethod
    def public_query(cls, value: str) -> str:
        # Python code-point bounds preserve the prior strict JSON action, including
        # escaped lone surrogates; pydantic-core length constraints reject those.
        if (
            not value.strip()
            or len(value) > 500
            or contains_credential(value)
            or contains_internal_path(value)
        ):
            raise ValueError("Invalid tool query")
        return value


async def timeline_tool(query: str, search: Any, check: Any) -> list[dict]:
    # Validate before SDK dispatch, including its unknown-tool recovery behavior.
    # Trusted person/date/license are captured by search, never model arguments.
    try:
        arguments = TimelineSearchArguments(query=query)
    except ValueError:
        raise CoreError("INVALID_INPUT") from None
    check()

    async def execute(query: str):
        check()
        found = await search(query)
        check()
        # Only an opaque completion marker is tool content; original evidence is
        # an in-memory artifact and never a new model-visible wire transcript.
        return "timeline_search completed", found

    tool = StructuredTool.from_function(
        coroutine=execute,
        name="timeline_search",
        description="Search the request's trusted timeline scope.",
        args_schema=TimelineSearchArguments,
        response_format="content_and_artifact",
    )
    node = ToolNode([tool], handle_tool_errors=False)
    result = await private_ainvoke(
        node,
        [
            {
                "name": tool.name,
                "args": arguments.model_dump(),
                "id": "timeline",
                "type": "tool_call",
            }
        ],
        runtime=Runtime(),
    )
    check()
    messages = result.get("messages", []) if isinstance(result, dict) else result
    if (
        not isinstance(messages, list)
        or len(messages) != 1
        or not isinstance(messages[0], ToolMessage)
        or messages[0].status != "success"
        or not isinstance(messages[0].artifact, list)
    ):
        raise CoreError("TURN_FAILED", "TOOL_RESULT_INVALID")
    return messages[0].artifact
