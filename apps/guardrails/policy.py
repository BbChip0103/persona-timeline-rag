"""Transferred synthetic-test-pinned reply-guard-v7 domain policy.

regex supports JS Unicode properties and variable-width lookbehind. Word boundaries
are explicitly ECMAScript ASCII word boundaries, not Python's Unicode boundaries.
"""

import json
from pathlib import Path
from typing import Any

import regex

_ROOT = Path(__file__).parent
_POLICY = json.loads((_ROOT / "reply_policy.json").read_text())
REVISION = _POLICY["revision"]
VOICES = json.loads((_ROOT / "voice_texts.json").read_text())
_BOUNDARY = r"(?:(?<![A-Za-z0-9_])(?=[A-Za-z0-9_])|(?<=[A-Za-z0-9_])(?![A-Za-z0-9_]))"


def compile_js(item):
    source = item["source"].replace(r"\b", _BOUNDARY).replace(r"\w", "[A-Za-z0-9_]")
    return regex.compile(source, regex.I if "i" in item["flags"] else 0)


PATTERNS: dict[str, Any] = {
    key: [compile_js(item) for item in value]
    if isinstance(value, list)
    else compile_js(value)
    if isinstance(value, dict)
    else value
    for key, value in _POLICY["patterns"].items()
}
# Transferred verbatim from v7, including question/emoji sentence exceptions.
SENTENCES = regex.compile(
    r"\s*\n\s*|(?<=[.!?。！？~…]|\p{Extended_Pictographic}️?|\p{Regional_Indicator})(?:\s+|(?<=[!?~…])(?=[\p{L}\p{N}])|(?<=\.)(?=[가-힣]))(?![\p{Extended_Pictographic}\p{Regional_Indicator}])"
)
QUESTION = regex.compile(r"[?？]\s*\p{Extended_Pictographic}*️?\s*$")


def any_match(name, text):
    return any(pattern.search(text) for pattern in PATTERNS[name])


def voice(key, language, level):
    return VOICES[key][level if regex.match(r"^ko(?:$|[-_])", language, regex.I) else "en"]


def reply_decision(reply, metadata):
    utterance = metadata["utterance"]
    real_person = metadata["realPerson"]
    language = metadata["language"]
    level = metadata.get("level", "polite")
    identity = any_match("IDENTITY_QUESTION", utterance) and (
        not PATTERNS["ART_UTTERANCE"].search(utterance)
        or regex.search(r"(?:너|넌|당신|니가|네가)|\byou\b", utterance, regex.I)
    )

    def replace(reason, key):
        return {"reason": reason, "content": voice(key, language, level)}

    sentences = [sentence for sentence in SENTENCES.split(reply.strip()) if sentence]
    kept = [
        sentence
        for sentence in sentences
        if QUESTION.search(sentence) or not any_match("META_GAP", sentence)
    ]
    if len(kept) != len(sentences):
        text = " ".join(kept).strip()
        if regex.search(r"[\p{L}\p{N}]", text):
            return reply_decision(text, metadata) or {
                "reason": "meta_talk",
                "content": text,
                "edited": True,
            }
        if identity:
            return replace("missing_ai_disclosure", "identity")
        if real_person and any_match("PRIVATE_QUESTION", utterance):
            return replace("private_life", "decline_private")
        return replace("meta_talk", "fallback")
    art = PATTERNS["ART_UTTERANCE"].search(utterance) or PATTERNS["ART_REPLY"].search(reply)
    if any_match("HUMAN_CLAIM", reply) or (not art and any_match("BARE_DENIAL", reply)):
        return replace("human_impersonation", "identity" if identity else "fallback")
    if identity and not any_match("AI_ACKNOWLEDGED", reply):
        return replace("missing_ai_disclosure", "identity")
    if real_person:
        if any_match("PRIVATE_QUESTION", utterance):
            return replace("private_life", "identity" if identity else "decline_private")
        checked = (
            PATTERNS["PAST_HOME"].sub(" ", reply)
            if PATTERNS["ORIGIN_QUESTION"].search(utterance)
            else reply
        )
        if any_match("PRIVATE_REPLY", checked):
            return replace("private_life", "identity" if identity else "fallback")
    if (
        not identity
        and not art
        and (
            (any_match("AI_ACKNOWLEDGED", reply) and any_match("NOT_HAVING", reply))
            or (real_person and any_match("BACKGROUND_DISOWNED", reply))
        )
    ):
        return replace("background_denial", "fallback")
    return None


CATEGORIES = (
    "prompt_injection",
    "sexual",
    "violence_gore",
    "self_harm",
    "hate_harassment",
    "illegal_dangerous",
    "private_info",
)
REFUSALS = ("sexual", "violence_gore", "illegal_dangerous", "hate_harassment", "private_info")


def input_decision(metadata):
    scores, thresholds = metadata["probabilities"], metadata["thresholds"]
    fired = [
        category
        for category in CATEGORIES
        if category in scores and scores[category] >= thresholds[category]
    ]
    if "self_harm" in fired:
        return {"action": "support", "category": "self_harm", "fired": fired}
    refusals = [category for category in REFUSALS if category in fired]
    if refusals:
        return {
            "action": "refuse",
            "category": max(refusals, key=lambda category: scores[category]),
            "fired": fired,
        }
    if "prompt_injection" in fired:
        return {"action": "deflect", "category": "prompt_injection", "fired": fired}
    return {"action": "none", "fired": fired}


_INPUT_RULES = json.loads((_ROOT / "input_rules.json").read_text())
INPUT_RULES = [compile_js(item) for item in _INPUT_RULES["patterns"].values()]


def rules_decision(text):
    """Frozen deterministic isSensitive boundary, not a Jev safety assessment."""
    if any(pattern.search(text) for pattern in INPUT_RULES):
        return {"action": "refuse", "category": "private_info", "fired": ["private_info"]}
    return {"action": "none", "fired": []}
