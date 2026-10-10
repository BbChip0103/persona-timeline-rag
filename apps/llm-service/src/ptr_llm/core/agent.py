"""Native Python LangGraph JSON-action loop; no durable outer graph state."""

import copy
from contextlib import nullcontext
from typing import Any, TypedDict

import regex
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

from .errors import CoreError
from .persona import dumps
from .prompts import POLICY, build_experiment_context
from .protocol import parse_agent_response, variables
from .safety import contains_credential, contains_internal_path
from .texts import is_korean, speech_level, utterance_language, voice_text

AGENT_RUNTIME_REVISION = "langgraph-json-action-v1"
AGENT_PROMPT_REVISION = "character-agent-context-v12-evidence-cap"


class AgentState(TypedDict):
    run: dict


class AgentContext(TypedDict):
    stages: dict[str, Any]


def _compiled_agent_graph():
    builder = StateGraph(AgentState, context_schema=AgentContext)

    def dispatch(name):
        async def invoke(state, runtime: Runtime[AgentContext]):
            return await runtime.context["stages"][name](state)

        return invoke

    for name in ("context", "generate", "tool", "finalize"):
        builder.add_node(name, dispatch(name))
    builder.add_edge(START, "context")
    builder.add_edge("context", "generate")
    builder.add_conditional_edges(
        "generate",
        lambda s: "tool" if s["run"]["response"].get("function") else "finalize",
        {"tool": "tool", "finalize": "finalize"},
    )
    builder.add_edge("tool", "context")
    builder.add_edge("finalize", END)
    return builder.compile()


_AGENT_GRAPH = _compiled_agent_graph()


def trim_to_sentence(text, cap=400):
    if len(text) < cap:
        return text
    matches = list(
        regex.finditer(
            r"""(?:[.!?。！？~…]+["'”’)\]]*|\p{Extended_Pictographic}\uFE0F?)(?=\s|$)""", text
        )
    )
    return text[: matches[-1].end()].rstrip() if matches else text


def _remember(first, items):
    saved = {s["id"]: s for s in first}
    for s in items:
        if s["id"] not in saved:
            saved[s["id"]] = copy.deepcopy(s)
    return list(saved.values())


def _candidates(first, items):
    saved = {s["id"]: s for s in first}
    ids = list(dict.fromkeys(s["id"] for s in items))[:20]
    return [saved[sid] for sid in ids]


async def run_character_agent(
    *,
    provider,
    persona,
    history,
    text,
    sources,
    variables_state=None,
    cancelled=None,
    max_tool_rounds=2,
    search=None,
    policy_note=None,
    lore=None,
    request_key=None,
    deadline_at=None,
    before_costly=None,
    telemetry=None,
):
    persona = copy.deepcopy(persona)
    history = copy.deepcopy(history)
    sources = copy.deepcopy(sources)
    lore = copy.deepcopy(lore)
    if type(max_tool_rounds) is not int or not 0 <= max_tool_rounds <= 10:
        raise CoreError("INVALID_INPUT")
    language = utterance_language(text, persona["language"])
    level = speech_level(persona)
    language_name = (
        "Korean"
        if is_korean(language)
        else "English"
        if regex.match(r"^en(?:$|[-_])", language, regex.I)
        else language
    )

    def fallback():
        return {
            "status": "insufficient_evidence",
            "message": voice_text("fallback", language, level),
            "evidenceRefs": [],
            "variableUpdates": {},
        }

    def check():
        if cancelled is not None and cancelled.is_set():
            raise CoreError("TURN_FAILED", "TURN_ABORTED")

    first = _remember([], sources)
    initial = {
        "iteration": 0,
        "variables": variables(variables_state),
        "transcript": [],
        "called": [],
        "firstSeen": first,
        "sources": _candidates(first, sources),
        "steps": [],
        "modelCalls": 0,
        "toolCalls": 0,
        "upstreams": [],
    }

    async def context(state):
        check()
        run = state["run"]
        safety = POLICY["EXPERIMENT_POLICY"].split("TIMELINE_JSON_REPLY:")[0]
        after = [
            {
                "role": "system",
                "content": "AGENT_STATE_JSON_DATA "
                + dumps(
                    dict(
                        run["variables"],
                        replyLanguage=language_name,
                        speechLevel="반말" if level == "casual" else "해요체",
                    )
                ),
            }
        ]
        if lore:
            after.append(lore)
        after.append(
            {
                "role": "system",
                "content": "AGENT_TOOLS_JSON_DATA "
                + dumps(
                    ["timeline_search"] if search and run["iteration"] < max_tool_rounds else []
                ),
            }
        )
        ctx = build_experiment_context(
            persona,
            history,
            text,
            run["sources"],
            policy=safety + POLICY["recollectionVoice"] + POLICY["protocol"],
            policy_note=policy_note,
            after_history=after,
            after_user=run["transcript"],
        )
        if len(ctx["messages"]) > 64:
            raise CoreError("CONTEXT_LIMIT")
        step = {
            "phase": "context",
            "iteration": run["iteration"],
            "sourceIds": [s["id"] for s in ctx["sources"]],
        }
        if ctx["omittedSourceIds"]:
            step["omittedSourceIds"] = ctx["omittedSourceIds"]
        return {"run": dict(run, context=ctx, steps=run["steps"] + [step])}

    async def generate(state):
        check()
        run = state["run"]
        upstream = "unknown"

        def served(name):
            nonlocal upstream
            if isinstance(name, str) and regex.fullmatch(r"[a-z0-9_-]{1,40}", name):
                upstream = name

        if before_costly:
            await before_costly()
        raw = await provider.generate(
            run["context"]["messages"],
            signal=cancelled,
            request_key=request_key,
            deadline_at=deadline_at,
            priority=1 if run["iteration"] else 0,
            on_served=served,
        )
        check()
        limitation = None
        try:
            response = parse_agent_response(raw)
        except CoreError:
            response = fallback()
            limitation = "AGENT_REPLY_INVALID"
        if "function" not in response:
            response["message"] = trim_to_sentence(response["message"])
        if any(
            contains_internal_path(v)
            for v in [
                response["message"],
                response.get("reasoning", ""),
                response["variableUpdates"].get("conversationTopic", ""),
            ]
        ):
            raise CoreError("TURN_FAILED", "REPLY_REJECTED")
        if "function" in response:
            query = response["function"]["arguments"]["query"]
            if contains_credential(query) or contains_internal_path(query):
                raise CoreError("TURN_FAILED", "TOOL_QUERY_REJECTED")
            if not search:
                response = fallback()
                limitation = "AGENT_TOOL_UNAVAILABLE"
            elif run["iteration"] >= max_tool_rounds:
                raise CoreError("TURN_FAILED", "TOOL_LIMIT")
            elif query in run["called"]:
                raise CoreError("TURN_FAILED", "TOOL_REPEATED")
        return {
            "run": dict(
                run,
                response=response,
                serviceLimitation=limitation,
                upstreams=run["upstreams"] + [upstream],
                modelCalls=run["modelCalls"] + 1,
                steps=run["steps"] + [{"phase": "model", "iteration": run["iteration"]}],
            )
        }

    async def tool(state):
        check()
        run = state["run"]
        response = run["response"]
        query = response["function"]["arguments"]["query"]
        found = copy.deepcopy(await search(query))
        check()
        first = _remember(run["firstSeen"], found)
        selected = _candidates(first, found + run["sources"])
        transcript = run["transcript"] + [
            {
                "role": "assistant",
                "content": dumps(
                    {
                        "status": response["status"],
                        "message": "",
                        "evidenceRefs": [],
                        "variableUpdates": {},
                        "function": response["function"],
                    }
                ),
            },
            {
                "role": "user",
                "content": "TOOL_RESULT_JSON_DATA "
                + dumps(
                    {
                        "name": "timeline_search",
                        "sourceIds": [s["id"] for s in found],
                        "empty": not found,
                        "availableSourceIds": [s["id"] for s in selected],
                    }
                ),
            },
        ]
        return {
            "run": dict(
                run,
                firstSeen=first,
                sources=selected,
                transcript=transcript,
                called=run["called"] + [query],
                toolCalls=run["toolCalls"] + 1,
                iteration=run["iteration"] + 1,
                steps=run["steps"]
                + [{"phase": "tool", "iteration": run["iteration"], "query": query}],
            )
        }

    async def finalize(state):
        check()
        run = state["run"]
        response = run["response"]
        agent = {
            "revision": AGENT_RUNTIME_REVISION,
            "promptRevision": AGENT_PROMPT_REVISION,
            "modelCalls": run["modelCalls"],
            "toolCalls": run["toolCalls"],
            "variables": run["variables"],
            "steps": run["steps"],
            "validator": "disabled",
        }
        if response.get("reasoning"):
            agent["decisionSummary"] = response["reasoning"]
        result = {
            "response": response,
            "upstreams": run["upstreams"],
            "rawReply": dumps(
                {
                    "status": response["status"],
                    "answer": response["message"],
                    "evidenceRefs": response["evidenceRefs"],
                }
            ),
            "context": run["context"],
            "agent": agent,
        }
        if run.get("serviceLimitation"):
            result["serviceLimitation"] = run["serviceLimitation"]
        return {"run": dict(run, result=result)}

    stages = {}
    for name, node in [
        ("context", context),
        ("generate", generate),
        ("tool", tool),
        ("finalize", finalize),
    ]:

        def observed(fn, stage_name):
            async def invoke(state):
                observation = (
                    telemetry.observation(
                        "agent-" + stage_name,
                        as_type="generation" if stage_name == "generate" else "span",
                        metadata={"iteration": state["run"]["iteration"]},
                    )
                    if telemetry
                    else nullcontext()
                )
                with observation:
                    return await fn(state)

            return invoke

        stages[name] = observed(node, name)
    result = await _AGENT_GRAPH.ainvoke(
        {"run": initial},
        {"recursion_limit": 3 * (max_tool_rounds + 1) + 2},
        context={"stages": stages},
    )
    check()
    return result["run"]["result"]
