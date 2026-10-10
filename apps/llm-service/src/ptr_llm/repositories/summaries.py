"""Immutable generated retrieval summaries, never original citation evidence."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from ptr_llm.core.errors import CoreError
from ptr_llm.providers.common import check_cancel, fingerprint

from .database import LlmRepository
from .sources import checked_vector, validate_source

SOURCE_SQL = (
    "SELECT p.document,p.source_hash,p.person_id,p.id,r.revision AS annotation_revision,"
    "r.content_hash AS annotation_hash,r.document AS annotations FROM llm.source_posts p "
    "LEFT JOIN LATERAL(SELECT revision,content_hash,document FROM llm.source_image_revisions "
    "WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) r ON true "
    "WHERE p.origin='licensed_source' AND NOT p.unsafe ORDER BY p.id"
)
ACTIVE_SQL = (
    "SELECT run_id,embedding_model_revision,"
    "llm.ptr_summary_run_complete(run_id,embedding_model_revision) AS complete "
    "FROM llm.active_summary_index WHERE singleton"
)


def identifier(value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 200 or value.strip() != value:
        raise CoreError("INVALID_INPUT")
    return value


def validate_summary(value: Any) -> str:
    if (
        not isinstance(value, str)
        or len(value) > 1200
        or len(value.split("\n")) != 3
        or "\r" in value
        or any(not line.strip() or line != line.strip() for line in value.split("\n"))
        or any(term in value for term in ("명시되지 않았다", "정보 없음", "미상"))
    ):
        raise CoreError("INVALID_INPUT")
    return value


def checked_active_run(
    rows: list[dict[str, Any]],
    model_revision: str | None = None,
) -> dict[str, Any]:
    if (
        not rows
        or not rows[0]["complete"]
        or model_revision is not None
        and rows[0]["embedding_model_revision"] != model_revision
    ):
        raise CoreError("SUMMARY_INDEX_UNAVAILABLE")
    return rows[0]


def manifest(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            key: row[key]
            for key in ("id", "person_id", "source_hash", "annotation_revision", "annotation_hash")
        }
        for row in rows
    ]


class PostgresSummaryRepository(LlmRepository):
    async def check_run_sources(
        self, run_id: str, sources: list[dict[str, Any]], *, exact_membership: bool = False
    ) -> None:
        if exact_membership:
            expected_ids = {s["id"] for s in sources}
            members = await self.fetch(
                "SELECT source_id FROM llm.post_summary_run_sources WHERE run_id=$1", [run_id]
            )
            current = await self.fetch(SOURCE_SQL)
            if {r["source_id"] for r in members} != expected_ids or {
                r["id"] for r in current
            } != expected_ids:
                raise CoreError("SUMMARY_SOURCE_STALE")
        rows = await self.fetch(
            "SELECT s.source_id,s.person_id,s.source_hash,s.annotation_revision,s.annotation_hash "
            "FROM llm.post_summary_run_sources s JOIN llm.source_posts p ON p.id=s.source_id "
            "AND p.source_hash=s.source_hash LEFT JOIN LATERAL(SELECT revision,content_hash "
            "FROM llm.source_image_revisions WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) "
            "a ON true WHERE s.run_id=$1 AND s.source_id=ANY($2::text[]) AND NOT p.unsafe "
            "AND p.origin='licensed_source' "
            "AND a.revision IS NOT DISTINCT FROM s.annotation_revision "
            "AND a.content_hash IS NOT DISTINCT FROM s.annotation_hash",
            [run_id, [s["id"] for s in sources]],
        )
        stored = {r["source_id"]: r for r in rows}
        for source in sources:
            expected = {
                "source_id": source["id"],
                "person_id": source["personId"],
                "source_hash": source["hash"],
                "annotation_revision": source["annotationRevision"],
                "annotation_hash": source["annotationHash"],
            }
            if stored.get(source["id"]) != expected:
                raise CoreError("SUMMARY_SOURCE_STALE")

    async def list_sources(self) -> list[dict[str, Any]]:
        rows = await self.fetch(SOURCE_SQL)
        return [
            {
                **validate_source(row["document"]),
                "imageAnnotations": row.get("annotations") or [],
                "annotationRevision": row["annotation_revision"],
                "annotationHash": row["annotation_hash"],
            }
            for row in rows
        ]

    async def start_run(
        self,
        run_id: str,
        *,
        summary_model: str,
        prompt_revision: str,
        embedding_model_revision: str,
    ) -> None:
        for value in (run_id, summary_model, prompt_revision, embedding_model_revision):
            identifier(value)
        async with self.pool.connection() as conn, conn.transaction():
            await self.fetch(
                "LOCK TABLE llm.source_posts,llm.source_image_revisions IN SHARE MODE",
                connection=conn,
            )
            sources = manifest(await self.fetch(SOURCE_SQL, connection=conn))
            if not sources:
                raise CoreError("SUMMARY_INDEX_INCOMPLETE")
            corpus_hash = fingerprint(sources)
            content_hash = fingerprint(
                {
                    "run": run_id,
                    "summaryModel": summary_model,
                    "promptRevision": prompt_revision,
                    "embeddingModelRevision": embedding_model_revision,
                    "corpusHash": corpus_hash,
                }
            )
            inserted = await self.fetch(
                "INSERT INTO llm.post_summary_runs(run_id,summary_model,prompt_revision,"
                "embedding_model_revision,corpus_hash,content_hash) VALUES($1,$2,$3,$4,$5,$6) "
                "ON CONFLICT DO NOTHING RETURNING run_id",
                [
                    run_id,
                    summary_model,
                    prompt_revision,
                    embedding_model_revision,
                    corpus_hash,
                    content_hash,
                ],
                connection=conn,
            )
            if not inserted:
                previous = await self.fetch(
                    "SELECT content_hash FROM llm.post_summary_runs WHERE run_id=$1",
                    [run_id],
                    connection=conn,
                )
                if not previous or previous[0]["content_hash"] != content_hash:
                    raise CoreError("IDEMPOTENCY_CONFLICT")
                return
            for source in sources:
                await self.fetch(
                    "INSERT INTO llm.post_summary_run_sources(run_id,source_id,person_id,"
                    "source_hash,annotation_revision,annotation_hash) VALUES($1,$2,$3,$4,$5,$6)",
                    [
                        run_id,
                        source["id"],
                        source["person_id"],
                        source["source_hash"],
                        source["annotation_revision"],
                        source["annotation_hash"],
                    ],
                    connection=conn,
                )

    async def import_summary(
        self,
        run_id: str,
        source: dict[str, Any],
        summary: str,
        model: str,
        prompt_revision: str,
    ) -> None:
        identifier(run_id)
        identifier(model)
        identifier(prompt_revision)
        summary = validate_summary(summary)
        post = validate_source(
            {k: v for k, v in source.items() if k not in ("annotationRevision", "annotationHash")}
        )
        revision, annotation_hash = source.get("annotationRevision"), source.get("annotationHash")
        if (revision is None) != (annotation_hash is None):
            raise CoreError("INVALID_INPUT")
        content_hash = fingerprint(
            {
                "sourceHash": post["hash"],
                "annotationRevision": revision,
                "annotationHash": annotation_hash,
                "summary": summary,
                "model": model,
                "promptRevision": prompt_revision,
            }
        )
        async with self.pool.connection() as conn, conn.transaction():
            runs = await self.fetch(
                "SELECT summary_model,prompt_revision FROM llm.post_summary_runs WHERE run_id=$1",
                [run_id],
                connection=conn,
            )
            if not runs or runs[0] != {"summary_model": model, "prompt_revision": prompt_revision}:
                raise CoreError("IDEMPOTENCY_CONFLICT")
            parents = await self.fetch(
                "SELECT s.source_id FROM llm.post_summary_run_sources s "
                "JOIN llm.source_posts p ON p.id=s.source_id AND p.source_hash=s.source_hash "
                "LEFT JOIN LATERAL(SELECT revision,content_hash FROM llm.source_image_revisions "
                "WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) a ON true "
                "WHERE s.run_id=$1 AND s.source_id=$2 AND s.person_id=$3 AND s.source_hash=$4 "
                "AND NOT p.unsafe AND p.origin='licensed_source' "
                "AND s.annotation_revision IS NOT DISTINCT FROM $5::text "
                "AND s.annotation_hash IS NOT DISTINCT FROM $6::text "
                "AND a.revision IS NOT DISTINCT FROM s.annotation_revision "
                "AND a.content_hash IS NOT DISTINCT FROM s.annotation_hash",
                [run_id, post["id"], post["personId"], post["hash"], revision, annotation_hash],
                connection=conn,
            )
            if not parents:
                raise CoreError("SUMMARY_SOURCE_STALE")
            inserted = await self.fetch(
                "INSERT INTO llm.post_summaries(run_id,source_id,summary,summary_model,"
                "prompt_revision,content_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING "
                "RETURNING source_id",
                [run_id, post["id"], summary, model, prompt_revision, content_hash],
                connection=conn,
            )
            if not inserted:
                previous = await self.fetch(
                    "SELECT content_hash FROM llm.post_summaries WHERE run_id=$1 AND source_id=$2",
                    [run_id, post["id"]],
                    connection=conn,
                )
                if not previous or previous[0]["content_hash"] != content_hash:
                    raise CoreError("IDEMPOTENCY_CONFLICT")

    async def import_vector(
        self,
        run_id: str,
        source_id: str,
        model_revision: str,
        embedding: list[float],
    ) -> None:
        for value in (run_id, source_id, model_revision):
            identifier(value)
        vector = checked_vector(embedding)
        content_hash = fingerprint(json.loads(vector))
        async with self.pool.connection() as conn, conn.transaction():
            parents = await self.fetch(
                "SELECT s.source_id FROM llm.post_summaries s JOIN llm.post_summary_runs r "
                "ON r.run_id=s.run_id WHERE s.run_id=$1 AND s.source_id=$2 "
                "AND r.embedding_model_revision=$3",
                [run_id, source_id, model_revision],
                connection=conn,
            )
            if not parents:
                raise CoreError("NOT_FOUND")
            inserted = await self.fetch(
                "INSERT INTO llm.post_summary_vectors(run_id,source_id,model_revision,embedding,"
                "content_hash) VALUES($1,$2,$3,$4::vector,$5) ON CONFLICT DO NOTHING "
                "RETURNING source_id",
                [run_id, source_id, model_revision, vector, content_hash],
                connection=conn,
            )
            if not inserted:
                previous = await self.fetch(
                    "SELECT content_hash FROM llm.post_summary_vectors "
                    "WHERE run_id=$1 AND source_id=$2 AND model_revision=$3",
                    [run_id, source_id, model_revision],
                    connection=conn,
                )
                if not previous or previous[0]["content_hash"] != content_hash:
                    raise CoreError("IDEMPOTENCY_CONFLICT")

    async def activate_run(self, run_id: str, embedding_model_revision: str) -> None:
        identifier(run_id)
        identifier(embedding_model_revision)
        async with self.pool.connection() as conn, conn.transaction():
            await self.fetch(
                "LOCK TABLE llm.source_posts,llm.source_image_revisions IN SHARE MODE",
                connection=conn,
            )
            complete = await self.fetch(
                "SELECT llm.ptr_summary_run_complete($1,$2) AS complete",
                [run_id, embedding_model_revision],
                connection=conn,
            )
            if not complete or not complete[0]["complete"]:
                raise CoreError("SUMMARY_INDEX_INCOMPLETE")
            await self.fetch(
                "INSERT INTO llm.active_summary_index(singleton,run_id,embedding_model_revision) "
                "VALUES(true,$1,$2) ON CONFLICT(singleton) DO UPDATE SET run_id=EXCLUDED.run_id,"
                "embedding_model_revision=EXCLUDED.embedding_model_revision,activated_at=now()",
                [run_id, embedding_model_revision],
                connection=conn,
            )

    async def active_run(
        self,
        model_revision: str | None = None,
        *,
        signal: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        check_cancel(signal)
        rows = await self.fetch(ACTIVE_SQL, signal=signal)
        return checked_active_run(rows, model_revision)

    async def get_summaries(
        self,
        source_ids: list[str],
        person_id: str,
        *,
        signal: asyncio.Event | None = None,
        run_id: str | None = None,
    ) -> dict[str, str]:
        check_cancel(signal)
        identifier(person_id)
        if not isinstance(source_ids, list) or len(source_ids) > 100:
            raise CoreError("INVALID_INPUT")
        for value in source_ids:
            identifier(value)
        if not source_ids:
            return {}
        if run_id is None:
            active = await self.active_run(signal=signal)
            run_id = active["run_id"]
        else:
            identifier(run_id)
            rows = await self.fetch(
                "SELECT run_id,embedding_model_revision,"
                "llm.ptr_summary_run_complete(run_id,embedding_model_revision) AS complete "
                "FROM llm.post_summary_runs WHERE run_id=$1",
                [run_id],
                signal=signal,
            )
            checked_active_run(rows)
        rows = await self.fetch(
            "SELECT z.source_id,z.summary FROM llm.post_summaries z "
            "JOIN llm.post_summary_run_sources s ON s.run_id=z.run_id AND s.source_id=z.source_id "
            "JOIN llm.source_posts p ON p.id=s.source_id AND p.source_hash=s.source_hash "
            "WHERE z.run_id=$1 AND s.person_id=$2 AND p.person_id=$2 "
            "AND NOT p.unsafe AND p.origin='licensed_source' AND z.source_id=ANY($3::text[])",
            [run_id, person_id, source_ids],
            signal=signal,
        )
        return {row["source_id"]: row["summary"] for row in rows}
