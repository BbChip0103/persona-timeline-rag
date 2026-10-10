import json
from pathlib import Path

import regex

from .policy import js_search, voice

TEXTS = json.loads(Path(__file__).with_name("reply_texts.json").read_text())


def is_korean(language):
    return bool(regex.match(r"^ko(?:$|[-_])", language, regex.I))


def reply_text(key, language):
    return TEXTS[key]["ko" if is_korean(language) else "en"]


def voice_text(key, language, level="polite"):
    return voice(key, language, level)


def utterance_language(text, fallback):
    words = regex.sub(r"\bhttps?://\S+|\bwww\.\S+|[@#][\p{L}\p{N}_.]+", " ", text).split()
    ko = sum(bool(js_search(r"[\uAC00-\uD7A3\u3131-\u318E]", w)) for w in words)
    en = sum(
        bool(js_search("[A-Za-z]", w)) and not bool(js_search(r"[\uAC00-\uD7A3\u3131-\u318E]", w))
        for w in words
    )
    return "ko" if ko and ko >= en else "en" if en else fallback


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
