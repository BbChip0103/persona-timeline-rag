from pathlib import Path

import pytest

from ptr_llm.billing import ProviderError
from ptr_llm.core.errors import CoreError
from ptr_llm.repositories import (
    PostgresPersonaRepository,
    PostgresRetrieval,
    PostgresSourceRepository,
)
from ptr_llm.repositories.database import assert_llm_database_url
from ptr_llm.repositories.results import receipt_hash
from ptr_llm.repositories.sources import checked_vector, parameters, validate_source

URL = "postgresql://ptr_split_llm:synthetic@127.0.0.1:58432/ptr_split_test"
QUERY = {
    "personId": "synthetic-person",
    "dateBasis": "posted",
    "timezone": "Asia/Seoul",
    "limit": 100,
}
SOURCE = {
    "id": "synthetic-source",
    "personId": "synthetic-person",
    "caption": "합성 캡션",
    "postedAt": "2026-01-01T00:00:00Z",
    "eventDate": None,
    "sourceUrl": "https://example.invalid/fixture",
    "hash": "synthetic-hash",
    "snapshot": "synthetic-snapshot",
    "unsafe": False,
}


@pytest.mark.parametrize(
    "url",
    [
        "postgresql://ptr_goal1:x@127.0.0.1:56432/ptr_goal1",
        "postgresql://ptr_split_llm:x@prod.invalid:58432/ptr_split_test",
        "postgresql://ptr_split_app:x@127.0.0.1:58432/ptr_split_test",
        URL + "?options=search_path%3Dapp",
        URL.replace("58432", "5432"),
    ],
)
def test_database_guard(url):
    with pytest.raises(ProviderError, match="UNSAFE_DATABASE_URL"):
        assert_llm_database_url(url)


def test_db_guard_valid_and_pool_binding():
    assert_llm_database_url(URL)

    class Pool:
        conninfo = URL.replace("ptr_split_test", "ptr_split_research")

    with pytest.raises(ProviderError, match="UNSAFE_DATABASE_POOL"):
        PostgresPersonaRepository(Pool(), URL)


def test_disposable_immersion_database_port_requires_exact_opt_in(monkeypatch):
    url = URL.replace("58432", "54321")
    monkeypatch.setenv("PTR_IMMERSION_GATE_PROJECT", "ptr-immersion-0123456789")
    monkeypatch.setenv("PTR_IMMERSION_GATE_DB_PORT", "54321")
    monkeypatch.setenv("PTR_LLM_SPILLOVER", "off")
    assert_llm_database_url(url)
    with pytest.raises(ProviderError, match="UNSAFE_DATABASE_URL"):
        assert_llm_database_url(url.replace("ptr_split_test", "ptr_split_research"))
    monkeypatch.delenv("PTR_IMMERSION_GATE_PROJECT")
    with pytest.raises(ProviderError, match="UNSAFE_DATABASE_URL"):
        assert_llm_database_url(url)


@pytest.mark.parametrize(
    ("url", "allowlist"),
    [
        (
            "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/ptr_split_research",
            "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research",
        ),
        (
            "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
            "ptr_split_research?sslmode=require",
            "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research",
        ),
        (
            "postgres://ptr_split_owner:synthetic@managed-postgres.example.com:5432/"
            "ptr_split_test?sslmode=verify-full",
            "postgres://ptr_split_owner@managed-postgres.example.com:5432/ptr_split_test",
        ),
    ],
)
def test_database_guard_cluster_allowlist(monkeypatch, url, allowlist):
    monkeypatch.setenv("PTR_NETWORK_MODE", "cluster")
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    monkeypatch.setenv("PTR_LLM_DATABASE_URL_ALLOWLIST", allowlist)
    assert_llm_database_url(url)


@pytest.mark.parametrize(
    ("url", "allowlist"),
    [
        (
            "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/ptr_split_research",
            "",
        ),
        (
            "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
            "ptr_split_research?connect_timeout=1",
            "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research",
        ),
        (
            "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
            "ptr_split_research?sslmode=disable",
            "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research",
        ),
        (
            "postgresql://ptr_split_app:synthetic@postgres.ptr-data.svc:5432/"
            "ptr_split_research?sslmode=require",
            "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research",
        ),
    ],
)
def test_database_guard_cluster_rejections(monkeypatch, url, allowlist):
    monkeypatch.setenv("PTR_NETWORK_MODE", "cluster")
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.0.0.1")
    monkeypatch.setenv("PTR_LLM_DATABASE_URL_ALLOWLIST", allowlist)
    with pytest.raises(ProviderError, match="UNSAFE_DATABASE_URL"):
        assert_llm_database_url(url)


def test_source_canonical_order_and_validation():
    assert list(validate_source(dict(reversed(list(SOURCE.items()))))) == list(SOURCE)
    with pytest.raises(CoreError):
        validate_source({**SOURCE, "generated": True})
    with pytest.raises(CoreError):
        validate_source({**SOURCE, "postedAt": "2026-01-01"})


@pytest.mark.parametrize(
    "change",
    [
        {"personId": "other"},
        {"timezone": "INVALID"},
        {"start": "2026-01-01"},
        {"start": "2026-02-01", "end": "2026-01-01"},
        {"limit": True},
        {"query": ""},
        {"privateScope": True},
    ],
)
def test_query_scope_failclosed(change):
    with pytest.raises(CoreError):
        parameters({**QUERY, **change}, {"personId": "synthetic-person"})


def test_vector_checked_float32_and_receipt_hash_order():
    assert checked_vector([0.123456789] * 1536).startswith("[0.123456791")
    with pytest.raises(CoreError):
        checked_vector([0] * 1536)
    with pytest.raises(CoreError):
        checked_vector([float("inf")] * 1536)
    assert receipt_hash({"a": 1, "b": {"d": 2, "c": 1}}) == receipt_hash(
        {"b": {"c": 1, "d": 2}, "a": 1}
    )


@pytest.mark.asyncio
async def test_retrieval_semantic_scope_before_embed_and_augmented_queries():
    class Pool:
        conninfo = URL

    sources = PostgresSourceRepository(Pool(), URL)
    calls = []

    async def fetch(sql, values, **options):
        calls.append((sql, values))
        return [{"document": SOURCE, "annotations": None}]

    sources.fetch = fetch
    assert await sources.search_lexical(
        {**QUERY, "query": "합성 合成"},
        {"personId": "synthetic-person"},
        evidence_scope="caption_image",
    ) == [SOURCE]
    assert "llm.source_image_revisions" in calls[0][0] and "NOT p.unsafe" in calls[0][0]
    assert calls[0][1][6] == ["합성", "合成"]
    embeds = []

    async def embed(text, **options):
        embeds.append(text)
        return [1.0] * 1536

    retrieval = PostgresRetrieval(sources, embed=embed, model_revision="synthetic-model")
    with pytest.raises(CoreError, match="FORBIDDEN"):
        await retrieval.search(
            {**QUERY, "personId": "other"}, {"personId": "synthetic-person"}, mode="semantic"
        )
    assert not embeds
    await retrieval.search(
        QUERY, {"personId": "synthetic-person"}, mode="semantic", evidence_scope="caption_image"
    )
    assert embeds == [""] and "llm.source_image_vectors" in calls[-1][0]
    assert "ORDER BY ordinal DESC" in calls[-1][0] and "<=>" in calls[-1][0]


@pytest.mark.asyncio
async def test_remembered_evidence_pins_hash_snapshot_and_revision():
    class Pool:
        conninfo = URL

    sources = PostgresSourceRepository(Pool(), URL)
    annotation = {
        "id": "synthetic-ann",
        "imageHash": "a" * 64,
        "annotationHash": "b" * 64,
        "revision": "v1",
        "text": "합성 이미지",
        "model": "synthetic",
        "humanReviewed": False,
    }
    calls = []

    async def fetch(sql, values, **options):
        calls.append(sql)
        return [{"index": 0, "document": SOURCE, "annotation": annotation}]

    sources.fetch = fetch
    ref = {
        "personId": SOURCE["personId"],
        "sourceId": SOURCE["id"],
        "hash": SOURCE["hash"],
        "snapshot": SOURCE["snapshot"],
        "quote": "합성",
        "annotationId": annotation["id"],
        "annotationRevision": "v1",
        "imageHash": "a" * 64,
        "annotationHash": "b" * 64,
        "origin": "ai_image_annotation",
    }
    assert await sources.resolve_evidence(
        [ref], {"personId": SOURCE["personId"]}, evidence_scope="caption_image"
    ) == [{**SOURCE, "imageAnnotations": [annotation]}]
    assert (
        "p.source_hash=refs.source_hash" in calls[0]
        and "a.annotation_hash=refs.annotation_hash" in calls[0]
    )
    assert (
        await sources.resolve_evidence(
            [{**ref, "annotationRevision": "v2"}], {"personId": SOURCE["personId"]}
        )
        == []
    )
    with pytest.raises(CoreError):
        await sources.resolve_evidence(
            [{**ref, "imageHash": None}], {"personId": SOURCE["personId"]}
        )


def test_no_backend_schema_sql_or_runtime_ddl():
    directory = Path(__file__).parents[1] / "src" / "ptr_llm"
    for folder in ("billing", "repositories"):
        source = "\n".join(p.read_text() for p in (directory / folder).glob("*.py"))
        assert " app." not in source and " public." not in source
        assert "CREATE TABLE" not in source and "TRUNCATE" not in source
