"""Narrow deterministic gates, not semantic verification or a full secret detector."""

import regex

from .policy import compile_js, js_search

CREDENTIAL = compile_js(
    {"source": r"\bsk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+|(?:api[_-]?key|password)\s*[:=]", "flags": "i"}
)
PATH = compile_js(
    {
        "source": r"""(?:file://|(?:^|[\s"'(])/(?:home|Users|tmp|private|var|etc|root|mnt)/|\b[A-Za-z]:\\(?:Users|Windows|Temp)\\)""",
        "flags": "i",
    }
)
CREATIVE = compile_js(
    {
        "source": (
            r"\b(fictional|imaginary|invent(?:ed)?|creative|role[ -]?play)\b"
            "|가상|허구|창작|상상"
        ),
        "flags": "i",
    }
)


def contains_credential(text):
    return bool(CREDENTIAL.search(text))


def contains_internal_path(text):
    return bool(PATH.search(text))


def is_creative(text):
    return bool(CREATIVE.search(text))


def is_biographical(text):
    if is_creative(text):
        return False
    english = js_search(
        (
            "\\b(childhood|birthplace|birth ?date|birthday|hometown|upbringing|biogr"
            "aph(?:y|ical)|early life|grew up|born|education|school|university|coll"
            "ege|graduat(?:e|ed|ion)|parents?|siblings?|marriage|spouse|career)\\b"
        ),
        text,
        regex.I,
    )
    directed = js_search(r"\b(your|you|describe|tell me|what|where|when|how)\b", text, regex.I)
    korean = js_search(
        (
            "어린\\s?시절|어릴\\s?적|유년\\s?시절|유년기|학창\\s?시절|어렸을\\s?때|출생지|출생|생년월일|고향|태어난|태어났|자랐|학"
            "력|대학교|고등학교|어떤\\s?대학|졸업|출신|부모|형제|생일"
        ),
        text,
    )
    own = js_search(r"내\s?생일|제\s?생일|저의|나의", text) and not js_search(
        r"너의|당신의|네\s?생일|네\s?어린", text
    )
    return bool(english and directed or korean and not own)


def contains_ungrounded_biography(text):
    if is_creative(text):
        return False
    return bool(
        js_search(
            (
                "\\bI (?:was born|used to (?:live|work|study)|attended|grew up|was raise"
                "d|spent my childhood|graduated|studied at|worked at|lived in|got marri"
                "ed|went to (?:school|college|university))\\b|\\bmy (?:birthplace|hometow"
                "n|childhood|parents?|mother|father|siblings?)\\b"
            ),
            text,
            regex.I,
        )
        or js_search(
            (
                "(?:저는|나는|제가|내가)[^.!?\\n]{0,120}(?:태어났|자랐|출생했|졸업했|다녔|나왔|살았|근무했|결혼했)|(?:제"
                "|나의|내)\\s?(?:고향|출생지|어린\\s?시절|부모님|어머니|아버지)"
            ),
            text,
        )
    )
