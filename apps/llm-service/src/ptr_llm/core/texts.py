import json
from pathlib import Path

import regex

from .policy import js_search, voice

TEXTS = json.loads(Path(__file__).with_name("reply_texts.json").read_text())


def is_korean(language):
    return bool(regex.match(r"^ko(?:$|[-_])", language, regex.I))


def reply_text(key, language):
    return TEXTS[key]["ko" if is_korean(language) else "en"]


def voice_text(key, language, level="polite", previous="", seed=None):
    return voice(key, language, level, previous, seed)


def _language_counts(text):
    words = regex.sub(r"\bhttps?://\S+|\bwww\.\S+|[@#][\p{L}\p{N}_.]+", " ", text).split()
    ko = sum(bool(js_search(r"[\uAC00-\uD7A3\u3131-\u318E]", w)) for w in words)
    en = sum(
        bool(js_search("[A-Za-z]", w)) and not bool(js_search(r"[\uAC00-\uD7A3\u3131-\u318E]", w))
        for w in words
        if w.casefold().strip("!?.~, ") not in {"omg", "lol", "thanks"}
    )
    return ko, en, len(words)


def utterance_language(text, fallback, history=()):
    """Pin to the first substantive user turn; switch after two turns or 80% of one."""
    language = fallback
    consecutive = 0
    prior = [m["content"] for m in history if m.get("role") == "user"]
    for index, utterance in enumerate([*prior, text]):
        ko, en, word_count = _language_counts(utterance)
        if not ko and not en:
            consecutive = 0
            continue
        candidate = "ko" if ko >= en else "en"
        if index == 0:
            language = candidate
            consecutive = 0
        elif (language.startswith("ko") and candidate == "ko") or (
            language.startswith("en") and candidate == "en"
        ):
            consecutive = 0
        else:
            if word_count < 3:
                continue
            consecutive += 1
            if max(ko, en) / (ko + en) >= 0.8 or consecutive >= 2:
                language = candidate
                consecutive = 0
    return language


def speech_level(persona):
    casual = r"반말|\b(?:casual|informal)\s+(?:speech|register|tone|language|style of speech)\b"
    polite = (
        "해요체|존댓말|존대|\\b(?:polite|honorific|formal)\\s+(?:speech|register|tone|lan"
        "guage|style of speech)\\b|\\bpolite\\b"
    )
    nc = (
        "반말\\s?(?:금지|하지\\s?마|사용\\s?(?:금지|안\\s?함)|X)|\\b(?:never|no|avoid|don'?t|not)"
        "\\s+(?:use\\s+)?(?:any\\s+)?반말"
    )
    np = (
        "(?:존댓말|해요체)\\s?(?:금지|하지\\s?마|X)|\\b(?:never|no|avoid|don'?t|not)\\s+(?:use"
        "\\s+)?(?:any\\s+)?(?:polite|formal|honorific)\\s+(?:speech|register|tone|"
        "language)|\\b(?:never|no|avoid)\\s+(?:존댓말|해요체)"
    )
    personality = persona.get("personality", {})
    for notes in [
        personality.get("speechHabits", []),
        persona.get("style", []) + [personality.get("summary", "")],
    ]:
        text = "\n".join(notes)
        if (
            js_search(polite, text, regex.I)
            and not js_search(np, text, regex.I)
            or js_search(nc, text, regex.I)
        ):
            return "polite"
        if js_search(casual, text, regex.I) or js_search(np, text, regex.I):
            return "casual"
    lines = (
        [persona.get("greeting", "")]
        + persona.get("alternateGreetings", [])
        + [
            t["text"]
            for d in persona.get("exampleDialogues", [])
            for t in d["turns"]
            if t["speaker"] == "character"
        ]
    )
    pc = cc = 0
    for sentence in regex.split(r"[.!?~\n…]+", "\n".join(lines)):
        end = regex.sub(r"[^가-힣]+$", "", sentence)
        if js_search(r"[가-힣]$", end):
            if js_search(r"(?:요|용|니다|니까|세요|죠)$", end):
                pc += 1
            else:
                cc += 1
    return "casual" if cc > pc else "polite"
