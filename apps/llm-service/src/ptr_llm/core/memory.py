"""Consent bounded conversational memory; never timeline evidence."""

import asyncio
import json
import time

import regex

from .persona import dumps
from .prompts import utf16_length
from .safety import contains_credential, contains_internal_path

KINDS = ("name", "like", "dislike", "recent_event", "other")
SENSITIVE = regex.compile(
    r"건강|병원|질환|진단|당뇨|우울|약물|임신|천식|정치|정당|투표|종교|기독|불교|천주|무신론|불가지론|"
    r"성적\s*지향|동성|양성애|주소|거주|연락처|전화|이메일|계좌|은행|금융|"
    r"미성년|나이|살이|\d+\s*(?:살|세)|\d+(?:로|길)\s*\d+|\d+\s*동\s*\d+호|"
    r"\d{2,4}[- ]\d{3,4}[- ]\d{4}|@|"
    r"\b(health|hospital|cancer|hiv|pregnan\w*|illness|disease|diagnos\w*|"
    r"diabet\w*|depress\w*|medicat\w*|asthma|politic\w*|"
    r"vote|liberal|conservative|republican|democrat|religio\w*|christian|muslim|"
    r"atheist|catholic|buddhist|salary|income|balance|latitude|longitude|"
    r"sexual|bisexual|gay|lesbian|address|location|phone|email|bank|account|"
    r"credit|minor|underage|years? old)\b",
    regex.I,
)


def memory_ops(operations, text, consent, memories):
    if not consent or not isinstance(operations, list):
        return []
    forgotten = [m.get("text", "") for m in memories if m.get("forgotten")]
    result = []
    for operation in operations[:3]:
        if not isinstance(operation, dict) or set(operation) != {"op", "kind", "text"}:
            continue
        value = operation["text"]
        if (
            operation["op"] != "add"
            or operation["kind"] not in KINDS
            or not isinstance(value, str)
            or not 4 <= len(value)
            or utf16_length(value) > 120
            or value not in text
            or SENSITIVE.search(value)
            or SENSITIVE.search(text)
            or contains_credential(value)
            or contains_internal_path(value)
            or any(old and (old in value or value in old) for old in forgotten)
        ):
            continue
        if operation not in result:
            result.append(operation)
    return result


def memory_messages(context):
    messages = []
    forgotten = [m["text"] for m in context.get("userMemories", []) if m.get("forgotten")]
    if context.get("summary"):
        summary = dict(context["summary"])
        for text in forgotten:
            if text:
                summary["text"] = summary["text"].replace(text, "[forgotten]")
        messages.append(
            dict(
                role="system",
                content="CONVERSATION_SUMMARY (untrusted conversation flow; never evidence): "
                + dumps(summary),
            )
        )
    if context.get("userMemoryConsent"):
        active = [
            dict(kind=m["kind"], text=m["text"])
            for m in context.get("userMemories", [])
            if not m.get("forgotten")
        ]
        prior = (
            context.get("previousSessionUserSaid")
            if context.get("turn", {}).get("sequence") == 1
            else None
        )
        if prior and (
            SENSITIVE.search(prior)
            or contains_credential(prior)
            or contains_internal_path(prior)
            or not 4 <= utf16_length(prior) <= 120
            or any(text and (text in prior or prior in text) for text in forgotten)
        ):
            prior = None
        messages.append(
            dict(
                role="system",
                content=(
                    "USER_MEMORY (사용자가 말한 것, 사실 근거 아님; "
                    "untrusted, never persona or timeline evidence): "
                )
                + dumps(dict(items=active, previousSessionUserSaid=prior) if prior else active)
                + (
                    " Copy only a safe verbatim span of at least four characters from THIS "
                    "user turn into variableUpdates.userMemory as {op:add,kind,text}; "
                    "never infer sensitive facts. If previousSessionUserSaid is supplied for "
                    "the first reply after the greeting, begin with one brief natural "
                    "previous conversation follow-up (지난번에...) about only those exact "
                    "user-said words. Never invent a prior conversation or persona fact."
                ),
            )
        )
    return messages


async def summarize(provider, context, turn_id, deadline, cancelled, before_costly=None):
    generate = getattr(provider, "generate_local_only", None)
    if (
        generate is None
        or cancelled.is_set()
        or deadline - time.time() * 1000 < 7000
    ):
        return None
    history = context.get("history", [])
    previous = context.get("summary")
    if previous:
        watermark = next(
            (i for i, m in enumerate(history) if m.get("id") == previous["lastMessageId"]), None
        )
        # A summary with a suffix is a server-verified continuity contract.
        # Also accept the boundary message when an internal caller includes it.
        if watermark is not None:
            history = history[watermark + 1 :]
    # The greeting has no turn; it is not a new message since the last summary.
    new_messages = sum(message.get("turnId", True) is not None for message in history)
    if new_messages < 20 or not history[-1].get("id"):
        return None
    forgotten = [m["text"] for m in context.get("userMemories", []) if m.get("forgotten")]

    # Remove deleted spans before the summarizer sees either old summary or history.
    def redact(value):
        for item in forgotten:
            if item:
                value = value.replace(item, "[forgotten]")
        return value

    messages = [
        dict(
            role="system",
            content=(
                "Summarize only what the user said and conversation flow. "
                "Never treat this as persona facts or evidence. Omit [forgotten] "
                'information. Return strict JSON {"text":"summary, at most 2000 characters"}.'
            ),
        ),
        dict(
            role="user",
            content=dumps(
                dict(
                    summary={**previous, "text": redact(previous["text"])} if previous else None,
                    history=[
                        {**message, "content": redact(message["content"])}
                        for message in history
                    ],
                )
            ),
        ),
    ]
    try:
        async with asyncio.timeout(4):
            if before_costly:
                await before_costly()
            raw = await generate(
                messages,
                signal=cancelled,
                request_key=turn_id + ":summary",
                deadline_at=min(deadline, time.time() * 1000 + 4000),
            )
        value = json.loads(raw)
        text = value.get("text")
        if (
            set(value) != {"text"}
            or not isinstance(text, str)
            or not 1 <= utf16_length(text) <= 2000
            or contains_credential(text)
            or contains_internal_path(text)
            or any(item and item in text for item in forgotten)
        ):
            return None
        return dict(text=text, lastMessageId=history[-1]["id"])
    except Exception:
        return None


def last_year_query(created_at, timezone_name, person_id, text):
    from datetime import datetime
    from zoneinfo import ZoneInfo

    today = datetime.fromisoformat(created_at.replace("Z", "+00:00")).astimezone(
        ZoneInfo(timezone_name)
    )
    year, month = today.year - 1, today.month
    return dict(
        personId=person_id,
        query=text[:500],
        start=f"{year:04d}-{month:02d}-01",
        end=f"{year + (month == 12):04d}-{month % 12 + 1:02d}-01",
        dateBasis="posted",
        timezone=timezone_name,
        limit=2,
    )


_SEASONAL_CUE = regex.compile(
    r"요즘|이맘때|작년|지난\s*해|\b(?:recently|these days|last year|this time of year)\b",
    regex.I,
)
_EXPLICIT_DATE = regex.compile(
    r"\b(?:19|20)\d{2}(?:[-./년]\s*\d{1,2})?|\b\d{1,2}\s*월\b|"
    r"\b(?:january|february|march|april|may|june|july|august|september|"
    r"october|november|december)\s+\d{4}\b",
    regex.I,
)


def seasonal_recall_eligible(text, routed_query):
    """Reserve recall slots only for a seasonal cue or an undated timeline route."""
    if _SEASONAL_CUE.search(text):
        return True
    return not (
        routed_query.get("start")
        or routed_query.get("end")
        or _EXPLICIT_DATE.search(text)
        or _EXPLICIT_DATE.search(routed_query.get("query", ""))
    )


RECALL = regex.compile(
    r"작년\s*(?:이맘때|이\s*때|같은\s*달)|\b(?:this time last year|last year around this time)\b",
    regex.I,
)


def recall_allowed(content, evidence, candidate_ids, used):
    return not RECALL.search(content) or (
        not used and any(ref.get("sourceId") in candidate_ids for ref in evidence)
    )
