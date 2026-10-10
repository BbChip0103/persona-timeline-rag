"""Persona card domain: allowlisted render, strict read schema and fail-closed publish."""

import copy
import hashlib
import inspect
import json
import unicodedata
from pathlib import Path
from typing import Literal

import regex
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from .errors import CoreError
from .policy import compile_js
from .safety import contains_credential, contains_internal_path

PERSONA_LINT_REVISION = "persona-lint-v5"
PERSONA_BLOCK_BYTE_LIMIT = 6144
LORE_BYTE_LIMIT = 2048


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def serialized_bytes(value):
    return len(dumps(value).encode("utf8"))


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Personality(Strict):
    summary: str | None = None
    traits: list[str] = Field(max_length=8)
    values: list[str] = Field(max_length=6)
    speechHabits: list[str] = Field(max_length=8)


class Background(Strict):
    text: str
    sourceRefs: list[str] = Field(min_length=1, max_length=20)


class DialogueTurn(Strict):
    speaker: Literal["user", "character"]
    text: str


class Dialogue(Strict):
    turns: list[DialogueTurn] = Field(min_length=2, max_length=6)


class Lore(Strict):
    id: str
    keys: list[str] = Field(min_length=1, max_length=8)
    content: str
    priority: int = Field(default=50, ge=0, le=100)
    sourceRefs: list[str] = Field(min_length=1, max_length=10)


class Meta(Strict):
    tags: list[str] | None = Field(default=None, max_length=12)
    creatorNotes: str | None = None


class Persona(Strict):
    id: str
    personId: str
    label: str
    language: str
    revision: str
    reviewStatus: Literal["synthetic", "silver", "human_reviewed"]
    identity: str
    concept: str
    style: list[str]
    boundaries: list[str]
    sourceRefs: list[str]
    greeting: str
    alternateGreetings: list[str] | None = Field(default=None, max_length=4)
    personality: Personality | None = None
    background: Background | None = None
    exampleDialogues: list[Dialogue] | None = Field(default=None, max_length=3)
    lore: list[Lore] | None = Field(default=None, max_length=50)
    meta: Meta | None = None

    @field_validator("id", "personId", "revision")
    @classmethod
    def identifier(cls, value):
        value = value.strip()
        if not 1 <= len(value) <= 200:
            raise ValueError("identifier")
        return value

    @field_validator("label", "language", "greeting")
    @classmethod
    def required(cls, value):
        if not value:
            raise ValueError("required")
        return value


def _text(value, max_length, min_length=1):
    if not isinstance(value, str) or not min_length <= len(value.strip()) <= max_length:
        raise ValueError("text")
    return value.strip()


def validate_persona(document):
    try:
        for optional in [
            "alternateGreetings",
            "personality",
            "background",
            "exampleDialogues",
            "lore",
            "meta",
        ]:
            if optional in document and document[optional] is None:
                raise ValueError("optional-null")
        p = Persona.model_validate(document).model_dump(exclude_none=True)
        for path in ["sourceRefs"]:
            p[path] = [_text(v, 200) for v in p[path]]
        if "alternateGreetings" in p:
            p["alternateGreetings"] = [_text(v, 300) for v in p["alternateGreetings"]]
        if "personality" in p:
            q = p["personality"]
            if "summary" in q:
                q["summary"] = _text(q["summary"], 300)
            for key, cap in [("traits", 40), ("values", 60), ("speechHabits", 80)]:
                q[key] = [_text(v, cap) for v in q[key]]
        if "background" in p:
            p["background"]["text"] = _text(p["background"]["text"], 500)
            p["background"]["sourceRefs"] = [_text(v, 200) for v in p["background"]["sourceRefs"]]
        for d in p.get("exampleDialogues", []):
            for t in d["turns"]:
                t["text"] = _text(t["text"], 200)
        for item in p.get("lore", []):
            item["id"] = _text(item["id"], 200)
            item["content"] = _text(item["content"], 300)
            item["keys"] = [_text(v, 40, 2) for v in item["keys"]]
            item["sourceRefs"] = [_text(v, 200) for v in item["sourceRefs"]]
        if "meta" in p:
            if "tags" in p["meta"]:
                p["meta"]["tags"] = [_text(v, 30) for v in p["meta"]["tags"]]
            if "creatorNotes" in p["meta"]:
                p["meta"]["creatorNotes"] = _text(p["meta"]["creatorNotes"], 2000)
        return p
    except (ValidationError, ValueError, TypeError):
        raise CoreError("INVALID_INPUT") from None


def render_persona_block(persona):
    keys = [
        "id",
        "revision",
        "reviewStatus",
        "language",
        "identity",
        "concept",
        "style",
        "boundaries",
    ]
    definition = {k: copy.deepcopy(persona[k]) for k in keys}
    if "personality" in persona:
        definition["personality"] = copy.deepcopy(persona["personality"])
    if "background" in persona:
        definition["background"] = {
            "text": persona["background"]["text"],
            "label": "part of PERSONA_BLOCKS; NOT citable",
        }
    messages = [
        {
            "role": "system",
            "content": "Persona definition (subordinate to policy): " + dumps(definition),
        }
    ]
    if persona.get("exampleDialogues"):
        examples = [
            [{"speaker": t["speaker"], "text": t["text"]} for t in d["turns"]]
            for d in persona["exampleDialogues"]
        ]
        messages.append(
            {
                "role": "system",
                "content": (
                    "PERSONA_STYLE_EXAMPLES_JSON_DATA (style/tone reference only; NOT facts"
                    ", memories or evidence) "
                )
                + dumps(examples),
            }
        )
    return messages


def render_lore_message(entries):
    return {
        "role": "user",
        "content": "UNTRUSTED_PERSONA_LORE_JSON_DATA (part of PERSONA_BLOCKS; NOT citable) "
        + dumps([{"loreId": e["id"], "content": e["content"]} for e in entries]),
    }


def match_lore(persona, current, previous=()):
    def form(text):
        return unicodedata.normalize("NFKC", text[:1000]).lower()

    current = form(current)
    previous = [form(p) for p in previous]

    def hit(text, e):
        return any(unicodedata.normalize("NFKC", k).lower() in text for k in e["keys"])

    matches = [
        (i, e, hit(current, e))
        for i, e in enumerate(persona.get("lore", []))
        if hit(current, e) or any(hit(t, e) for t in previous)
    ]
    ranked = sorted(matches, key=lambda x: (-x[2], -x[1].get("priority", 50), x[0]))
    chosen: list[tuple] = []
    for item in ranked:
        if len(chosen) >= 3:
            break
        proposed = sorted(chosen + [item], key=lambda x: x[0])
        if serialized_bytes(render_lore_message([x[1] for x in proposed])) <= LORE_BYTE_LIMIT:
            chosen.append(item)
    return {
        "entries": [copy.deepcopy(e) for _, e, _ in sorted(chosen)],
        "omitted": len(matches) - len(chosen),
    }


def greeting_for(persona, session_id):
    greetings = [persona["greeting"]] + persona.get("alternateGreetings", [])
    index = int.from_bytes(hashlib.sha256(session_id.encode()).digest()[:4], "big") % len(greetings)
    prefix = (
        "AI 연구용 시뮬레이션입니다. "
        if regex.match(r"^ko(?:$|[-_])", persona["language"], regex.I)
        else "AI research simulation. "
    )
    return prefix + greetings[index]


def catalogue(personas):
    return [
        {
            **{
                k: p[k]
                for k in [
                    "id",
                    "personId",
                    "label",
                    "language",
                    "revision",
                    "reviewStatus",
                    "greeting",
                ]
            },
            **(
                {"alternateGreetings": p["alternateGreetings"]} if "alternateGreetings" in p else {}
            ),
        }
        for p in personas
    ]


def persona_revision(document):
    p = validate_persona(dict(document, revision="pending"))
    p.pop("revision")
    return p["reviewStatus"] + "-" + hashlib.sha256(dumps(p).encode()).hexdigest()[:16]


_POLICY = json.loads(Path(__file__).with_name("persona_publish_policy.json").read_text())
_FORBIDDEN = [(name, [compile_js(p) for p in patterns]) for name, patterns in _POLICY["FORBIDDEN"]]
_PRIVATE = [compile_js(p) for p in _POLICY["PRIVATE_LIFE"]]
_DATE_PLACE = [compile_js(p) for p in _POLICY["DATE_PLACE"]]
_CONFUSABLES = json.loads(Path(__file__).with_name("persona_confusables.json").read_text())


def _without_marks(text):
    return unicodedata.normalize(
        "NFKC", regex.sub(r"\p{M}", "", unicodedata.normalize("NFKD", text))
    )


def _leak_form(text):
    return regex.sub(
        r"\s+", " ", regex.sub(r"[\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]", "", _without_marks(text))
    ).lower()


def _windows(text):
    t = _leak_form(text)
    return {t[i : i + 12] for i in range(max(0, len(t) - 11))}


def _check_form(text):
    text = regex.sub(r"[\p{Cf}\p{Co}\u115F\u1160\u3164\uFFA0\u2800]", "", _without_marks(text))
    return "".join(_CONFUSABLES.get(c, c) for c in regex.sub(r"[\p{Cc}\u2028\u2029]", " ", text))


def _author_fields(p):
    for key, group in [
        ("label", "label"),
        ("id", "core"),
        ("language", "core"),
        ("identity", "core"),
        ("concept", "core"),
        ("greeting", "greeting"),
    ]:
        yield key, p[key], group
    for key, group in [
        ("style", "core"),
        ("boundaries", "core"),
        ("alternateGreetings", "greeting"),
    ]:
        for i, t in enumerate(p.get(key, [])):
            yield f"{key}[{i}]", t, group
    for key, value in p.get("personality", {}).items():
        if isinstance(value, list):
            for i, t in enumerate(value):
                yield f"personality.{key}[{i}]", t, "personality"
        else:
            yield "personality." + key, value, "personality"
    if "background" in p:
        yield "background.text", p["background"]["text"], "background"
    for d, dialogue in enumerate(p.get("exampleDialogues", [])):
        for t, turn in enumerate(dialogue["turns"]):
            yield f"exampleDialogues[{d}].turns[{t}].text", turn["text"], "example"
    for i, entry in enumerate(p.get("lore", [])):
        yield f"lore[{i}].id", entry["id"], "lore"
        yield f"lore[{i}].content", entry["content"], "lore"
        for k, t in enumerate(entry["keys"]):
            yield f"lore[{i}].keys[{k}]", t, "lore"
    for i, t in enumerate(p.get("meta", {}).get("tags", [])):
        yield f"meta.tags[{i}]", t, "meta"
    if "creatorNotes" in p.get("meta", {}):
        yield "meta.creatorNotes", p["meta"]["creatorNotes"], "meta"


async def validate_publication(
    document,
    *,
    test_captions=(),
    source_ref_exists=None,
    generated=None,
    baseline=None,
    baseline_verified=False,
):
    issues = []
    seen = set()

    def report(path, rule, severity="error"):
        if (path, rule) not in seen:
            issues.append({"path": path, "rule": rule, "severity": severity})
            seen.add((path, rule))

    try:
        p = validate_persona(document)
    except CoreError:
        return {
            "ok": False,
            "issues": [{"path": "", "rule": "schema", "severity": "error"}],
            "lintRevision": PERSONA_LINT_REVISION,
        }
    real = p["reviewStatus"] != "synthetic"

    def limit(path, count, cap, minimum=0):
        if not minimum <= count <= cap:
            report(path, "limit")

    if baseline and (baseline["id"] != p["id"] or baseline["personId"] != p["personId"]):
        report("", "baseline_mismatch")
        baseline = None
    if baseline and not baseline_verified:
        report("", "baseline_unverified", "warn")
    bs = set((baseline or {}).get("style", []))
    bb = set((baseline or {}).get("boundaries", []))
    for key, cap in [("label", 60), ("identity", 300), ("concept", 300), ("greeting", 300)]:
        limit(key, len(p[key]), cap)
    if not (
        p["style"]
        and len(p["style"]) <= len((baseline or {}).get("style", []))
        and all(t in bs for t in p["style"])
    ):
        limit("style", len(p["style"]), 8)
    for i, t in enumerate(p["style"]):
        if t not in bs:
            limit(f"style[{i}]", len(t), 120)
    limit("boundaries", len(p["boundaries"]), 10, 1)
    limit("sourceRefs", len(p["sourceRefs"]), 50)
    for i, t in enumerate(p["boundaries"]):
        if t not in bb:
            limit(f"boundaries[{i}]", len(t), 160)
    if sum(len(t["text"]) for d in p.get("exampleDialogues", []) for t in d["turns"]) > 800:
        report("exampleDialogues", "example_total")
    lids = set()
    for i, e in enumerate(p.get("lore", [])):
        if e["id"] in lids:
            report(f"lore[{i}].id", "lore_duplicate_id")
        if not e["id"].startswith("lore-"):
            report(f"lore[{i}].id", "lore_id_prefix")
        lids.add(e["id"])
        if serialized_bytes(render_lore_message([e])) > LORE_BYTE_LIMIT:
            report(f"lore[{i}]", "budget_lore_entry")
    if serialized_bytes(render_persona_block(p)) > PERSONA_BLOCK_BYTE_LIMIT:
        report("", "budget_persona_block")
    if real and not test_captions:
        report("", "leak_check_unavailable")
    leaks = set().union(*(_windows(t) for t in test_captions)) if test_captions else set()
    es = bs | set((generated or {}).get("style", []))
    eb = bb | set((generated or {}).get("boundaries", []))
    for path, text, group in _author_fields(p):
        folded = _check_form(text)

        def matches(pattern):
            return bool(pattern.search(text) or pattern.search(folded))

        visible = text.replace("\n", "") if path == "meta.creatorNotes" else text
        visible = regex.sub(r"([0-9#*])\uFE0F\u20E3", r"\1", visible)
        visible = regex.sub(
            (
                "(?<=\\p{Extended_Pictographic}\\uFE0F?[\\U0001F3FB-\\U0001F3FF]?)\\u200D(?="
                "\\p{Extended_Pictographic})"
            ),
            "",
            visible,
        )
        visible = regex.sub(r"(?<=\p{Extended_Pictographic})\uFE0F", "", visible)
        if regex.search(
            (
                "[\\p{Cf}\\p{Cc}\\p{Co}\\p{Cn}\\u2028\\u2029\\u034F\\u115F\\u1160\\u3164\\uFFA0"
                "\\u2800\\u180B-\\u180F\\uFE00-\\uFE0F\\U000E0100-\\U000E01EF]|[A-Za-z]\\p{M}"
            ),
            visible,
        ):
            report(path, "invisible_char")
        if any(
            regex.search(r"\p{Script=Latin}", w)
            and regex.search(
                (
                    "[^\\p{Script=Latin}\\p{Script=Common}\\p{Script=Inherited}\\p{Script=Hangu"
                    "l}\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]"
                ),
                w,
            )
            for w in regex.findall(r"\p{L}+", text)
        ):
            report(path, "homoglyph")
        for rule, patterns in _FORBIDDEN:
            if any(matches(pt) for pt in patterns):
                report(path, rule)
        if contains_credential(text) or contains_credential(folded):
            report(path, "credential")
        if contains_internal_path(text) or contains_internal_path(folded):
            report(path, "internal_path")
        exempt = (
            path.startswith("style[")
            and text in es
            or path.startswith("boundaries[")
            and text in eb
        )
        if group not in ("label", "meta") and not exempt and _windows(text) & leaks:
            report(path, "test_caption_overlap")
        if (
            real
            and group in ("greeting", "personality", "background", "example", "lore")
            and any(matches(pt) for pt in _PRIVATE)
        ):
            report(path, "private_life")
        from .safety import contains_ungrounded_biography

        if group in ("greeting", "personality", "example") and (
            contains_ungrounded_biography(text) or contains_ungrounded_biography(folded)
        ):
            report(path, "biography", "error" if real else "warn")
        if group not in ("label", "meta") and any(pt.search(text) for pt in _DATE_PLACE):
            report(path, "date_place", "warn")
    refs = (
        [(f"sourceRefs[{i}]", r) for i, r in enumerate(p["sourceRefs"])]
        + [
            (f"background.sourceRefs[{i}]", r)
            for i, r in enumerate(p.get("background", {}).get("sourceRefs", []))
        ]
        + [
            (f"lore[{lore_index}].sourceRefs[{i}]", r)
            for lore_index, e in enumerate(p.get("lore", []))
            for i, r in enumerate(e["sourceRefs"])
        ]
    )
    for path, ref in refs:
        try:
            if source_ref_exists is None:
                report(path, "source_lookup_failed")
                continue
            exists = source_ref_exists(ref, p["personId"])
            if inspect.isawaitable(exists):
                exists = await exists
            if not exists:
                report(path, "source_missing")
        except Exception:
            report(path, "source_lookup_failed")
    return {
        "ok": not any(i["severity"] == "error" for i in issues),
        "issues": issues,
        "lintRevision": PERSONA_LINT_REVISION,
    }
