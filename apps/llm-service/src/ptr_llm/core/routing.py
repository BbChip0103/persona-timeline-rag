"""Frozen rules, bounded classifiers and multi-window safety decisions."""

import asyncio

import regex

from .classifier_timeout import bounded
from .context import is_post_memory
from .policy import CATEGORIES, input_decision, js_search, rules_decision
from .safety import is_biographical

DEFAULT_SAFETY_THRESHOLDS = {k: 0.5 for k in CATEGORIES} | {
    "self_harm": 0.2,
    "illegal_dangerous": 0.6,
}


def sensitive(text):
    return rules_decision(text)["action"] != "none"


def is_reentry(text):
    # Only a whole-message invitation to resume qualifies. A past-activity
    # question may contain the same words and must keep its timeline route.
    if js_search(r"언제|어디|여행|공연|전시|책|먹었|갔|봤|했던|읽|카페", text, regex.I):
        return False
    return bool(js_search(
        r"^\s*(?=\S)(?:다시\s*왔(?:어|어요|습니다)(?:[.!?~]\s*)?)?"
        r"(?:지난번\s*(?:얘기|대화|이야기)(?:\s*(?:이어갈까|이어갈까요|이어가자|이어가요|"
        r"계속하자|계속할까|계속해요|이어서"
        r"(?:\s*(?:하자|할까|해요|얘기하자|이야기하자))?))?"
        r"|이어서\s*(?:얘기|이야기|대화)\s*(?:하자|할까))?"
        r"[.!?~\s]*$", text, regex.I
    )) and bool(js_search(r"지난번|이어서|다시\s*왔", text, regex.I))


def intent_signals(
    text,
    context,
    *,
    explicit_intent=None,
    explicit_timeline=False,
    rag_condition=None,
    previous_timeline=False,
):
    creative = context["creative"]
    strong = (
        explicit_timeline
        or not creative
        and (
            is_biographical(text)
            or is_post_memory(text)
            or context["followUp"]
            and previous_timeline
        )
    )
    cue = js_search(
        (
            "\\b(when|where|visited|trip|travel|activity|posted|yesterday|last year|"
            "in 20\\d\\d|did you|were you|have you|your past|your family)\\b|\\d{4}[-년]"
            "|언제|어디|활동|여행|방문|그날|게시|지난|어제|그 여행|무슨 일|"
            "뭐 했|뭘 했|갔어|했어|가족"
        ),
        context["query"] if context["followUp"] else text,
        regex.I,
    )
    image = bool(rag_condition) and js_search(
        r"image|photo|picture|visual|이미지|사진|그림|작품|의도|분위기", text, regex.I
    )
    return {
        "sensitive": sensitive(text),
        "explicitIntent": explicit_intent,
        "creative": creative,
        "reentry": is_reentry(text) and not explicit_timeline,
        "strongTimeline": bool(strong),
        "weakTimeline": bool(not creative and (cue or image)),
    }


def rule_intent(signals):
    if signals["sensitive"] or signals.get("explicitIntent") == "unsupported":
        return "unsupported"
    if signals.get("explicitIntent") == "clarification":
        return "clarification"
    if (signals.get("reentry") and not signals["strongTimeline"]
            and signals.get("explicitIntent") != "timeline"):
        return "small_talk"
    if signals["strongTimeline"] or signals["weakTimeline"]:
        return "timeline"
    return signals.get("explicitIntent") or "small_talk"


def needs_classifier(signals):
    return not any(
        [
            signals["sensitive"],
            signals.get("explicitIntent"),
            signals["creative"],
            signals["strongTimeline"],
            signals.get("reentry"),
        ]
    )


def fallback_reason(error, cancelled=None):
    if cancelled and cancelled.is_set():
        return "aborted"
    if isinstance(error, TimeoutError):
        return "timeout"
    return {
        "BUDGET_EXCEEDED": "budget",
        "DECISION_SUBCAP": "subcap",
        "REQUEST_UNRESOLVED_NO_RESUBMIT": "unresolved",
    }.get(getattr(error, "code", ""), "error")


def safety_windows(text):
    windows = [text[:500]]
    end = 500
    while end < len(text):
        start = end - 300
        end = start + 4100
        windows.append(text[start:end])
    return windows


async def route_intent(
    signals,
    data,
    classifier=None,
    *,
    min_confidence=0.7,
    timeout_ms=1000,
    cancelled=None,
    combined=None,
    combined_error=None,
    combined_requested=False,
    control=False,
    before_costly=None,
):
    rule = rule_intent(signals)
    if classifier is None:
        return rule, None
    if control or not needs_classifier(signals):
        return rule, {"decidedBy": "rule", "ruleIntent": rule}
    base = {"classifier": classifier.name, "ruleIntent": rule}
    try:
        if combined_error:
            raise combined_error
        if combined_requested:
            result = combined
        else:
            if before_costly:
                await before_costly()
            result = await bounded(
                classifier.classify(data, signal=cancelled), timeout_ms, cancelled
            )
        if not result:
            return rule, dict(base, decidedBy="classifier_fallback", fallbackReason="no_answer")
        answer = {"label": result["label"], "confidence": result["confidence"]}
        if not result["confidence"] >= min_confidence:
            return rule, dict(
                base, **answer, decidedBy="classifier_fallback", fallbackReason="below_threshold"
            )
        return result["label"], dict(base, **answer, decidedBy="classifier")
    except Exception as error:
        return rule, dict(
            base, decidedBy="classifier_fallback", fallbackReason=fallback_reason(error, cancelled)
        )


async def assess_safety(
    classifier,
    data,
    *,
    timeout_ms=1000,
    thresholds=None,
    cancelled=None,
    rule=None,
    before_costly=None,
):
    thresholds = thresholds or DEFAULT_SAFETY_THRESHOLDS
    windows = safety_windows(data["text"])
    categories = ["self_harm"] if rule else list(CATEGORIES)

    async def one(index, text):
        request = (
            dict(data, text=text, categories=categories)
            if not index
            else {
                "text": text,
                "recentUserTurns": [],
                "seed": data["seed"] + f"#w{index}",
                "intent": False,
                "categories": categories,
            }
        )
        try:
            if before_costly:
                await before_costly()
            return await bounded(
                classifier.assess(request, signal=cancelled), timeout_ms, cancelled
            )
        except Exception as error:
            return error

    results = await asyncio.gather(*(one(i, w) for i, w in enumerate(windows)))
    probabilities: dict[str, float] = {}
    failure = None
    for result in results:
        scores = result.get("safety") if isinstance(result, dict) else result
        if isinstance(scores, BaseException):
            failure = failure or scores
            continue
        if not isinstance(scores, dict):
            failure = failure or ValueError("invalid")
            continue
        for category in categories:
            if category in scores:
                probabilities[category] = max(probabilities.get(category, 0), scores[category])
    decision = input_decision({"probabilities": probabilities, "thresholds": thresholds})
    trace = {
        "decidedBy": "classifier",
        "classifier": classifier.name,
        **decision,
        "probabilities": probabilities,
    }
    if rule:
        trace["rule"] = rule
        if decision["action"] != "support":
            trace.update(decidedBy="rule", action="refuse", fired=[])
            trace.pop("category", None)
    elif failure and decision["action"] == "none":
        trace["decidedBy"] = "classifier_fallback"
        trace.pop("probabilities", None)
    if len(windows) > 1:
        trace["windows"] = len(windows)
    if failure:
        trace["fallbackReason"] = fallback_reason(failure, cancelled)
    first = results[0]
    intent = first.get("intent") if isinstance(first, dict) else first
    return trace, intent


def safety_reply(category, language):
    import json
    from pathlib import Path

    from .texts import is_korean

    replies = json.loads(Path(__file__).with_name("safety_replies.json").read_text())
    return replies[category]["ko" if is_korean(language) else "en"]
