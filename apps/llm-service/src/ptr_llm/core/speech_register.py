"""Validated, intentionally narrow Korean reply ending classifier."""

import re

POLITE_ENDING = re.compile(
    r"(?:습니다|입니다|세요|십시오|나요|까요|어요|아요|예요|이에요|해요|줘요|네요|군요|죠|요)$"
)
CASUAL_ENDING = re.compile(
    r"(?:해|야|어|아|지|래|니|냐|줘|네|구나|잖아|까|자|다|게|고|어때|지내|나|거든"
    r"|거워|마워|서워|쉬워|더워|추워|지워|는데|은데|ㄴ데|지만|니까|으니까|면서|며"
    r"|더니|더라|더라고|써|었더라|려고|려면|아서|어서|아도|어도)$"
)
HONORIFIC = re.compile(
    r"(?:으시|시|셔|셨)(?:어서|서|고|면|겠|다|네|죠|요|던|는|니|기|어|었|을)|세요|십시오"
)
PARTICLE = re.compile(r"[가-힣]+(?:은|는|이|가|을|를|에|에서|도|만|부터|까지)$")
NOUN_FRAGMENT = re.compile(
    r"(?:하루|날|그날|오늘|어제|비밀|이야기|얘기|대화|책|영화|사진|그림|마음|기분|사람|장면|기억|계절|시간|순간|곳|일|말)$"
)
LEADING_INTERJECTION = re.compile(r"^(?:(?:음|어|아|헉|오)\s*,\s*)+")
INTERJECTIONS = {"음", "어", "아", "헉", "오"}


def classify_speech_register(text: str) -> str:
    levels = set()
    for clean in (part.strip() for part in re.split(r"[.!?~…]+", text)):
        clean = LEADING_INTERJECTION.sub("", clean).strip()
        if clean in INTERJECTIONS:
            continue
        if not clean:
            continue
        honorific = bool(HONORIFIC.search(clean))
        if clean in {"안녕", "응", "그래"}:
            level = "casual"
        elif POLITE_ENDING.search(clean):
            level = "polite"
        elif CASUAL_ENDING.search(clean):
            level = "casual"
        elif PARTICLE.search(clean) or NOUN_FRAGMENT.fullmatch(clean.split()[-1]):
            # A noun or particle fragment borrows the previous sentence's level.
            level = None
        else:
            level = "unknown"
        if level:
            levels.add(level)
        if honorific:
            levels.add("polite")
    if len(levels) > 1:
        return "mixed"
    return next(iter(levels)) if levels else "unknown"
