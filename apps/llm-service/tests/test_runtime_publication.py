"""Publication/admission selects an approved registry, never every imported variant."""

import copy
import json

import pytest
from core_domain_test import PERSONA

from ptr_llm.billing import ProviderError
from ptr_llm.runtime import Runtime


def card(name, person=None):
    return dict(
        copy.deepcopy(PERSONA),
        id="synthetic-" + name,
        personId="synthetic-person-" + (person or name),
        revision="synthetic-v1",
    )


def write(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")
    return str(path)


def selection(env):
    from ptr_llm.runtime import _load_publication

    return _load_publication(
        env, "postgresql://ptr_split_llm:synthetic@127.0.0.1:58432/ptr_split_test"
    )


class Canonical:
    def __init__(self, documents):
        self.documents = documents

    async def list(self):
        return copy.deepcopy(self.documents)


def runtime(documents, publication):
    return Runtime(
        None,
        Canonical(documents),
        None,
        None,
        None,
        None,
        "fake",
        "synthetic",
        publication=publication,
    )


async def test_generated_order_authored_override_and_append_use_canonical_cards(tmp_path):
    a, b, authored_a, c = card("a"), card("b"), card("authored-a", "a"), card("c")
    env = {
        "PTR_PERSONAS_FILE": write(tmp_path / "generated.json", [a, b]),
        "PTR_AUTHORED_PERSONAS_FILE": write(
            tmp_path / "authored.json", {"database": "ptr_split_test", "personas": [authored_a, c]}
        ),
    }
    approved = selection(env)
    db = [card("unapproved-variant", "a"), c, b, a, authored_a]
    public = await runtime(db, approved).catalogue()
    assert [p["id"] for p in public] == [authored_a["id"], b["id"], c["id"]]
    assert all("concept" not in p and "sourceRefs" not in p for p in public)
    assert db == [card("unapproved-variant", "a"), c, b, a, authored_a]


async def test_approved_catalogue_carries_only_public_card_copy(tmp_path):
    approved = dict(card("a"), tagline="붓과 색", starters=["무슨 색?", "요즘 뭐 그려?"])
    unapproved = dict(card("unapproved", "a"), tagline="비공개", starters=["보이면 안 돼"])
    env = {"PTR_PERSONAS_FILE": write(tmp_path / "approved.json", [approved])}
    public = await runtime([unapproved, approved], selection(env)).catalogue()
    assert public[0]["tagline"] == "붓과 색"
    assert public[0]["starters"] == ["무슨 색?", "요즘 뭐 그려?"]
    assert "identity" not in public[0]
    assert "비공개" not in json.dumps(public, ensure_ascii=False)


async def test_unset_authored_file_is_not_discovered_and_plain_array_is_supported(
    tmp_path, monkeypatch
):
    a, authored = card("a"), card("authored-a", "a")
    monkeypatch.chdir(tmp_path)
    default = tmp_path / "data" / "research"
    default.mkdir(parents=True)
    write(default / "personas.json", [a])
    write(default / "personas.authored.json", [authored])
    approved = selection({"PTR_LLM_PROVIDER": "local"})
    assert [p["id"] for p in await runtime([a, authored], approved).catalogue()] == [a["id"]]
    approved = selection(
        {
            "PTR_PERSONAS_FILE": str(default / "personas.json"),
            "PTR_AUTHORED_PERSONAS_FILE": str(default / "personas.authored.json"),
        }
    )
    assert [p["id"] for p in await runtime([a, authored], approved).catalogue()] == [authored["id"]]


@pytest.mark.parametrize(
    "failure",
    [
        "generated-person",
        "authored-person",
        "selected-id",
        "database",
        "wrapper",
        "shape",
        "missing",
    ],
)
def test_invalid_publication_fails_closed_without_private_diagnostics(tmp_path, failure):
    a, b = card("a"), card("b")
    generated, authored = [a], []
    if failure == "generated-person":
        generated = [a, card("variant-a", "a")]
    elif failure == "authored-person":
        authored = [a, card("variant-a", "a")]
    elif failure == "selected-id":
        generated = [a, dict(b, id=a["id"])]
    elif failure == "database":
        authored = {"database": "synthetic-other", "personas": [b]}
    elif failure == "wrapper":
        authored = {"database": "ptr_split_test", "personas": [b], "private": True}
    elif failure == "shape":
        generated = {"personas": [a]}
    env = {
        "PTR_PERSONAS_FILE": write(tmp_path / "generated.json", generated),
        "PTR_AUTHORED_PERSONAS_FILE": write(tmp_path / "authored.json", authored),
    }
    if failure == "missing":
        env["PTR_PERSONAS_FILE"] = str(tmp_path / "private-missing.json")
    with pytest.raises(ProviderError, match="PERSONA_UNAVAILABLE") as error:
        selection(env)
    assert str(error.value) == "PERSONA_UNAVAILABLE"


@pytest.mark.parametrize("failure", ["missing", "revision", "person", "content", "duplicate-id"])
async def test_selected_current_canonical_card_must_match_every_approved_binding(tmp_path, failure):
    approved = card("a")
    publication = selection({"PTR_PERSONAS_FILE": write(tmp_path / "approved.json", [approved])})
    canonical = copy.deepcopy(approved)
    if failure == "missing":
        documents = [card("other")]
    elif failure == "duplicate-id":
        documents = [canonical, copy.deepcopy(canonical)]
    else:
        canonical[{"revision": "revision", "person": "personId", "content": "concept"}[failure]] = (
            "synthetic-mismatch"
        )
        documents = [canonical]
    with pytest.raises(ProviderError, match="PERSONA_UNAVAILABLE"):
        await runtime(documents, publication).catalogue()


async def test_unset_fake_compatibility_is_explicit_not_a_real_provider_default():
    assert selection({}) is None
    assert selection({"PTR_LLM_PROVIDER": "fake"}) is None
    db = [card("a"), card("other-a", "a")]
    assert len(await runtime(db, None).catalogue()) == 2


async def test_explicit_bound_snapshot_is_exclusive_without_default_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    approved = card("approved")
    env = {
        "PTR_LLM_PROVIDER": "local",
        "PTR_LLM_PUBLISHED_PERSONAS_FILE": write(
            tmp_path / "published.json", {"database": "ptr_split_test", "personas": [approved]}
        ),
        "PTR_PERSONAS_FILE": str(tmp_path / "not-read-generated.json"),
        "PTR_AUTHORED_PERSONAS_FILE": str(tmp_path / "not-read-authored.json"),
    }
    assert [
        p["id"] for p in await runtime([approved, card("other")], selection(env)).catalogue()
    ] == [approved["id"]]


@pytest.mark.parametrize(
    "value",
    [
        [],
        {"database": "synthetic-other", "personas": []},
        {"database": "ptr_split_test", "personas": [], "extra": True},
        {"database": "ptr_split_test", "personas": [card("a"), card("variant-a", "a")]},
        {
            "database": "ptr_split_test",
            "personas": [card("a"), dict(card("b"), id=card("a")["id"])],
        },
    ],
)
def test_explicit_snapshot_rejects_unbound_ambiguous_or_wrong_database(tmp_path, value):
    with pytest.raises(ProviderError, match="PERSONA_UNAVAILABLE"):
        selection({"PTR_LLM_PUBLISHED_PERSONAS_FILE": write(tmp_path / "published.json", value)})


async def test_snapshot_detaches_caller_file_and_rechecks_current_pointer(tmp_path):
    approved = card("a")
    path = tmp_path / "published.json"
    publication = selection(
        {
            "PTR_LLM_PUBLISHED_PERSONAS_FILE": write(
                path, {"database": "ptr_split_test", "personas": [approved]}
            )
        }
    )
    built = runtime([approved], publication)
    publication[0]["concept"] = "synthetic-caller-mutation"
    write(path, {"database": "ptr_split_test", "personas": [card("unapproved")]})
    assert (await built.catalogue())[0]["id"] == approved["id"]
    built.personas.documents[0]["revision"] = "synthetic-v2"
    with pytest.raises(ProviderError, match="PERSONA_UNAVAILABLE"):
        await built.catalogue()


@pytest.mark.parametrize("failure", [None, "content", "binding"])
async def test_factory_validates_registry_before_provider_and_cleans_failure(
    tmp_path, monkeypatch, failure
):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module

    approved = card("a")
    current = copy.deepcopy(approved)
    if failure == "content":
        current["concept"] = "synthetic-content-drift"
    canonical = Canonical([current, card("unpublished")])
    providers = []
    original = module.FakeTextProvider

    def create():
        providers.append(True)
        return original()

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr(module, "PostgresPersonaRepository", lambda *_: canonical)
    monkeypatch.setattr(module, "FakeTextProvider", create)
    env = {
        "PTR_LLM_PUBLISHED_PERSONAS_FILE": write(
            tmp_path / "published.json",
            {
                "database": "synthetic-other" if failure == "binding" else "ptr_split_test",
                "personas": [approved],
            },
        )
    }
    if failure:
        with pytest.raises(ProviderError, match="PERSONA_UNAVAILABLE"):
            await module.build_runtime(_settings(), env)
        assert providers == [] and FakePool.instances[-1].closed
    else:
        built = await module.build_runtime(_settings(), env)
        assert [p["id"] for p in await built.catalogue()] == [approved["id"]]
        assert providers == [True]
        await built.close()
        assert FakePool.instances[-1].closed


def test_repeated_json_object_key_is_not_an_ambiguous_approval(tmp_path):
    path = tmp_path / "published.json"
    path.write_text(
        '{"database":"synthetic-other","database":"ptr_split_test","personas":[]}', encoding="utf-8"
    )
    with pytest.raises(ProviderError, match="PERSONA_UNAVAILABLE"):
        selection({"PTR_LLM_PUBLISHED_PERSONAS_FILE": str(path)})


async def test_publication_does_not_rewrite_historical_session_execution(tmp_path):
    from types import SimpleNamespace

    async def handle(grant, **options):
        return grant

    built = runtime(
        [card("a")],
        selection({"PTR_PERSONAS_FILE": write(tmp_path / "approved.json", [card("a")])}),
    )
    built.domain_engine = SimpleNamespace(handle=handle)
    historical = {
        "context": {
            "session": {
                "personaId": "synthetic-history-variant",
                "personaRevision": "synthetic-history-v0",
            }
        }
    }
    assert await built.handle(historical) == historical
