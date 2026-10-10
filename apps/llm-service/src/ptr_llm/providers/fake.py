"""Deterministic synthetic transport; it never claims real-person activity."""

import asyncio
import hashlib
import json
import math
from typing import Any

from .common import check_cancel, js_json


class FakeTextProvider:
    def __init__(self):
        self.calls = 0

    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        signal: asyncio.Event | None = None,
        on_served: Any = None,
        **_: Any,
    ) -> str:
        check_cancel(signal)
        self.calls += 1
        if on_served:
            on_served("fake")
        agent = any(m["role"] == "system" and "AGENT_JSON_REPLY" in m["content"] for m in messages)
        timeline = any(
            m["role"] == "system" and "TIMELINE_JSON_REPLY" in m["content"] for m in messages
        )
        if agent or timeline:
            input_message = next(
                (
                    m
                    for m in messages
                    if m["role"] == "user"
                    and m["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA ")
                ),
                None,
            )
            try:
                data = (
                    json.loads(input_message["content"][len("UNTRUSTED_EVIDENCE_JSON_DATA ") :])
                    if input_message
                    else []
                )
            except ValueError:
                data = []
            field = "quoteCandidate" if agent else "caption"
            source = (
                next(
                    (
                        s
                        for s in data
                        if isinstance(s, dict)
                        and isinstance(s.get("sourceId"), str)
                        and isinstance(s.get(field), str)
                        and s[field]
                    ),
                    None,
                )
                if isinstance(data, list)
                else None
            )
            refs = [{"sourceId": source["sourceId"], "quote": source[field]}] if source else []
            if agent:
                return js_json(
                    {
                        "status": "answered" if source else "insufficient_evidence",
                        "message": "합성 자료의 캡션을 참고해 이야기해요."
                        if source
                        else "연구용 AI 시뮬레이션이에요. 편하게 이야기해 주세요.",
                        "evidenceRefs": refs,
                        "variableUpdates": {},
                    }
                )
            return js_json(
                {
                    "status": "answered" if source else "insufficient_evidence",
                    "answer": "",
                    "evidenceRefs": refs,
                }
            )
        last = next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
        variant = hashlib.sha256(last.encode()).digest()[0] % 3
        return [
            "이 대화는 연구용 AI 시뮬레이션이에요. 어떤 이야기를 나눠 볼까요?",
            "좋아요! 편하게 이야기해 주세요. 실제 활동에 대한 확인은 별도의 자료가 필요해요.",
            "반가워요! 연구용 AI 페르소나와 천천히 대화를 이어 가요.",
        ][variant]


class FakeEmbeddingProvider:
    model = "synthetic/hash-1536-v1"
    dimensions = 1536

    def __init__(self):
        self.calls = 0

    async def embed(
        self, inputs: list[str], *, signal: asyncio.Event | None = None, **_: Any
    ) -> list[list[float]]:
        check_cancel(signal)
        self.calls += 1
        result = []
        for text in inputs:
            digest = hashlib.sha256(text.encode()).digest()
            vector = [(digest[i % 32] - 127.5) / 127.5 for i in range(self.dimensions)]
            norm = math.sqrt(sum(v * v for v in vector))
            result.append([v / norm for v in vector])
        return result
