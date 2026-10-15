"""Synthetic framework migration regressions; shared wire contracts stay authoritative."""

import copy
import json
import time

import httpx
import pytest
from fastapi.routing import APIRoute
from pydantic import ValidationError

from ptr_llm.config import Settings
from ptr_llm.core import evidence
from ptr_llm.core.errors import CoreError
from ptr_llm.core.persona import Persona, persona_revision, validate_persona
from ptr_llm.server import create_app

PERSONA = {
    "id": "synthetic-card",
    "personId": "synthetic-person",
    "label": "Synthetic",
    "language": "en",
    "revision": "synthetic-v1",
    "reviewStatus": "synthetic",
    "identity": "AI simulation",
    "concept": "Synthetic test card",
    "style": ["Friendly"],
    "boundaries": ["No claims about real people"],
    "sourceRefs": [],
    "greeting": "Hello",
}


def full_persona():
    return dict(
        copy.deepcopy(PERSONA),
        id="  synthetic-card  ",
        sourceRefs=["  synthetic-source  "],
        alternateGreetings=["  Alternate  "],
        personality={
            "summary": "  Summary  ",
            "traits": ["  Kind  "],
            "values": ["  Truth  "],
            "speechHabits": ["  Brief  "],
        },
        background={"text": "  Context  ", "sourceRefs": ["  synthetic-source  "]},
        exampleDialogues=[
            {
                "turns": [
                    {"speaker": "user", "text": "  Hi  "},
                    {"speaker": "character", "text": "  Hello  "},
                ]
            }
        ],
        lore=[
            {
                "id": "  synthetic-lore  ",
                "keys": ["  topic  "],
                "content": "  Lore  ",
                "sourceRefs": ["  synthetic-source  "],
            }
        ],
        meta={"tags": ["  test  "], "creatorNotes": "  Notes  "},
    )


def test_native_persona_fields_own_normalization_not_postprocessing():
    raw = full_persona()
    before = copy.deepcopy(raw)
    native = Persona.model_validate(raw).model_dump(exclude_none=True)
    assert native == validate_persona(raw)
    assert raw == before
    assert native["personality"] == {
        "summary": "Summary",
        "traits": ["Kind"],
        "values": ["Truth"],
        "speechHabits": ["Brief"],
    }
    assert native["background"] == {"text": "Context", "sourceRefs": ["synthetic-source"]}
    assert native["exampleDialogues"][0]["turns"][0]["text"] == "Hi"
    assert native["lore"][0] == {
        "id": "synthetic-lore",
        "keys": ["topic"],
        "content": "Lore",
        "priority": 50,
        "sourceRefs": ["synthetic-source"],
    }
    assert native["meta"] == {"tags": ["test"], "creatorNotes": "Notes"}
    assert persona_revision(raw) == persona_revision(native)


@pytest.mark.parametrize(
    "optional",
    ["alternateGreetings", "personality", "background", "exampleDialogues", "lore", "meta"],
)
def test_native_explicit_optional_null_is_rejected(optional):
    raw = dict(PERSONA, **{optional: None})
    with pytest.raises(ValidationError):
        Persona.model_validate(raw)
    with pytest.raises(CoreError, match="^INVALID_INPUT$"):
        validate_persona(raw)


def test_nullable_nested_metadata_still_disappears_without_new_rejection():
    raw = dict(
        PERSONA,
        personality={"summary": None, "traits": [], "values": [], "speechHabits": []},
        meta={"tags": None, "creatorNotes": None},
    )
    assert validate_persona(raw) == dict(
        PERSONA, personality={"traits": [], "values": [], "speechHabits": []}, meta={}
    )


@pytest.mark.parametrize(
    "path,maximum,minimum",
    [
        (("sourceRefs", 0), 200, 1),
        (("alternateGreetings", 0), 300, 1),
        (("personality", "summary"), 300, 1),
        (("personality", "traits", 0), 40, 1),
        (("personality", "values", 0), 60, 1),
        (("personality", "speechHabits", 0), 80, 1),
        (("background", "text"), 500, 1),
        (("background", "sourceRefs", 0), 200, 1),
        (("exampleDialogues", 0, "turns", 0, "text"), 200, 1),
        (("lore", 0, "id"), 200, 1),
        (("lore", 0, "content"), 300, 1),
        (("lore", 0, "keys", 0), 40, 2),
        (("lore", 0, "sourceRefs", 0), 200, 1),
        (("meta", "tags", 0), 30, 1),
        (("meta", "creatorNotes"), 2000, 1),
    ],
)
def test_native_nested_string_boundaries_are_strict_and_trimmed(path, maximum, minimum):
    for size, okay in [
        (minimum - 1, False),
        (minimum, True),
        (maximum, True),
        (maximum + 1, False),
    ]:
        raw = full_persona()
        target = raw
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = " \t" + "😀" * size + "\n "
        if okay:
            assert Persona.model_validate(raw).model_dump(exclude_none=True) == validate_persona(
                raw
            )
        else:
            with pytest.raises(ValidationError):
                Persona.model_validate(raw)
            with pytest.raises(CoreError, match="^INVALID_INPUT$"):
                validate_persona(raw)


@pytest.mark.parametrize("whitespace", ["\u001c", "\u0085", "\u00a0", "\u2000", "\u202f"])
def test_python_strip_semantics_not_sdk_rust_trim(whitespace):
    raw = dict(PERSONA, sourceRefs=[whitespace + "synthetic-source" + whitespace])
    assert Persona.model_validate(raw).sourceRefs == ["synthetic-source"]


def test_unbounded_core_text_and_truthy_whitespace_are_unchanged():
    raw = dict(
        PERSONA,
        label=" ",
        language=" ",
        greeting=" ",
        identity="  kept  ",
        concept="  kept  ",
        style=["", "  kept  "],
        boundaries=[""],
        sourceRefs=[],
    )
    assert validate_persona(raw) == raw


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
@pytest.mark.parametrize("field", ["label", "language", "greeting"])
def test_persona_nonempty_fields_preserve_escaped_lone_surrogates(field, surrogate):
    raw = dict(PERSONA, **{field: surrogate})
    assert validate_persona(raw) == raw


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
def test_trimmed_persona_fields_preserve_lone_surrogates_and_python_whitespace(surrogate):
    raw = full_persona()
    value = "\x1c a" + surrogate + " \x1c"
    paths = [
        ("id",),
        ("personId",),
        ("revision",),
        ("sourceRefs", 0),
        ("alternateGreetings", 0),
        ("personality", "summary"),
        ("personality", "traits", 0),
        ("personality", "values", 0),
        ("personality", "speechHabits", 0),
        ("background", "text"),
        ("background", "sourceRefs", 0),
        ("exampleDialogues", 0, "turns", 0, "text"),
        ("lore", 0, "id"),
        ("lore", 0, "keys", 0),
        ("lore", 0, "content"),
        ("lore", 0, "sourceRefs", 0),
        ("meta", "tags", 0),
        ("meta", "creatorNotes"),
    ]
    for path in paths:
        target = raw
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = value
    native = Persona.model_validate(raw).model_dump(exclude_none=True)
    assert native == validate_persona(raw)
    for path in paths:
        target = native
        for key in path:
            target = target[key]
        assert target == "a" + surrogate


@pytest.mark.parametrize(
    "field,value",
    [
        ("id", 1),
        ("revision", " " * 2),
        ("personId", "x" * 201),
        ("label", ""),
        ("sourceRefs", ("source",)),
        ("style", [1]),
        ("reviewStatus", "published"),
        (
            "lore",
            [
                {
                    "id": "id",
                    "keys": ["key"],
                    "content": "content",
                    "priority": True,
                    "sourceRefs": ["source"],
                }
            ],
        ),
    ],
)
def test_persona_invalid_input_remains_sanitized(field, value):
    with pytest.raises(CoreError, match="^INVALID_INPUT$"):
        validate_persona(dict(PERSONA, **{field: value}))


def model_reply(**changes):
    return {"status": "answered", "answer": "Synthetic", "evidenceRefs": [], **changes}


def test_reply_structural_validation_uses_native_model(monkeypatch):
    calls = []
    model = evidence._ModelReply
    original = model.model_validate

    def validate(value, **options):
        calls.append(value)
        return original(value, **options)

    monkeypatch.setattr(model, "model_validate", validate)
    raw = model_reply()
    assert evidence._parse(json.dumps(raw)) == raw
    assert calls == [raw]


@pytest.mark.parametrize(
    "answer,valid",
    [("a" * 8000, True), ("a" * 8001, False), ("😀" * 4000, True), ("😀" * 4001, False)],
)
def test_reply_utf16_cap_not_pydantic_codepoint_cap(answer, valid):
    raw = json.dumps(model_reply(answer=answer))
    if valid:
        assert evidence._parse(raw)["answer"] == answer
    else:
        with pytest.raises(ValueError):
            evidence._parse(raw)


@pytest.mark.parametrize(
    "ref",
    [
        {"sourceId": "s", "quote": "q", "start": True, "end": 1},
        {"sourceId": "s", "quote": "q", "start": 0.0, "end": 1},
        {"sourceId": "s", "quote": "q", "start": -1, "end": 1},
        {"sourceId": "s", "quote": "q", "start": 0, "end": 0},
        {"sourceId": "s", "quote": "q", "start": 0},
        {"sourceId": "s", "quote": "q", "end": 1},
        {"sourceId": "s", "quote": "q", "start": None, "end": 1},
        {"sourceId": "", "quote": "q"},
        {"sourceId": "s", "quote": ""},
        {"sourceId": "s", "quote": "q", "extra": "no"},
    ],
)
def test_reply_reference_strict_structure(ref):
    with pytest.raises(ValueError):
        evidence._parse(json.dumps(model_reply(evidenceRefs=[ref])))


@pytest.mark.parametrize("annotation", [None, "", 0, False, {}, [], {"synthetic": "value"}])
def test_structural_validation_does_not_invent_annotation_provenance_rule(annotation):
    raw = model_reply(
        evidenceRefs=[
            {"quote": " ", "annotationId": annotation, "sourceId": " ", "end": 1, "start": 0}
        ]
    )
    result = evidence._parse(json.dumps(raw))
    assert result == raw
    assert list(result["evidenceRefs"][0]) == list(raw["evidenceRefs"][0])


@pytest.mark.parametrize("surrogate", ["\ud800", "\udfff"])
@pytest.mark.parametrize("field", ["sourceId", "quote"])
def test_reply_reference_preserves_escaped_lone_surrogates(field, surrogate):
    ref = {"sourceId": "source", "quote": "quote", field: surrogate}
    raw = model_reply(evidenceRefs=[ref])
    assert evidence._parse(json.dumps(raw)) == raw


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "unknown"},
        {"answer": 1},
        {"evidenceRefs": {}},
        {"evidenceRefs": [{"sourceId": "s", "quote": "q"}] * 101},
        {"extra": True},
    ],
)
def test_reply_top_level_strict_structure(changes):
    with pytest.raises(ValueError):
        evidence._parse(json.dumps(model_reply(**changes)))


def settings():
    return Settings(
        redis_url="redis://127.0.0.1:6379/0",
        backend_url="http://127.0.0.1:58441",
        control_token="synthetic-control-token",
        database_url="postgresql://llm:synthetic@localhost/research",
    )


def app_and_calls():
    calls = []

    async def catalogue():
        calls.append("catalogue")
        return []

    async def draft(body):
        calls.append(body)
        return {"contractVersion": 2, "content": "Synthetic", "provider": "fake", "model": "fake"}

    return create_app(settings(), catalogue=catalogue, draft=draft), calls


def test_internal_routes_use_actual_fastapi_auth_dependencies():
    app, _ = app_and_calls()
    routes = {route.path: route for route in app.routes if isinstance(route, APIRoute)}
    for path in ["/internal/llm/personas", "/internal/llm/draft"]:
        dependencies = routes[path].dependant.dependencies
        assert len(dependencies) == 1
        assert dependencies[0].call.__name__ == "authenticate"
    for path in ["/health/live", "/health/ready"]:
        assert routes[path].dependant.dependencies == []


@pytest.mark.parametrize(
    "authorization", [None, b"Bearer wrong", b"bearer synthetic-control-token"]
)
async def test_auth_dependency_precedes_any_body_receive(authorization):
    app, calls = app_and_calls()
    sent, reads = [], []

    async def receive():
        reads.append(True)
        raise AssertionError("unauthorized body must never be read")

    async def send(message):
        sent.append(message)

    headers = [(b"content-length", b"1000000")]
    if authorization is not None:
        headers.append((b"authorization", authorization))
    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/internal/llm/draft",
            "raw_path": b"/internal/llm/draft",
            "query_string": b"",
            "headers": headers,
            "server": ("synthetic", 80),
            "client": ("synthetic", 1),
        },
        receive,
        send,
    )
    assert sent[0]["status"] == 401
    assert json.loads(sent[1]["body"]) == {"detail": "UNAUTHORIZED"}
    assert reads == calls == []


@pytest.mark.parametrize(
    "size,status,detail", [(65536, 400, "INVALID_DRAFT_REQUEST"), (65537, 413, "DRAFT_TOO_LARGE")]
)
async def test_authenticated_bounded_body_keeps_exact_byte_limit(size, status, detail):
    app, calls = app_and_calls()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        result = await client.post(
            "/internal/llm/draft",
            content=b"x" * size,
            headers={"Authorization": "Bearer synthetic-control-token"},
        )
    assert result.status_code == status and result.json() == {"detail": detail}
    assert calls == []


async def test_authenticated_draft_uses_shared_wire_contracts_and_sanitizes_failures():
    app, calls = app_and_calls()
    session = {
        "id": "00000000-0000-4000-8000-000000000001",
        "ownerId": "synthetic",
        "personId": "synthetic-person",
        "personaId": "synthetic-card",
        "personaRevision": "synthetic-v1",
        "language": "en",
        "timezone": "UTC",
        "retrievalMode": "off",
        "createdAt": "2026-10-11T00:00:00Z",
    }
    body = {
        "contractVersion": 2,
        "session": session,
        "brief": "Synthetic",
        "requestKey": "test",
        "deadlineAt": int((time.time() + 10) * 1000),
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        headers = {"Authorization": "Bearer synthetic-control-token"}
        result = await client.post("/internal/llm/draft", json=body, headers=headers)
        assert result.status_code == 200 and result.json()["content"] == "Synthetic"
        assert calls == [body]
        invalid = await client.post(
            "/internal/llm/draft", json={**body, "extra": True}, headers=headers
        )
        assert invalid.status_code == 400 and invalid.json() == {"detail": "INVALID_DRAFT_REQUEST"}
        assert calls == [body]
        old_peer = await client.post(
            "/internal/llm/draft", json={**body, "contractVersion": 1}, headers=headers
        )
        assert old_peer.status_code == 400
        assert old_peer.json() == {"detail": "WIRE_VERSION_MISMATCH"}
        assert calls == [body]


async def test_streamed_limit_stops_reading_without_parsing_or_draft_call():
    app, calls = app_and_calls()
    chunks = []

    async def stream():
        for size in [32768, 32769]:
            chunks.append(size)
            yield b"x" * size
        raise AssertionError("the request reader must stop at the byte limit")

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        result = await client.post(
            "/internal/llm/draft",
            content=stream(),
            headers={"Authorization": "Bearer synthetic-control-token"},
        )
    assert result.status_code == 413 and result.json() == {"detail": "DRAFT_TOO_LARGE"}
    assert chunks == [32768, 32769] and calls == []


@pytest.mark.parametrize(
    "error,status,detail",
    [
        (ValueError("private synthetic error"), 400, "INVALID_DRAFT_REQUEST"),
        (TimeoutError("private synthetic timeout"), 504, "DRAFT_TIMEOUT"),
        (RuntimeError("private synthetic failure"), 503, "DRAFT_UNAVAILABLE"),
    ],
)
async def test_native_auth_preserves_sanitized_draft_exception_codes(error, status, detail):
    async def catalogue():
        return []

    async def draft(_):
        raise error

    app = create_app(settings(), catalogue=catalogue, draft=draft)
    body = {
        "contractVersion": 2,
        "session": {
            "id": "00000000-0000-4000-8000-000000000001",
            "ownerId": "synthetic",
            "personId": "synthetic-person",
            "personaId": "synthetic-card",
            "personaRevision": "synthetic-v1",
            "language": "en",
            "timezone": "UTC",
            "retrievalMode": "off",
            "createdAt": "2026-10-11T00:00:00Z",
        },
        "brief": "Synthetic",
        "requestKey": "test",
        "deadlineAt": int((time.time() + 10) * 1000),
    }
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        result = await client.post(
            "/internal/llm/draft",
            json=body,
            headers={"Authorization": "Bearer synthetic-control-token"},
        )
    assert result.status_code == status and result.json() == {"detail": detail}


async def test_native_auth_keeps_health_public_and_catalogue_protected():
    app, calls = app_and_calls()
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        assert (await client.get("/internal/llm/personas")).status_code == 401
        assert calls == []
        for path in ["/health/live", "/health/ready"]:
            assert (await client.get(path, headers={"Authorization": "wrong"})).status_code == 200
        reply = await client.get(
            "/internal/llm/personas", headers={"Authorization": "Bearer synthetic-control-token"}
        )
    assert reply.status_code == 200 and reply.json() == {"contractVersion": 2, "personas": []}
    assert calls == ["catalogue"]
