"""Synthetic storage contracts; no external provider or research-data access."""

from contextlib import asynccontextmanager

import pytest

from ptr_llm.billing import ProviderError
from ptr_llm.core.errors import CoreError
from ptr_llm.repositories.sources import PostgresSourceRepository, annotation_hash
from ptr_llm.repositories.summaries import PostgresSummaryRepository, validate_summary

URL = "postgresql://ptr_split_llm:synthetic@127.0.0.1:58432/ptr_split_test"
POST = {
    "id": "synthetic-post",
    "personId": "synthetic-person",
    "caption": "합성 전시 방문",
    "postedAt": "2026-01-02T00:00:00Z",
    "eventDate": None,
    "sourceUrl": "https://example.test/post",
    "hash": "synthetic-hash",
    "snapshot": "synthetic-snapshot",
    "unsafe": False,
}


class Pool:
    conninfo = URL

    @asynccontextmanager
    async def connection(self):
        yield self

    @asynccontextmanager
    async def transaction(self):
        yield self


class Harness(PostgresSummaryRepository):
    def __init__(self, rows):
        super().__init__(Pool(), URL)
        self.rows = list(rows)
        self.calls = []

    async def fetch(self, sql, values=(), **kwargs):
        self.calls.append((sql, values, kwargs))
        assert self.rows, sql
        return self.rows.pop(0)


def test_three_lines_only_not_blank_or_boilerplate():
    assert validate_summary("날짜와 장소.\n무엇을 했다.\n사진의 관찰.")
    for text in ("한 줄", "하나\n\n셋", "하나\n둘\n셋\n넷", "하나\n둘\n명시되지 않았다."):
        with pytest.raises(CoreError, match="INVALID_INPUT"):
            validate_summary(text)


@pytest.mark.asyncio
async def test_summary_import_rejects_stale_parent_and_wrong_revision():
    source = {**POST, "annotationRevision": None, "annotationHash": None}
    repo = Harness([[{"summary_model": "model", "prompt_revision": "v1"}], []])
    with pytest.raises(CoreError, match="SUMMARY_SOURCE_STALE"):
        await repo.import_summary("run", source, "날짜.\n방문.\n풍경.", "model", "v1")
    assert len(repo.calls) == 2
    repo = Harness([[{"summary_model": "other", "prompt_revision": "v1"}]])
    with pytest.raises(CoreError, match="IDEMPOTENCY_CONFLICT"):
        await repo.import_summary("run", source, "날짜.\n방문.\n풍경.", "model", "v1")


@pytest.mark.asyncio
async def test_summary_idempotency_conflict():
    source = {**POST, "annotationRevision": None, "annotationHash": None}
    repo = Harness(
        [
            [{"summary_model": "model", "prompt_revision": "v1"}],
            [{"source_id": POST["id"]}],
            [],
            [{"content_hash": "different"}],
        ]
    )
    with pytest.raises(CoreError, match="IDEMPOTENCY_CONFLICT"):
        await repo.import_summary("run", source, "날짜.\n방문.\n풍경.", "model", "v1")


@pytest.mark.asyncio
async def test_vector_validation_precedes_sql():
    repo = Harness([])
    for vector in ([0] * 1536, [float("nan")] * 1536, [1] * 12):
        with pytest.raises(CoreError, match="INVALID_INPUT"):
            await repo.import_vector("run", POST["id"], "embed", vector)
    assert not repo.calls


@pytest.mark.asyncio
async def test_activation_incomplete_never_changes_pointer():
    repo = Harness([[], [{"complete": False}]])
    with pytest.raises(CoreError, match="SUMMARY_INDEX_INCOMPLETE"):
        await repo.activate_run("run", "embed")
    assert not any("INSERT INTO llm.active_summary_index" in sql for sql, _, _ in repo.calls)


@pytest.mark.asyncio
async def test_active_missing_and_stale_fail_closed():
    for rows in ([], [{"run_id": "run", "embedding_model_revision": "embed", "complete": False}]):
        repo = Harness([rows])
        with pytest.raises(CoreError, match="SUMMARY_INDEX_UNAVAILABLE"):
            await repo.active_run("embed")


@pytest.mark.asyncio
async def test_summary_search_uses_only_manifest_and_returns_original_evidence():
    repo = PostgresSourceRepository(Pool(), URL)
    calls = []

    async def fetch(sql, values=(), **kwargs):
        calls.append((sql, values))
        if "complete" in sql:
            return [{"run_id": "run", "embedding_model_revision": "embed", "complete": True}]
        return [{"document": POST, "annotations": [{"text": "unreviewed synthetic annotation"}]}]

    repo.fetch = fetch
    query = {"personId": POST["personId"], "dateBasis": "posted", "timezone": "UTC", "limit": 20}
    rows = await repo.search_semantic(
        query,
        {"personId": POST["personId"]},
        [1] * 1536,
        "embed",
        summary_index=True,
        evidence_scope="caption_image",
    )
    assert rows[0]["caption"] == POST["caption"]
    assert "summary" not in rows[0]
    assert rows[0]["imageAnnotations"]
    assert "llm.post_summary_vectors" in calls[-1][0]
    assert "llm.source_vectors" not in calls[-1][0]
    assert "llm.source_image_vectors" not in calls[-1][0]


@pytest.mark.asyncio
async def test_get_summaries_scoped_and_cancel_safe():
    import asyncio

    repo = Harness([])
    event = asyncio.Event()
    event.set()
    with pytest.raises(ProviderError, match="CANCELLED"):
        await repo.get_summaries([POST["id"]], POST["personId"], signal=event)
    assert not repo.calls


@pytest.mark.asyncio
async def test_native_pg_summary_index_atomicity_freshness_and_original_evidence():
    """Opt-in rollback-only synthetic DB proof, including real pgvector queries."""
    import os
    import uuid
    from urllib.parse import urlsplit

    import psycopg
    from psycopg.rows import dict_row

    from ptr_llm.repositories.database import assert_llm_database_url

    url = os.environ.get("PTR_PROVIDER_PG_TEST_URL")
    if not url:
        pytest.skip("explicit synthetic PG target not provided")
    assert_llm_database_url(url)
    assert urlsplit(url).path == "/ptr_split_test"
    assert urlsplit(url).username == "ptr_split_llm"
    conn = await psycopg.AsyncConnection.connect(url, autocommit=True, row_factory=dict_row)

    class ConnectionPool:
        conninfo = url

        @asynccontextmanager
        async def connection(self):
            yield conn

    try:
        async with conn.transaction(force_rollback=True):
            async with conn.cursor() as cur:
                await cur.execute(
                    "SELECT count(*) AS n FROM llm.source_posts "
                    "WHERE origin='licensed_source' AND NOT unsafe"
                )
                if (await cur.fetchone())["n"]:
                    pytest.skip(
                        "synthetic summary proof requires no pre-existing licensed fixtures"
                    )
            repo = PostgresSummaryRepository(ConnectionPool(), url)
            sources = PostgresSourceRepository(ConnectionPool(), url)
            suffix = uuid.uuid4().hex
            first = {**POST, "id": "summary-test-a-" + suffix, "personId": "summary-test-" + suffix}
            second = {**first, "id": "summary-test-b-" + suffix}
            await sources.import_posts([first, second], "licensed_source")
            await sources.import_posts(
                [{**first, "id": "summary-test-unsafe-" + suffix, "unsafe": True}],
                "licensed_source",
            )
            await sources.import_posts(
                [{**first, "id": "summary-test-fixture-" + suffix}],
                "synthetic_fixture",
            )
            records = await repo.list_sources()
            assert len(records) == 2
            run = "summary-test-run-" + suffix
            await repo.start_run(
                run,
                summary_model="fake-summary",
                prompt_revision="synthetic-v1",
                embedding_model_revision="fake-embedding",
            )
            await repo.start_run(
                run,
                summary_model="fake-summary",
                prompt_revision="synthetic-v1",
                embedding_model_revision="fake-embedding",
            )
            text = "2026년 1월 2일, 합성 전시.\n가상의 전시장을 방문.\n파란 작품의 사진."
            for record in records:
                await repo.import_summary(run, record, text, "fake-summary", "synthetic-v1")
                await repo.import_summary(run, record, text, "fake-summary", "synthetic-v1")
            await repo.import_vector(run, first["id"], "fake-embedding", [1] * 1536)
            with pytest.raises(CoreError, match="SUMMARY_INDEX_INCOMPLETE"):
                await repo.activate_run(run, "fake-embedding")
            with pytest.raises(CoreError, match="SUMMARY_INDEX_UNAVAILABLE"):
                await repo.active_run()
            await repo.import_vector(run, second["id"], "fake-embedding", [2] * 1536)
            await repo.import_vector(run, second["id"], "fake-embedding", [2] * 1536)
            await repo.activate_run(run, "fake-embedding")
            assert (await repo.active_run("fake-embedding"))["run_id"] == run
            with pytest.raises(CoreError, match="SUMMARY_INDEX_UNAVAILABLE"):
                await repo.active_run("wrong-model")
            query = {
                "personId": first["personId"],
                "dateBasis": "posted",
                "timezone": "UTC",
                "limit": 20,
            }
            hits = await sources.search_semantic(
                query,
                {"personId": first["personId"]},
                [1] * 1536,
                "fake-embedding",
                summary_index=True,
            )
            assert len(hits) == 2
            assert hits[0]["caption"] == POST["caption"]
            assert "summary" not in hits[0]
            assert await repo.get_summaries([first["id"]], "other-person") == {}
            assert await repo.get_summaries([first["id"]], first["personId"]) == {first["id"]: text}
            # Immutable snapshot and direct zero-vector defenses apply to raw SQL too.
            with pytest.raises(psycopg.Error):
                async with conn.transaction():
                    await conn.execute("UPDATE llm.post_summaries SET summary='changed'")
            with pytest.raises(psycopg.Error):
                async with conn.transaction():
                    await conn.execute(
                        "INSERT INTO llm.post_summary_vectors VALUES(%s,%s,%s,"
                        "array_fill(0::real,ARRAY[1536])::vector,%s)",
                        (run, first["id"], "fake-embedding", "zero"),
                    )
            # Annotation refresh invalidates active manifest and stale summary imports.
            annotation = {
                "id": "summary-test-image-" + suffix,
                "sourceId": first["id"],
                "personId": first["personId"],
                "sourceHash": first["hash"],
                "imagePosition": 0,
                "imageHash": "a" * 64,
                "revision": "synthetic-image-v1",
                "text": "합성 파란 작품 사진",
                "model": "fake-vision",
                "humanReviewed": False,
            }
            annotation["annotationHash"] = annotation_hash(annotation)
            await sources.import_annotations([annotation])
            with pytest.raises(CoreError, match="SUMMARY_INDEX_UNAVAILABLE"):
                await repo.active_run()
            with pytest.raises(CoreError, match="SUMMARY_SOURCE_STALE"):
                await repo.import_summary(run, records[0], text, "fake-summary", "synthetic-v1")
            refreshed = "summary-test-refresh-" + suffix
            await repo.start_run(
                refreshed,
                summary_model="fake-summary",
                prompt_revision="synthetic-v1",
                embedding_model_revision="fake-embedding",
            )
            for record in await repo.list_sources():
                await repo.import_summary(refreshed, record, text, "fake-summary", "synthetic-v1")
                await repo.import_vector(refreshed, record["id"], "fake-embedding", [1] * 1536)
            await repo.activate_run(refreshed, "fake-embedding")
            annotated = await sources.search_semantic(
                query,
                {"personId": first["personId"]},
                [1] * 1536,
                "fake-embedding",
                summary_index=True,
                evidence_scope="caption_image",
            )
            image_post = next(post for post in annotated if post["id"] == first["id"])
            assert image_post["imageAnnotations"][0]["text"] == annotation["text"]
            captions = await sources.search_semantic(
                query,
                {"personId": first["personId"]},
                [1] * 1536,
                "fake-embedding",
                summary_index=True,
                evidence_scope="caption",
            )
            assert all("imageAnnotations" not in post for post in captions)
            # New eligible parent invalidates active manifest, rather than falling back.
            await sources.import_posts(
                [{**first, "id": "summary-test-new-" + suffix}], "licensed_source"
            )
            with pytest.raises(CoreError, match="SUMMARY_INDEX_UNAVAILABLE"):
                await repo.active_run()
            with pytest.raises(CoreError, match="SUMMARY_INDEX_INCOMPLETE"):
                await repo.activate_run(run, "fake-embedding")
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_initial_manifest_membership_rejects_new_post_before_paid_work():
    repo = Harness(
        [
            [{"source_id": POST["id"]}, {"source_id": "new-post"}],
            [{"id": POST["id"]}, {"id": "new-post"}],
        ]
    )
    with pytest.raises(CoreError, match="SUMMARY_SOURCE_STALE"):
        await repo.check_run_sources("run", [POST], exact_membership=True)
