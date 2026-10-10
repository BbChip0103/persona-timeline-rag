"Immutable source/image/vector storage and scoped retrieval, only llm.* SQL."

from __future__ import annotations

import asyncio
import math
import struct
import unicodedata
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ptr_llm.core.errors import CoreError
from ptr_llm.providers.common import check_cancel, fingerprint, js_json

from .database import LlmRepository

SCOPE = (
    "p.person_id=$1 AND NOT p.unsafe AND ($2::date IS NULL OR CASE WHE"
    "N $5='event' THEN p.event_date >= $2::date AND p.event_date < $3:"
    ":date ELSE p.posted_at >= ($2::date::timestamp AT TIME ZONE $4) A"
    "ND p.posted_at < ($3::date::timestamp AT TIME ZONE $4) END)"
)


def checked_vector(vector: list[float]) -> str:
    if (
        not isinstance(vector, list)
        or len(vector) != 1536
        or any(type(v) not in (int, float) or not math.isfinite(v) for v in vector)
    ):
        raise CoreError("INVALID_INPUT")
    try:
        values = [struct.unpack("f", struct.pack("f", v))[0] for v in vector]
    except (OverflowError, struct.error):
        raise CoreError("INVALID_INPUT") from None
    if not any(values) or any(not math.isfinite(v) for v in values):
        raise CoreError("INVALID_INPUT")
    return js_json(values)


def parameters(query: dict[str, Any], trusted: dict[str, str]) -> list[Any]:
    from datetime import date

    if set(query) - {"personId", "query", "start", "end", "dateBasis", "timezone", "limit"} or (
        "query" in query and (not isinstance(query["query"], str) or not query["query"].strip())
    ):
        raise CoreError("INVALID_INPUT")
    if any(
        not isinstance(value, str) or not 1 <= len(value) <= 200 or value.strip() != value
        for value in (query.get("personId"), trusted.get("personId"))
    ):
        raise CoreError("INVALID_INPUT")
    if any(key in query and query[key] is None for key in ("start", "end")):
        raise CoreError("INVALID_INPUT")
    if query.get("personId") != trusted.get("personId"):
        raise CoreError("FORBIDDEN")
    if (
        query.get("dateBasis") not in ("posted", "event")
        or type(query.get("limit")) is not int
        or not 1 <= query["limit"] <= 100
        or not isinstance(query.get("timezone"), str)
        or not isinstance(query.get("query", ""), str)
        or len(query.get("query", "")) > 500
    ):
        raise CoreError("INVALID_INPUT")
    try:
        ZoneInfo(query["timezone"])
        if (query.get("start") is None) != (query.get("end") is None):
            raise ValueError
        if query.get("start") is not None and date.fromisoformat(
            query["start"]
        ) >= date.fromisoformat(query["end"]):
            raise ValueError
    except (ValueError, TypeError, ZoneInfoNotFoundError):
        raise CoreError("INVALID_INPUT") from None
    return [
        trusted["personId"],
        query.get("start"),
        query.get("end"),
        query["timezone"],
        query["dateBasis"],
    ]


def annotation_hash(row: dict[str, Any]) -> str:
    return fingerprint(
        {
            k: row[k]
            for k in (
                "id",
                "sourceId",
                "personId",
                "sourceHash",
                "imagePosition",
                "imageHash",
                "revision",
                "text",
                "model",
                "humanReviewed",
            )
        }
    )


def annotation_evidence(row: dict[str, Any]) -> dict[str, Any]:
    return {
        k: row[k]
        for k in ("id", "imageHash", "annotationHash", "revision", "text", "model", "humanReviewed")
    }


def validate_source(post: Any) -> dict[str, Any]:
    from datetime import date, datetime
    from urllib.parse import urlsplit

    fields = (
        "id",
        "personId",
        "caption",
        "postedAt",
        "eventDate",
        "sourceUrl",
        "hash",
        "snapshot",
        "unsafe",
    )
    if (
        not isinstance(post, dict)
        or set(post) - {*fields, "imageAnnotations"}
        or not set(fields) <= set(post)
    ):
        raise CoreError("INVALID_INPUT")
    if (
        any(
            not isinstance(post[k], str)
            or not 1 <= len(post[k]) <= 200
            or post[k] != post[k].strip()
            for k in ("id", "personId", "hash", "snapshot")
        )
        or not isinstance(post["caption"], str)
        or type(post["unsafe"]) is not bool
    ):
        raise CoreError("INVALID_INPUT")
    try:
        if (
            not isinstance(post["postedAt"], str)
            or datetime.fromisoformat(post["postedAt"].replace("Z", "+00:00")).tzinfo is None
        ):
            raise ValueError
        if post["eventDate"] is not None:
            if (
                not isinstance(post["eventDate"], str)
                or date.fromisoformat(post["eventDate"]).isoformat() != post["eventDate"]
            ):
                raise ValueError
        if (
            not isinstance(post["sourceUrl"], str)
            or urlsplit(post["sourceUrl"]).scheme not in ("http", "https")
            or not urlsplit(post["sourceUrl"]).netloc
        ):
            raise ValueError
    except (ValueError, TypeError):
        raise CoreError("INVALID_INPUT") from None
    output = {k: post[k] for k in fields}
    if "imageAnnotations" in post:
        rows = post["imageAnnotations"]
        if not isinstance(rows, list) or len(rows) > 100:
            raise CoreError("INVALID_INPUT")
        output["imageAnnotations"] = rows
    return output


class PostgresSourceRepository(LlmRepository):
    async def import_posts(self, posts: list[dict[str, Any]], origin: str) -> dict[str, int]:
        if origin not in ("licensed_source", "synthetic_fixture") or any(
            not isinstance(p, dict) or "imageAnnotations" in p for p in posts
        ):
            raise CoreError("INVALID_INPUT")
        posts = [validate_source(post) for post in posts]
        inserted = existing = 0
        async with self.pool.connection() as conn, conn.transaction():
            for post in posts:
                content_hash = fingerprint({"post": post, "origin": origin})
                rows = await self.fetch(
                    (
                        "INSERT INTO llm.source_posts(id,person_id,posted_at,event_date,ca"
                        "ption,unsafe,source_url,snapshot,source_hash,content_hash,origin,"
                        "document) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb) O"
                        "N CONFLICT(id) DO NOTHING RETURNING id"
                    ),
                    [
                        post["id"],
                        post["personId"],
                        post.get("postedAt"),
                        post.get("eventDate"),
                        post["caption"],
                        post["unsafe"],
                        post.get("sourceUrl"),
                        post["snapshot"],
                        post["hash"],
                        content_hash,
                        origin,
                        js_json(post),
                    ],
                    connection=conn,
                )
                if rows:
                    inserted += 1
                else:
                    previous = await self.fetch(
                        "SELECT content_hash FROM llm.source_posts WHERE id=$1",
                        [post["id"]],
                        connection=conn,
                    )
                    if not previous or previous[0]["content_hash"] != content_hash:
                        raise CoreError("IDEMPOTENCY_CONFLICT")
                    existing += 1
        return {"inserted": inserted, "existing": existing}

    async def import_annotations(self, rows: list[dict[str, Any]]) -> dict[str, int]:
        import re

        groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
        fields = (
            "id",
            "sourceId",
            "personId",
            "sourceHash",
            "imagePosition",
            "imageHash",
            "annotationHash",
            "revision",
            "text",
            "model",
            "humanReviewed",
        )
        for raw in rows:
            if not isinstance(raw, dict) or set(raw) != set(fields):
                raise CoreError("INVALID_INPUT")
            row = {k: raw[k] for k in fields}
            if (
                row.get("humanReviewed") is not False
                or type(row.get("imagePosition")) is not int
                or row["imagePosition"] < 0
                or not isinstance(row.get("text"), str)
                or not 1 <= len(row["text"]) <= 16000
                or any(
                    not isinstance(row.get(k), str)
                    or not 1 <= len(row[k]) <= 200
                    or row[k] != row[k].strip()
                    for k in ("id", "sourceId", "personId", "sourceHash", "revision", "model")
                )
                or any(
                    not isinstance(row.get(k), str) or not re.fullmatch("[a-f0-9]{64}", row[k])
                    for k in ("imageHash", "annotationHash")
                )
                or annotation_hash(row) != row["annotationHash"]
            ):
                raise CoreError("INVALID_INPUT")
            groups.setdefault((row["sourceId"], row["revision"]), []).append(row)
        inserted = existing = 0
        async with self.pool.connection() as conn, conn.transaction():
            for group in groups.values():
                group.sort(key=lambda row: row["imagePosition"])
                first = group[0]
                if (
                    len(group) > 100
                    or len({r["imagePosition"] for r in group}) != len(group)
                    or len({r["id"] for r in group}) != len(group)
                ):
                    raise CoreError("INVALID_INPUT")
                parents = await self.fetch(
                    "SELECT person_id,source_hash,unsafe FROM llm.source_posts WHERE id=$1",
                    [first["sourceId"]],
                    connection=conn,
                )
                if not parents:
                    raise CoreError("NOT_FOUND")
                parent = parents[0]
                if parent["unsafe"] or any(
                    r["personId"] != parent["person_id"] or r["sourceHash"] != parent["source_hash"]
                    for r in group
                ):
                    raise CoreError("FORBIDDEN")
                content_hash = fingerprint(group)
                revisions = await self.fetch(
                    (
                        "INSERT INTO llm.source_image_revisions(source_id,revision,person_"
                        "id,source_hash,content_hash,document) VALUES($1,$2,$3,$4,$5,$6::j"
                        "sonb) ON CONFLICT DO NOTHING RETURNING source_id"
                    ),
                    [
                        first["sourceId"],
                        first["revision"],
                        first["personId"],
                        first["sourceHash"],
                        content_hash,
                        js_json([annotation_evidence(r) for r in group]),
                    ],
                    connection=conn,
                )
                if not revisions:
                    previous = await self.fetch(
                        (
                            "SELECT content_hash FROM llm.source_image_revisions WHERE source_"
                            "id=$1 AND revision=$2"
                        ),
                        [first["sourceId"], first["revision"]],
                        connection=conn,
                    )
                    if not previous or previous[0]["content_hash"] != content_hash:
                        raise CoreError("IDEMPOTENCY_CONFLICT")
                    existing += len(group)
                    continue
                for row in group:
                    await self.fetch(
                        (
                            "INSERT INTO llm.source_image_annotations(id,source_id,revision,im"
                            "age_position,image_hash,annotation_hash,document) VALUES($1,$2,$3"
                            ",$4,$5,$6,$7::jsonb)"
                        ),
                        [
                            row["id"],
                            row["sourceId"],
                            row["revision"],
                            row["imagePosition"],
                            row["imageHash"],
                            row["annotationHash"],
                            js_json(annotation_evidence(row)),
                        ],
                        connection=conn,
                    )
                inserted += len(group)
        return {"inserted": inserted, "existing": existing}

    async def _import_vector(
        self,
        source_id: str,
        model_revision: str,
        embedding: list[float],
        annotation_revision: str | None = None,
    ) -> None:
        if (
            not isinstance(model_revision, str)
            or not model_revision.strip()
            or annotation_revision is not None
            and not annotation_revision.strip()
        ):
            raise CoreError("INVALID_INPUT")
        vector = checked_vector(embedding)
        async with self.pool.connection() as conn, conn.transaction():
            if annotation_revision is not None:
                parent = await self.fetch(
                    (
                        "SELECT source_id FROM llm.source_image_revisions WHERE source_id="
                        "$1 AND revision=$2"
                    ),
                    [source_id, annotation_revision],
                    connection=conn,
                )
                if not parent:
                    raise CoreError("NOT_FOUND")
                rows = await self.fetch(
                    (
                        "INSERT INTO llm.source_image_vectors(source_id,annotation_revisio"
                        "n,model_revision,embedding) VALUES($1,$2,$3,$4::vector) ON CONFLI"
                        "CT DO NOTHING RETURNING source_id"
                    ),
                    [source_id, annotation_revision, model_revision, vector],
                    connection=conn,
                )
                previous = (
                    []
                    if rows
                    else await self.fetch(
                        (
                            "SELECT embedding::text AS vector FROM llm.source_image_vectors WH"
                            "ERE source_id=$1 AND annotation_revision=$2 AND model_revision=$3"
                        ),
                        [source_id, annotation_revision, model_revision],
                        connection=conn,
                    )
                )
            else:
                rows = await self.fetch(
                    (
                        "INSERT INTO llm.source_vectors(source_id,model_revision,embedding"
                        ") VALUES($1,$2,$3::vector) ON CONFLICT DO NOTHING RETURNING sourc"
                        "e_id"
                    ),
                    [source_id, model_revision, vector],
                    connection=conn,
                )
                previous = (
                    []
                    if rows
                    else await self.fetch(
                        (
                            "SELECT embedding::text AS vector FROM llm.source_vectors WHERE so"
                            "urce_id=$1 AND model_revision=$2"
                        ),
                        [source_id, model_revision],
                        connection=conn,
                    )
                )
            if not rows:
                import json

                if not previous or checked_vector(json.loads(previous[0]["vector"])) != vector:
                    raise CoreError("IDEMPOTENCY_CONFLICT")

    async def import_vector(
        self, source_id: str, model_revision: str, embedding: list[float]
    ) -> None:
        await self._import_vector(source_id, model_revision, embedding)

    async def import_image_vector(
        self, source_id: str, annotation_revision: str, model_revision: str, embedding: list[float]
    ) -> None:
        await self._import_vector(source_id, model_revision, embedding, annotation_revision)

    async def search_lexical(
        self,
        query: dict[str, Any],
        trusted: dict[str, str],
        *,
        signal: asyncio.Event | None = None,
        evidence_scope: str = "caption",
    ) -> list[dict[str, Any]]:
        import regex

        values = parameters(query, trusted)
        phrase = unicodedata.normalize("NFC", query.get("query", "").lower())
        tokens = list(dict.fromkeys(regex.findall(r"[\p{L}\p{N}]+", phrase)))
        if evidence_scope == "caption_image":
            sql = (
                f"WITH augmented AS (SELECT p.*,r.document AS "
                f"annotations,p.caption || E'\\n' || COALESCE((SELECT "
                f"string_agg(DISTINCT a->>'text',E'\\n') FROM "
                f"jsonb_array_elements(r.document) a),'') AS combined FROM "
                f"llm.source_posts p LEFT JOIN LATERAL (SELECT document FROM "
                f"llm.source_image_revisions WHERE source_id=p.id ORDER BY ordinal "
                f"DESC LIMIT 1) r ON true WHERE {SCOPE}) SELECT "
                f"document,annotations,CASE WHEN $6='' THEN 0 ELSE CASE WHEN "
                f"position($6 IN lower(combined))>0 THEN 10 ELSE 0 END + (SELECT "
                f"count(*) FROM unnest($7::text[]) token WHERE position(token IN "
                f"lower(combined))>0) END AS score FROM augmented WHERE $6='' OR "
                f"position($6 IN lower(combined))>0 OR EXISTS(SELECT 1 FROM "
                f"unnest($7::text[]) token WHERE position(token IN "
                f"lower(combined))>0) ORDER BY score DESC,posted_at DESC,id ASC "
                f"LIMIT $8"
            )
        elif evidence_scope == "caption":
            sql = (
                f"SELECT p.document,CASE WHEN $6='' THEN 0 ELSE CASE WHEN "
                f"position($6 IN lower(p.caption))>0 THEN 10 ELSE 0 END + (SELECT "
                f"count(*) FROM unnest($7::text[]) token WHERE position(token IN "
                f"lower(p.caption))>0) END AS score FROM llm.source_posts p WHERE "
                f"{SCOPE} AND ($6='' OR position($6 IN lower(p.caption))>0 OR "
                f"EXISTS(SELECT 1 FROM unnest($7::text[]) token WHERE "
                f"position(token IN lower(p.caption))>0)) ORDER BY score "
                f"DESC,p.posted_at DESC,p.id ASC LIMIT $8"
            )
        else:
            raise CoreError("INVALID_INPUT")
        rows = await self.fetch(sql, [*values, phrase, tokens, query["limit"]], signal=signal)
        return [
            {
                **validate_source(r["document"]),
                **({"imageAnnotations": r["annotations"]} if r.get("annotations") else {}),
            }
            for r in rows
        ]

    async def search_summary_children(
        self,
        query: dict[str, Any],
        trusted: dict[str, str],
        embedding: list[float],
        model_revision: str,
        *,
        signal: asyncio.Event | None = None,
        summary_run_id: str,
    ) -> list[dict[str, Any]]:
        return await self._summary_search_rows(
            query,
            trusted,
            embedding,
            model_revision,
            signal=signal,
            summary_run_id=summary_run_id,
            children=True,
        )

    async def _summary_search_rows(
        self,
        query: dict[str, Any],
        trusted: dict[str, str],
        embedding: list[float],
        model_revision: str,
        *,
        signal: asyncio.Event | None,
        summary_run_id: str | None,
        children: bool = False,
    ) -> list[dict[str, Any]]:
        from .summaries import ACTIVE_SQL, checked_active_run

        values = parameters(query, trusted)
        vector = checked_vector(embedding)
        if summary_run_id is None:
            active_rows = await self.fetch(ACTIVE_SQL, signal=signal)
        else:
            active_rows = await self.fetch(
                "SELECT run_id,embedding_model_revision,"
                "llm.ptr_summary_run_complete(run_id,embedding_model_revision) AS complete "
                "FROM llm.post_summary_runs WHERE run_id=$1",
                [summary_run_id],
                signal=signal,
            )
        active = checked_active_run(active_rows, model_revision)
        # SDK children contain summary text and identity, not hydrated originals.
        fields = "source_id,summary,source_hash,snapshot" if children else "document,annotations"
        projection = (
            "p.source_hash,p.snapshot,z.summary"
            if children
            else "p.document,r.document AS annotations"
        )
        sql = (
            f"WITH scoped AS MATERIALIZED (SELECT p.id AS source_id,p.id,p.posted_at,"
            f"{projection},v.embedding "
            f"FROM llm.source_posts p "
            f"JOIN llm.post_summary_run_sources s ON s.source_id=p.id AND s.run_id=$6 "
            f"AND s.source_hash=p.source_hash AND s.person_id=p.person_id "
            f"JOIN llm.post_summary_vectors v ON v.run_id=s.run_id AND v.source_id=p.id "
            f"AND v.model_revision=$7 JOIN llm.post_summaries z ON z.run_id=s.run_id "
            f"AND z.source_id=p.id LEFT JOIN LATERAL (SELECT revision,document "
            f"FROM llm.source_image_revisions WHERE source_id=p.id ORDER BY ordinal "
            f"DESC LIMIT 1) r ON true WHERE {SCOPE} AND p.origin='licensed_source' "
            f"AND r.revision IS NOT DISTINCT FROM s.annotation_revision) "
            f"SELECT {fields} FROM scoped ORDER BY embedding <=> "
            f"$8::vector,posted_at DESC,id ASC LIMIT $9"
        )
        return await self.fetch(
            sql,
            [*values, active["run_id"], model_revision, vector, query["limit"]],
            signal=signal,
        )

    async def load_summary_parents(
        self,
        source_ids: list[str],
        trusted: dict[str, str],
        *,
        summary_run_id: str,
        signal: asyncio.Event | None = None,
        evidence_scope: str = "caption",
    ) -> dict[str, dict[str, Any]]:
        from .summaries import checked_active_run, identifier

        if evidence_scope not in ("caption", "caption_image") or len(source_ids) > 100:
            raise CoreError("INVALID_INPUT")
        for value in [summary_run_id, trusted.get("personId"), *source_ids]:
            identifier(value)
        checked_active_run(
            await self.fetch(
                "SELECT run_id,embedding_model_revision,"
                "llm.ptr_summary_run_complete(run_id,embedding_model_revision) AS complete "
                "FROM llm.post_summary_runs WHERE run_id=$1",
                [summary_run_id],
                signal=signal,
            )
        )
        rows = await self.fetch(
            "SELECT p.document,r.document AS annotations,z.summary FROM llm.source_posts p "
            "JOIN llm.post_summary_run_sources s ON s.source_id=p.id AND s.run_id=$1 "
            "AND s.source_hash=p.source_hash AND s.person_id=p.person_id "
            "JOIN llm.post_summaries z ON z.run_id=s.run_id AND z.source_id=p.id "
            "LEFT JOIN LATERAL(SELECT document,revision FROM llm.source_image_revisions "
            "WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) r ON true "
            "WHERE p.id=ANY($2::text[]) AND p.person_id=$3 AND NOT p.unsafe "
            "AND p.origin='licensed_source' "
            "AND r.revision IS NOT DISTINCT FROM s.annotation_revision",
            [summary_run_id, source_ids, trusted["personId"]],
            signal=signal,
        )
        found = {}
        for row in rows:
            post = validate_source(row["document"])
            if evidence_scope == "caption_image" and row.get("annotations"):
                post["imageAnnotations"] = row["annotations"]
            found[post["id"]] = {"source": post, "summary": row["summary"]}
        return found

    async def search_semantic(
        self,
        query: dict[str, Any],
        trusted: dict[str, str],
        embedding: list[float],
        model_revision: str,
        *,
        signal: asyncio.Event | None = None,
        evidence_scope: str = "caption",
        summary_index: bool = False,
        summary_run_id: str | None = None,
    ) -> list[dict[str, Any]]:
        values = parameters(query, trusted)
        if summary_index:
            if evidence_scope not in ("caption", "caption_image"):
                raise CoreError("INVALID_INPUT")
            rows = await self._summary_search_rows(
                query,
                trusted,
                embedding,
                model_revision,
                signal=signal,
                summary_run_id=summary_run_id,
            )
            return [
                {
                    **validate_source(row["document"]),
                    **(
                        {"imageAnnotations": row["annotations"]}
                        if evidence_scope == "caption_image" and row.get("annotations")
                        else {}
                    ),
                }
                for row in rows
            ]
        if evidence_scope == "caption_image":
            sql = (
                f"WITH scoped AS MATERIALIZED (SELECT "
                f"p.id,p.document,p.posted_at,r.document AS "
                f"annotations,v.embedding FROM llm.source_posts p JOIN LATERAL "
                f"(SELECT revision,document FROM llm.source_image_revisions WHERE "
                f"source_id=p.id ORDER BY ordinal DESC LIMIT 1) r ON true JOIN "
                f"llm.source_image_vectors v ON v.source_id=p.id AND "
                f"v.annotation_revision=r.revision AND v.model_revision=$6 WHERE "
                f"{SCOPE} UNION ALL SELECT p.id,p.document,p.posted_at,NULL::jsonb "
                f"AS annotations,v.embedding FROM llm.source_posts p JOIN "
                f"llm.source_vectors v ON v.source_id=p.id AND v.model_revision=$6 "
                f"WHERE {SCOPE} AND NOT EXISTS(SELECT 1 FROM "
                f"llm.source_image_revisions r WHERE r.source_id=p.id)) SELECT "
                f"document,annotations FROM scoped ORDER BY embedding <=> "
                f"$7::vector,posted_at DESC,id ASC LIMIT $8"
            )
        elif evidence_scope == "caption":
            sql = (
                f"WITH scoped AS MATERIALIZED (SELECT "
                f"p.id,p.document,p.posted_at,v.embedding FROM llm.source_posts p "
                f"JOIN llm.source_vectors v ON v.source_id=p.id AND "
                f"v.model_revision=$6 WHERE {SCOPE}) SELECT document FROM scoped "
                f"ORDER BY embedding <=> $7::vector,posted_at DESC,id ASC LIMIT $8"
            )
        else:
            raise CoreError("INVALID_INPUT")
        rows = await self.fetch(
            sql, [*values, model_revision, checked_vector(embedding), query["limit"]], signal=signal
        )
        return [
            {
                **validate_source(r["document"]),
                **({"imageAnnotations": r["annotations"]} if r.get("annotations") else {}),
            }
            for r in rows
        ]

    async def resolve_evidence(
        self,
        references: list[dict[str, Any]],
        trusted: dict[str, str],
        *,
        signal: asyncio.Event | None = None,
        evidence_scope: str = "caption",
    ) -> list[dict[str, Any]]:
        if not isinstance(references, list) or len(references) > 20:
            raise CoreError("INVALID_INPUT")

        def identifier(value: Any) -> bool:
            return isinstance(value, str) and 1 <= len(value) <= 200 and value.strip() == value

        pinned = []
        for index, ref in enumerate(references):
            if (
                any(
                    not identifier(ref.get(k)) for k in ("personId", "sourceId", "hash", "snapshot")
                )
                or not isinstance(ref.get("quote"), str)
                or not ref["quote"]
            ):
                raise CoreError("INVALID_INPUT")
            if ref["personId"] != trusted["personId"]:
                raise CoreError("FORBIDDEN")
            fields = ("annotationId", "annotationRevision", "imageHash", "annotationHash")
            has_annotation = any(k in ref for k in fields)
            if (
                has_annotation
                and not all(identifier(ref.get(k)) for k in fields)
                or ref.get("origin") == "ai_image_annotation"
                and not has_annotation
                or ref.get("origin") == "source_caption"
                and has_annotation
            ):
                raise CoreError("INVALID_INPUT")
            pinned.append(
                {
                    "index": index,
                    "source_id": ref["sourceId"],
                    "source_hash": ref["hash"],
                    "snapshot": ref["snapshot"],
                    "annotation_id": ref.get("annotationId"),
                    "revision": ref.get("annotationRevision"),
                    "image_hash": ref.get("imageHash"),
                    "annotation_hash": ref.get("annotationHash"),
                }
            )
        if not pinned:
            return []
        sql = (
            "WITH refs AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(in"
            "dex integer,source_id text,source_hash text,snapshot text,annotat"
            "ion_id text,revision text,image_hash text,annotation_hash text)) "
            "SELECT refs.index,p.document,a.document AS annotation FROM refs J"
            "OIN llm.source_posts p ON p.id=refs.source_id AND p.source_hash=r"
            "efs.source_hash AND p.document->>'snapshot'=refs.snapshot AND p.p"
            "erson_id=$1 AND NOT p.unsafe LEFT JOIN llm.source_image_revisions"
            " r ON r.source_id=p.id AND r.revision=refs.revision AND r.person_"
            "id=$1 AND r.source_hash=p.source_hash LEFT JOIN llm.source_image_"
            "annotations a ON a.source_id=r.source_id AND a.revision=r.revisio"
            "n AND a.id=refs.annotation_id AND a.image_hash=refs.image_hash AN"
            "D a.annotation_hash=refs.annotation_hash WHERE refs.annotation_id"
            " IS NULL OR a.id IS NOT NULL ORDER BY refs.index"
        )
        rows = await self.fetch(sql, [trusted["personId"], js_json(pinned)], signal=signal)
        sources: dict[str, dict[str, Any]] = {}
        for row in rows:
            ref = references[row["index"]]
            post = validate_source(row["document"])
            if (
                post.get("personId") != trusted["personId"]
                or post.get("id") != ref["sourceId"]
                or post.get("hash") != ref["hash"]
                or post.get("snapshot") != ref["snapshot"]
                or post.get("unsafe")
            ):
                continue
            annotation = row.get("annotation")
            if ref.get("annotationId"):
                if (
                    not annotation
                    or any(
                        annotation.get(k) != ref[v]
                        for k, v in (
                            ("id", "annotationId"),
                            ("revision", "annotationRevision"),
                            ("imageHash", "imageHash"),
                            ("annotationHash", "annotationHash"),
                        )
                    )
                    or ref["quote"] not in annotation.get("text", "")
                ):
                    continue
            elif ref["quote"] not in post.get("caption", ""):
                continue
            existing = sources.setdefault(
                post["id"], {k: v for k, v in post.items() if k != "imageAnnotations"}
            )
            if (
                evidence_scope == "caption_image"
                and ref.get("annotationId")
                and annotation
                and not any(
                    a["id"] == annotation["id"] for a in existing.get("imageAnnotations", [])
                )
            ):
                existing.setdefault("imageAnnotations", []).append(annotation)
        return list(sources.values())


class PostgresRetrieval:
    def __init__(
        self,
        sources: PostgresSourceRepository,
        *,
        embed: Any = None,
        model_revision: str | None = None,
        summary_index: bool = False,
    ):
        self.sources, self.embed, self.model_revision = sources, embed, model_revision
        self.summary_index = summary_index

    async def search(
        self,
        query: dict[str, Any],
        trusted: dict[str, str],
        *,
        signal: asyncio.Event | None = None,
        mode: str = "lexical",
        evidence_scope: str = "caption",
    ) -> list[dict[str, Any]]:
        parameters(query, trusted)
        check_cancel(signal)
        if self.summary_index and mode != "semantic":
            raise CoreError("SUMMARY_INDEX_REQUIRES_SEMANTIC")
        if self.summary_index:
            found, _ = await self.search_with_summaries(
                query,
                trusted,
                signal=signal,
                mode=mode,
                evidence_scope=evidence_scope,
            )
            return found
        if mode == "lexical":
            return await self.sources.search_lexical(
                query, trusted, signal=signal, evidence_scope=evidence_scope
            )
        if mode != "semantic" or self.embed is None or not self.model_revision:
            raise CoreError("INVALID_INPUT")
        vector = await self.embed(
            query.get("query", ""), signal=signal, evidence_scope=evidence_scope
        )
        return await self.sources.search_semantic(
            query,
            trusted,
            vector,
            self.model_revision,
            signal=signal,
            evidence_scope=evidence_scope,
        )

    async def summaries(
        self,
        candidates: list[dict[str, Any]],
        trusted: dict[str, str],
        *,
        signal: asyncio.Event | None = None,
    ) -> dict[str, str]:
        from .summaries import PostgresSummaryRepository

        check_cancel(signal)
        if not self.summary_index or any(
            s.get("personId") != trusted.get("personId") or s.get("unsafe") is not False
            for s in candidates
        ):
            raise CoreError("FORBIDDEN")
        repository = PostgresSummaryRepository(self.sources.pool, self.sources.pool.conninfo)
        return await repository.get_summaries(
            [s["id"] for s in candidates], trusted["personId"], signal=signal
        )

    async def search_with_summaries(
        self,
        query: dict[str, Any],
        trusted: dict[str, str],
        *,
        signal: asyncio.Event | None = None,
        mode: str = "semantic",
        evidence_scope: str = "caption",
    ) -> tuple[list[dict[str, Any]], dict[str, str]]:
        from .summaries import PostgresSummaryRepository

        parameters(query, trusted)
        # Freeze caller-owned scope before the first await or SDK invocation.
        query, trusted = dict(query), dict(trusted)
        check_cancel(signal)
        if evidence_scope not in ("caption", "caption_image"):
            raise CoreError("INVALID_INPUT")
        if (
            not self.summary_index
            or mode != "semantic"
            or self.embed is None
            or not self.model_revision
        ):
            raise CoreError("SUMMARY_INDEX_REQUIRES_SEMANTIC")
        repository = PostgresSummaryRepository(self.sources.pool, self.sources.pool.conninfo)
        run = await repository.active_run(self.model_revision, signal=signal)
        from .langchain_retrieval import retrieve_originals

        return await retrieve_originals(
            self.sources,
            query,
            trusted,
            embed=self.embed,
            model_revision=self.model_revision,
            run_id=run["run_id"],
            signal=signal,
            evidence_scope=evidence_scope,
        )

    async def resolve_with_summaries(
        self,
        references: list[dict[str, Any]],
        trusted: dict[str, str],
        *,
        signal: asyncio.Event | None = None,
        evidence_scope: str = "caption",
    ) -> tuple[list[dict[str, Any]], dict[str, str]]:
        from .summaries import PostgresSummaryRepository

        if not self.summary_index or evidence_scope not in ("caption", "caption_image"):
            raise CoreError("INVALID_INPUT")
        check_cancel(signal)
        resolved = await self.sources.resolve_evidence(
            references,
            trusted,
            signal=signal,
            evidence_scope=evidence_scope,
        )
        if not resolved:
            return [], {}
        repository = PostgresSummaryRepository(self.sources.pool, self.sources.pool.conninfo)
        run = await repository.active_run(self.model_revision, signal=signal)
        rows = await repository.fetch(
            "SELECT p.document,r.document AS annotations FROM llm.source_posts p "
            "JOIN llm.post_summary_run_sources s ON s.source_id=p.id AND s.run_id=$1 "
            "AND s.source_hash=p.source_hash LEFT JOIN LATERAL(SELECT document,revision "
            "FROM llm.source_image_revisions WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) "
            "r ON true WHERE p.id=ANY($2::text[]) AND p.person_id=$3 AND s.person_id=$3 "
            "AND NOT p.unsafe AND p.origin='licensed_source' "
            "AND r.revision IS NOT DISTINCT FROM s.annotation_revision ORDER BY p.id",
            [run["run_id"], [s["id"] for s in resolved], trusted["personId"]],
            signal=signal,
        )
        originals = {s["id"]: s for s in resolved}
        found = []
        for row in rows:
            post = validate_source(row["document"])
            previous = originals.get(post["id"])
            if not previous or any(
                post[k] != previous[k] for k in ("hash", "snapshot", "personId")
            ):
                raise CoreError("SUMMARY_SOURCE_STALE")
            if evidence_scope == "caption_image" and row.get("annotations"):
                post["imageAnnotations"] = row["annotations"]
            found.append(post)
        summaries = await repository.get_summaries(
            [s["id"] for s in found],
            trusted["personId"],
            signal=signal,
            run_id=run["run_id"],
        )
        return found, summaries

    async def resolve(
        self, references: list[dict[str, Any]], trusted: dict[str, str], **options: Any
    ) -> list[dict[str, Any]]:
        return await self.sources.resolve_evidence(references, trusted, **options)
