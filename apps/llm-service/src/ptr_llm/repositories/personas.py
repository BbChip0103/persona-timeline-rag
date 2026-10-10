from __future__ import annotations

import builtins
from typing import Any

from ptr_llm.billing import ProviderError
from ptr_llm.providers.common import fingerprint, js_json

from .database import LlmRepository


class PostgresPersonaRepository(LlmRepository):
    async def get(self, id: str, revision: str | None = None) -> dict[str, Any] | None:
        rows = await self.fetch(
            (
                "SELECT v.document FROM llm.personas p JOIN llm.persona_versions v"
                " ON v.persona_id=p.id AND v.revision=COALESCE($2,p.current_revisi"
                "on) WHERE p.id=$1"
            ),
            [id, revision],
        )
        from ptr_llm.core.persona import validate_persona

        return validate_persona(rows[0]["document"]) if rows else None

    async def licensed_post_exists(self, ref: str, person_id: str) -> bool:
        rows = await self.fetch(
            (
                "SELECT 1 FROM llm.source_posts WHERE person_id=$1 AND origin='lic"
                "ensed_source' AND NOT unsafe AND (id=$2 OR source_url=$2 OR snaps"
                "hot=$2 OR source_hash=$2) LIMIT 1"
            ),
            [person_id, ref],
        )
        return bool(rows)

    async def list(self) -> builtins.list[dict[str, Any]]:
        rows = await self.fetch(
            "SELECT v.document FROM llm.personas p JOIN llm.persona_versions v"
            " ON v.persona_id=p.id AND v.revision=p.current_revision ORDER BY "
            "p.id"
        )
        from ptr_llm.core.persona import validate_persona

        return [validate_persona(r["document"]) for r in rows]

    async def import_persona(
        self, persona: dict[str, Any], *, set_current: bool = False
    ) -> dict[str, Any]:
        return (await self.import_personas([persona], set_current=set_current))[0]

    async def import_personas(
        self, personas: builtins.list[dict[str, Any]], *, set_current: bool = False
    ) -> builtins.list[dict[str, Any]]:
        from ptr_llm.core.persona import validate_persona

        documents = [validate_persona(p) for p in personas]
        result = []
        async with self.pool.connection() as conn, conn.transaction():
            for p in documents:
                before = await self.fetch(
                    "SELECT current_revision FROM llm.personas WHERE id=$1 FOR UPDATE",
                    [p["id"]],
                    connection=conn,
                )
                await self.fetch(
                    (
                        "INSERT INTO llm.personas(id,person_id,current_revision) VALUES($1"
                        ",$2,$3) ON CONFLICT DO NOTHING"
                    ),
                    [p["id"], p["personId"], p["revision"]],
                    connection=conn,
                )
                binding = await self.fetch(
                    "SELECT person_id FROM llm.personas WHERE id=$1 FOR UPDATE",
                    [p["id"]],
                    connection=conn,
                )
                if binding[0]["person_id"] != p["personId"]:
                    raise ProviderError("IDEMPOTENCY_CONFLICT")
                existing = await self.fetch(
                    (
                        "SELECT content_hash FROM llm.persona_versions WHERE persona_id=$1"
                        " AND revision=$2"
                    ),
                    [p["id"], p["revision"]],
                    connection=conn,
                )
                content_hash = fingerprint(p)
                if existing and existing[0]["content_hash"] != content_hash:
                    raise ProviderError("IDEMPOTENCY_CONFLICT")
                if not existing:
                    await self.fetch(
                        (
                            "INSERT INTO llm.persona_versions(persona_id,revision,document,con"
                            "tent_hash) VALUES($1,$2,$3::jsonb,$4)"
                        ),
                        [p["id"], p["revision"], js_json(p), content_hash],
                        connection=conn,
                    )
                if not existing or set_current:
                    await self.fetch(
                        "UPDATE llm.personas SET current_revision=$2 WHERE id=$1",
                        [p["id"], p["revision"]],
                        connection=conn,
                    )
                result.append(
                    {
                        "inserted": not bool(existing),
                        "previousRevision": before[0]["current_revision"] if before else None,
                    }
                )
        return result

    async def verify_baselines(self, entries: builtins.list[dict[str, Any]]) -> builtins.list[bool]:
        results = []
        for entry in entries:
            p = entry["baseline"]
            rows = await self.fetch(
                (
                    "SELECT p.person_id,p.current_revision,EXISTS(SELECT 1 FROM llm.pe"
                    "rsona_versions v WHERE v.persona_id=p.id AND v.revision=$2 AND v."
                    "document=$3::jsonb) AS stored FROM llm.personas p WHERE p.id=$1"
                ),
                [p["id"], p["revision"], js_json(p)],
            )
            results.append(
                bool(
                    rows
                    and rows[0]["person_id"] == p["personId"]
                    and rows[0]["stored"]
                    and rows[0]["current_revision"] in (p["revision"], entry["draftRevision"])
                )
            )
        return results

    async def restore_revisions(
        self, personas: builtins.list[dict[str, Any]]
    ) -> builtins.list[dict[str, Any]]:
        results = []
        async with self.pool.connection() as conn, conn.transaction():
            for p in personas:
                before = await self.fetch(
                    "SELECT current_revision,person_id FROM llm.personas WHERE id=$1 FOR UPDATE",
                    [p["id"]],
                    connection=conn,
                )
                stored = await self.fetch(
                    (
                        "SELECT 1 FROM llm.persona_versions WHERE persona_id=$1 AND revisi"
                        "on=$2 AND document=$3::jsonb"
                    ),
                    [p["id"], p["revision"], js_json(p)],
                    connection=conn,
                )
                if not before or before[0]["person_id"] != p["personId"] or not stored:
                    raise ProviderError("NOT_FOUND")
                await self.fetch(
                    "UPDATE llm.personas SET current_revision=$2 WHERE id=$1",
                    [p["id"], p["revision"]],
                    connection=conn,
                )
                results.append({"previousRevision": before[0]["current_revision"]})
        return results
