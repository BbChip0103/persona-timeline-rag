"""Validated, intentionally narrow Korean reply ending classifier."""

import re


def classify_speech_register(text: str) -> str:
    clean = re.sub(r"[.!?~…\s]+$", "", text)
    if clean in {"안녕", "응", "그래"}:
        return "casual"
    if re.search(
        r"(?:습니다|입니다|세요|십시오|나요|까요|어요|아요|예요|이에요|해요|줘요|네요|군요|죠|요)$",
        clean,
    ):
        return "polite"
    if re.search(
        r"(?:해|야|어|아|지|래|니|냐|줘|네|구나|잖아|까|자|다|게|고|어때|지내|나|거든)$",
        clean,
    ):
        return "casual"
    return "unknown"
