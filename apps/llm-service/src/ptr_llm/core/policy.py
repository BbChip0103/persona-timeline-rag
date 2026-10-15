"""Synthetic-test-pinned reply guard domain policy.

regex supports JS Unicode properties and variable-width lookbehind. Word boundaries
are explicitly ECMAScript ASCII word boundaries, not Python's Unicode boundaries.
"""

import json
import unicodedata
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
# Sentence splitter retains question/emoji exceptions from the transferred policy.
SENTENCES = regex.compile(
    "\\s*\\n\\s*|(?<=[.!?。！？~…]|\\p{Extended_Pictographic}️?|\\p{Regional_Indica"
    "tor})(?:\\s+|(?<=[!?~…])(?=[\\p{L}\\p{N}])|(?<=\\.)(?=[가-힣]))(?![\\p{Extend"
    "ed_Pictographic}\\p{Regional_Indicator}])"
)
QUESTION = regex.compile(r"[?？]\s*\p{Extended_Pictographic}*️?\s*$")
CLAUSES = regex.compile(r"\s*,\s*|(?<!에고)(?<=(?:는데|지만|다시피|잖아|고))(?=\s)")
_KOREAN_SELF = regex.compile(
    r"(?<![가-힣])(?:나는|나도|난|내가|나의|나|내|제가|저는|저도|저희|제)"
    r"(?:에게|한테|까지|부터|랑|하고|와|과|의|은|는|이|가|을|를|도|에|서|만)?(?![가-힣])"
)
_ENGLISH_SELF = regex.compile(r"\b(?:my|our|i|we)\b", regex.I)
_SECOND_PERSON_SUBJECT = regex.compile(
    r"(?<![가-힣])(?:너|넌|네|니|당신)(?:는|도|가|랑|에게|한테|의|를|이)?(?![가-힣])"
    r"|\b(?:you|your)\b",
    regex.I,
)
_PERSONAL_NOUNS = (
    "엄마",
    "아빠",
    "어머니",
    "아버지",
    "부모님",
    "가족",
    "오빠",
    "언니",
    "누나",
    "형",
    "동생",
    "남편",
    "아내",
    "와이프",
    "친구",
    "병원",
    "건강",
    "남친",
    "여친",
    "애인",
    "집",
    "동네",
    "학교",
    "수술",
    "결혼",
    "mom",
    "mum",
    "mother",
    "dad",
    "father",
    "parents",
    "family",
    "brother",
    "sister",
    "husband",
    "wife",
    "friend",
    "hospital",
    "health",
    "home",
)
_BARE_PRIVATE = regex.compile(
    r"(?<![가-힣])(?:남자친구|여자친구|결혼|남친|여친|연애|이혼|임신|가족|엄마|아빠|병원|입원|아프|아팠|사귀|헤어|유부)"
    r"|\b(?:boyfriend|girlfriend|married|marriage|divorce|pregnant|dating|hospital|hospitalized|newlywed)\b"
    r"|\bmy\s+(?:mom|dad|family)\b",
    regex.I,
)
_ADDITIONAL_PRIVATE = regex.compile(
    r"신혼여행|신혼집|짝꿍|그이|예랑|식\s?올렸|웨딩|신랑|신부|어머님|아버님|할머니|할아버지|아기\s?낳|출산|썸"
    r"|\b(?:wedding|partner\b(?!\s+(?:brands?|companies|agencies))|seeing\s+someone|had\s+a\s+baby)\b",
    regex.I,
)
_PERSONA_SELF = regex.compile(
    r"(?<![가-힣])(?:나는|나도|난|내가|나의|나|내|제가|저는|저도|저희|저|전|제|우리|울)"
    r"(?:에게|한테|까지|부터|랑|하고|와|과|의|은|는|이|가|을|를|도|에|서|만|처럼|만큼|보다)?(?![가-힣])"
    r"|\b(?:my|our|i|we|me|mine|us|ours)\b|\b(?:me\s+too|same\s+here|happened\s+to\s+me|i\s+did\s+too)\b",
    regex.I,
)
_OWN_STORY_EMPATHY = regex.compile(
    r"(?:겠다|겠어|길\s*바라|면\s*좋겠다|속상|축하해)[.!?~…]*$"
    r"|^(?:i\s+hope|i(?:'m| am)\s+sorry|hope|sorry|congrats)\b",
    regex.I,
)
_ALLOWED_EMPATHY_SELF_PREFIX = regex.compile(r"^i(?:\s+hope|(?:'m| am)\s+sorry)\b", regex.I)
_EXPERIENCE_MARKER = regex.compile(
    r"로서|입장|겪어|해봐서|봐서|해봤|었던|았던|였던|던\s+거|생각나|것처럼"
    r"|\b(?:as\s+a|myself|from\s+one)\b", regex.I
)
# A private noun is recognized by the policy's existing private-keyword sources.
_PRIVATE_NOUNS = (_BARE_PRIVATE, _ADDITIONAL_PRIVATE, *PATTERNS["PRIVATE_REPLY"])
_REPLY_PRIVATE_STEMS = regex.compile(
    r"(?<![가-힣])(?:수술|입원|아프|아팠|임신|출산|이혼|결혼|사귀|연애|헤어)"
)
_USER_CARE = regex.compile(r"아프지\s*(?:마|않게)|조심해|챙겨|푹\s*쉬어")
_LEADING_CONNECTIVE = regex.compile(r"^(?:(?:해서|고|는데|지만)(?=\s|$)\s*)+")
_NOUN_SUFFIX = regex.compile(
    r"(?:한테도|에게도|이랑|랑|하고|와|과|은|는|이|가|을|를|에|에서|에게|한테|도|만|의|처럼|까지|부터|로|으로|께|께서|들|야|이에요|이야|해|했|하다|하는|한|할)?"
    r"(?=$|[^\p{L}\p{N}])"
)
_NOUN_PARTICLE = regex.compile(
    r"(?:들이랑|들과|들을|한테도|에게도|이랑|랑|하고|와|과|은|는|이|가|을|를|에|에서|에게|한테|도|만|의|처럼|까지|부터|로|으로|께|께서)$"
)


def _canonical_private_noun(surface):
    noun = regex.sub(r"^(?:내|제|우리|울)\s?", "", surface.casefold()).rstrip()
    return _NOUN_PARTICLE.sub("", noun)


def _private_noun_mentions(text, *, reply=False):
    """Recognize private keyword matches at token ends, including Korean particles."""
    mentions = {
        _canonical_private_noun(match.group())
        for pattern in _PRIVATE_NOUNS
        for match in pattern.finditer(text)
        if regex.search(r"[^\p{L}\p{N}]$", match.group())
        or _NOUN_SUFFIX.match(text, match.end())
    }
    if reply:
        mentions.update(match.group() for match in _REPLY_PRIVATE_STEMS.finditer(text))
    return mentions
_QUESTION_PRIVATE = regex.compile(
    r"아기|낳|출산|파트너|신혼|유부|\b(?:partner(?!\s+(?:brands?|companies|agencies))|baby|newlywed)\b",
    regex.I,
)
_HEARSAY = regex.compile(r"다며|다던데|했다는|줄\s?알았|소문|들었|\b(?:heard|rumor)\b", regex.I)
_SPLIT_PRIVATE_WORDS = (
    "결혼", "남친", "여친", "연애", "이혼", "임신", "가족", "엄마", "아빠", "병원",
    "입원", "아프", "사귀", "헤어", "신혼여행", "웨딩", "신랑", "신부", "어머님",
    "아버님", "할머니", "할아버지", "출산", "식올렸", "아기낳", "wedding",
    "partner", "seeing", "someone",
    "baby", "boyfriend", "girlfriend", "married", "marriage", "dating", "hospital",
    "유부", "newlywed",
)


def _normalize_private_text(text):
    visible = "".join(character for character in text if unicodedata.category(character) != "Cf")
    visible = regex.sub(r"\bseeing\r?\nsomeone\b", "seeing someone", visible, flags=regex.I)

    def join_if_private(match):
        left, right = match.groups()
        combined = (left + right).lower()
        boundary = len(left)
        crosses_boundary = any(
            (start := combined.find(stem)) >= 0 and start < boundary < start + len(stem)
            for stem in _SPLIT_PRIVATE_WORDS
        )
        return left + right if crosses_boundary else match.group()

    return regex.sub(r"([\p{L}]+)\r?\n([\p{L}]+)", join_if_private, visible)


def has_user_self_marker(text):
    """A bounded self reference; `우리` alone can refer to the character."""
    return bool(_KOREAN_SELF.search(text) or _ENGLISH_SELF.search(text))


def _private_question(utterance):
    return any(
        (
            any_match("PRIVATE_QUESTION", sentence)
            or _ADDITIONAL_PRIVATE.search(sentence)
            or (_QUESTION_PRIVATE.search(sentence) and _QUESTION_FORM.search(sentence))
            or (_HEARSAY.search(sentence) and _BARE_PRIVATE.search(sentence))
        )
        and (
            _QUESTION_FORM.search(sentence)
            or not _user_owns_private_statement(sentence)
        )
        for sentence in SENTENCES.split(utterance)
        if sentence.strip()
    )


_QUESTION_FORM = regex.compile(
    r"[?？]|해\s?줘|말해|알려|얘기해|궁금해|tell me"
    r"|(?<![A-Za-z])(?:언제|어디|뭐|누구|어떤|왜|how|when|where|what|who|which)(?![A-Za-z])"
    r"|(?:니|냐|나요|습니까|세요)\s*$",
    regex.I,
)
_OWN_NOUN = regex.compile(
    r"(?<![가-힣])(?:내|제|우리|저희|나의)\s?(?:" + "|".join(_PERSONAL_NOUNS[:25]) + r")"
    r"|(?<![가-힣])나\s+(?:" + "|".join(_PERSONAL_NOUNS[:25])
    + r")(?:랑|하고|와|과|이|가|은|는|을|를|에게|한테|도|의)"
    r"|\b(?:my|our)\s+(?:" + "|".join(_PERSONAL_NOUNS[25:]) + r")\b",
    regex.I,
)
_SELF_SUBJECT = regex.compile(
    r"(?<![가-힣])(?:나|난|나는|나도|내가|저|전|저는|저도|제가)(?![가-힣])"
    r"|\b(?:i|we)\b",
    regex.I,
)
_TOPIC_SHIFT = regex.compile(r"궁금|물어|여쭤|생각|\b(?:wonder|ask)\b", regex.I)
_PRIVATE_PREDICATE = regex.compile(
    r"결혼(?:해|했|하고)|사귀|연애|유부|있어|없어|살아|살고|아프|다녀|갔|싸웠|싸우|만났|만나|걱정|그리워|보고\s?싶|여행|안\s?좋"
    r"|\b(?:married|dating|newlywed|live|visited|went|ill|sick|fought|miss)\b",
    regex.I,
)
_DANGLING = regex.compile(
    r"(?:는데|지만|다시피|잖아|고)$|^(?:응|네|예|맞아|맞아요|yeah|yes|right)[.!?~]*$",
    regex.I,
)


def _user_owns_private_statement(sentence):
    return bool(
        not _SECOND_PERSON_SUBJECT.search(sentence)
        and not _HEARSAY.search(sentence)
        and (
            _OWN_NOUN.search(sentence)
            or (
                _SELF_SUBJECT.search(sentence)
                and not _TOPIC_SHIFT.search(sentence)
                and _PRIVATE_PREDICATE.search(sentence)
            )
        )
    )


def _private_reply_clause(clause):
    return any_match("PRIVATE_REPLY", clause) or bool(
        _BARE_PRIVATE.search(clause) or _ADDITIONAL_PRIVATE.search(clause)
    )


def _user_care_clause(clause):
    return bool(
        _USER_CARE.search(clause)
        and not _PERSONA_SELF.search(clause)
        and _private_noun_mentions(clause, reply=True).issubset({"아프", "건강"})
    )


def _allowed_own_story_clause(clause, utterance):
    if _user_care_clause(clause):
        return True
    empathy = bool(_OWN_STORY_EMPATHY.search(clause))
    marker_text = _ALLOWED_EMPATHY_SELF_PREFIX.sub("", clause, count=1) if empathy else clause
    return (bool(QUESTION.search(clause)) or empathy) and not (
        _PERSONA_SELF.search(marker_text)
        or _EXPERIENCE_MARKER.search(clause)
        or (
            _private_reply_clause(clause)
            and not _private_noun_mentions(clause, reply=True).issubset(
                _private_noun_mentions(utterance)
            )
        )
    )


def any_match(name, text):
    return any(pattern.search(text) for pattern in PATTERNS[name])


def voice(key, language, level, previous="", seed=None):
    variants = VOICES[key][level if regex.match(r"^ko(?:$|[-_])", language, regex.I) else "en"]
    start = 0
    if seed is not None:
        start = sum(ord(character) for character in str(seed)) % len(variants)
    for offset in range(len(variants)):
        candidate = variants[(start + offset) % len(variants)]
        if candidate != previous:
            return candidate
    raise ValueError(f"voice key {key} has no variant different from previous reply")


def reply_decision(reply, metadata):
    utterance = _normalize_private_text(metadata["utterance"])
    reply = _normalize_private_text(reply)
    real_person = metadata["realPerson"]
    language = metadata["language"]
    level = metadata.get("level", "polite")
    private_question = _private_question(utterance)
    identity = any_match("IDENTITY_QUESTION", utterance) and (
        not PATTERNS["ART_UTTERANCE"].search(utterance)
        or regex.search(r"(?:너|넌|당신|니가|네가)|\byou\b", utterance, regex.I)
    )

    def replace(reason, key):
        return {
            "reason": reason,
            "content": voice(
                key,
                language,
                level,
                metadata.get("previousAssistantText", ""),
                metadata.get("turnId"),
            ),
        }

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
        if real_person and private_question:
            return replace("private_life", "decline_private")
        return replace("meta_talk", "service_retry")
    art = PATTERNS["ART_UTTERANCE"].search(utterance) or PATTERNS["ART_REPLY"].search(reply)
    if any_match("HUMAN_CLAIM", reply) or (not art and any_match("BARE_DENIAL", reply)):
        return replace("human_impersonation", "identity" if identity else "service_retry")
    if identity and not any_match("AI_ACKNOWLEDGED", reply):
        return replace("missing_ai_disclosure", "identity")
    if real_person:
        if private_question:
            return replace("private_life", "identity" if identity else "decline_private")
        checked = (
            PATTERNS["PAST_HOME"].sub(" ", reply)
            if PATTERNS["ORIGIN_QUESTION"].search(utterance)
            else reply
        )
        checked_sentences = [
            clause.strip()
            for sentence in SENTENCES.split(checked.strip())
            for clause in ([sentence] if _user_care_clause(sentence) else CLAUSES.split(sentence))
            if clause.strip()
        ]
        own_story = any(
            _user_owns_private_statement(sentence) and not _QUESTION_FORM.search(sentence)
            for sentence in SENTENCES.split(utterance)
        )
        removed_private = any(_private_reply_clause(sentence) for sentence in checked_sentences)
        def should_remove(clause):
            if own_story:
                return not _allowed_own_story_clause(clause, utterance)
            return (not _user_care_clause(clause) and _private_reply_clause(clause)) or (
                removed_private and _PERSONA_SELF.search(clause)
            )

        removed = any(should_remove(sentence) for sentence in checked_sentences)
        private_kept = [
            _LEADING_CONNECTIVE.sub("", sentence).strip() if removed else sentence
            for sentence in checked_sentences
            if not should_remove(sentence) and not (removed and _DANGLING.search(sentence))
        ]
        if removed:
            text = " ".join(sentence for sentence in private_kept if sentence).strip()
            if regex.search(r"[\p{L}\p{N}]", text):
                return reply_decision(text, metadata) or {
                    "reason": "private_life",
                    "content": text,
                    "edited": True,
                }
            key = "identity" if identity else "empathy_ask" if own_story else "decline_private"
            return replace("private_life", key)
    if (
        not identity
        and not art
        and (
            (any_match("AI_ACKNOWLEDGED", reply) and any_match("NOT_HAVING", reply))
            or (real_person and any_match("BACKGROUND_DISOWNED", reply))
        )
    ):
        return replace("background_denial", "service_retry")
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


def js_search(pattern, text, flags=0):
    """ECMAScript ASCII word boundaries with Unicode whitespace/property behavior."""
    pattern = pattern.replace(r"\b", _BOUNDARY).replace(r"\w", "[A-Za-z0-9_]")
    return regex.search(pattern, text, flags)
