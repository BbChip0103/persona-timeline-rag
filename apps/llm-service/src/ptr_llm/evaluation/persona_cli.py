"""Fail-closed publication CLI; same domain lint and atomic repository as runtime."""

from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path
from typing import Any


def read_private_bytes(file: str) -> bytes:
    path = Path(file)
    if "review" in path.parts:
        raise ValueError("Human review sheets cannot be read")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError:
        raise ValueError("Cannot open private regular file") from None
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16 * 1024**2 or info.st_mode & 0o077:
            raise ValueError("Explicit owner-only regular JSON file required")
        return stream.read(16 * 1024**2 + 1)


def read_private_json(file: str) -> Any:
    return json.loads(read_private_bytes(file))


def write_atomic(file: str, data: Any) -> None:
    target = Path(file)
    temporary = target.with_name(target.name + f".tmp-{os.getpid()}")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, ensure_ascii=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def preflight(args: Any, database: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    from ptr_llm.core.persona import validate_persona

    personas: list[dict[str, Any]] = []
    log: list[dict[str, Any]] = []
    for field in ("authored_list", "publish_log"):
        path = Path(getattr(args, field))
        if not path.parent.is_dir() or not os.access(path.parent, os.W_OK):
            raise ValueError("Artifact parent missing or not writable")
        if path.exists() or path.is_symlink():
            data = read_private_json(str(path))
            if field == "authored_list":
                if not isinstance(data, dict) or data.get("database") != database:
                    raise ValueError("Authored list database mismatch")
                personas = [validate_persona(p) for p in data["personas"]]
            else:
                if not isinstance(data, list):
                    raise ValueError("Publication log must be a private JSON array")
                log = data
    return personas, log


def persist(
    args: Any,
    database: str,
    previous: list[dict[str, Any]],
    log: list[dict[str, Any]],
    documents: list[dict[str, Any]],
    record: dict[str, Any],
) -> None:
    from datetime import UTC, datetime

    merged = {p["personId"]: p for p in previous}
    for persona in documents:
        if persona["personId"] in merged and merged[persona["personId"]]["id"] != persona["id"]:
            raise ValueError("Authored list persona binding mismatch")
        merged[persona["personId"]] = persona
    write_atomic(args.authored_list, {"database": database, "personas": list(merged.values())})
    write_atomic(
        args.publish_log,
        [*log, {**record, "database": database, "publishedAt": datetime.now(UTC).isoformat()}],
    )


async def operate(args: Any, repository: Any = None) -> dict[str, Any]:
    from ptr_llm.core.persona import persona_revision, validate_persona, validate_publication

    docs = read_private_json(args.file)
    if not isinstance(docs, list) or not docs:
        raise ValueError("Nonempty persona document list required")
    database = getattr(args, "target", "ptr_split_research")
    if database not in {"ptr_split_test", "ptr_split_research"}:
        raise ValueError("Explicit split database target required")
    prior_personas, prior_log = (
        preflight(args, database) if args.operation != "validate" else ([], [])
    )
    if args.operation == "restore":
        if not args.confirm or repository is None:
            raise ValueError("Restore requires explicit confirm and LLM repository")
        validated = [validate_persona(p) for p in docs]
        if len({p["personId"] for p in validated}) != len(validated):
            raise ValueError("One restoration document per person required")
        for persona in validated:
            existing = next(
                (p for p in prior_personas if p["personId"] == persona["personId"]), None
            )
            if not existing or existing["id"] != persona["id"]:
                raise ValueError("Restore needs an existing authored-list persona binding")
        result = await repository.restore_revisions(validated)
        persist(
            args,
            database,
            prior_personas,
            prior_log,
            validated,
            {"operation": "restore", "results": result},
        )
        return {"ok": True, "restored": len(result)}
    source_bytes = read_private_bytes(args.sources_doc)
    sources = json.loads(source_bytes)
    captions = read_private_json(args.captions_file)
    split = read_private_json(args.split_file)
    generated = read_private_json(args.generated_list) if args.generated_list else []
    baselines = read_private_json(args.baseline) if args.baseline else []
    if (
        not isinstance(sources, list)
        or not isinstance(captions, list)
        or not isinstance(split, dict)
        or any(v not in {"dev", "test"} for v in split.values())
    ):
        raise ValueError("Invalid sources, captions or split")
    source_keys = [(s["id"], s["personId"]) for s in sources]
    if len(set(source_keys)) != len(source_keys):
        raise ValueError("Duplicate source id for owner")
    source_set = set(source_keys)
    reports = []
    output = []
    seen = set()
    for index, doc in enumerate(docs):
        revision = persona_revision(doc)
        candidate = {**doc, "revision": revision}
        baseline = next(
            (
                p
                for p in baselines
                if p.get("id") == candidate.get("id")
                or p.get("personId") == candidate.get("personId")
            ),
            None,
        )
        verified = False
        if baseline and repository:
            verified = all(
                await repository.verify_baselines(
                    [{"baseline": baseline, "draftRevision": revision}]
                )
            )

        async def exists(ref: str, owner: str) -> bool:
            if ref.startswith("web:"):
                return (ref, owner) in source_set
            if repository:
                return await repository.licensed_post_exists(ref, owner)
            return any(c["id"] == ref and c["personId"] == owner for c in captions)

        report = await validate_publication(
            candidate,
            test_captions=[
                c["caption"]
                for c in captions
                if c["personId"] == candidate.get("personId") and split.get(c["id"]) == "test"
            ],
            source_ref_exists=exists,
            generated=next(
                (p for p in generated if p.get("personId") == candidate.get("personId")), None
            ),
            baseline=baseline,
            baseline_verified=verified,
        )
        if candidate.get("personId") in seen:
            report["issues"].append(
                {"path": "personId", "rule": "duplicate_person", "severity": "error"}
            )
            report["ok"] = False
        seen.add(candidate.get("personId"))
        if baseline and repository and not verified:
            report["issues"].append(
                {"path": "", "rule": "baseline_unverified", "severity": "error"}
            )
            report["ok"] = False
        reports.append({"index": index, **report})
        output.append(candidate)
    ok = all(r["ok"] for r in reports)
    result = {"ok": ok, "dryRun": not args.confirm, "reports": reports, "documents": len(output)}
    if args.operation == "publish" and args.confirm:
        if not ok or repository is None:
            raise ValueError("Publication validation failed or repository missing")
        for candidate in output:
            previous = next(
                (p for p in prior_personas if p["personId"] == candidate["personId"]), None
            )
            if previous and previous["id"] != candidate["id"]:
                raise ValueError("Authored list persona binding mismatch")
        imported = await repository.import_personas(output, set_current=True)
        # DB commit precedes local artifact replacement, so an interrupted rerun is idempotent.
        persist(
            args,
            database,
            prior_personas,
            prior_log,
            output,
            {
                "operation": "publish",
                "results": imported,
                "revisions": [p["revision"] for p in output],
                "sourceDocSha256": hashlib.sha256(source_bytes).hexdigest(),
            },
        )
        result["published"] = len(imported)
    return result


async def run(args: Any) -> int:
    repository = pool = None
    if args.confirm or args.operation == "restore":
        from psycopg_pool import AsyncConnectionPool

        from ptr_llm.repositories.database import assert_llm_database_url
        from ptr_llm.repositories.personas import PostgresPersonaRepository

        url = os.environ.get("PTR_LLM_DATABASE_URL", "")
        assert_llm_database_url(url)
        from urllib.parse import urlsplit

        if urlsplit(url).path != "/" + args.target:
            raise ValueError("Database target does not match selected connection")
        pool = AsyncConnectionPool(url, open=False, min_size=1, max_size=1)
        await pool.open()
        repository = PostgresPersonaRepository(pool, url)
    try:
        result = await operate(args, repository)
        # Only indices and bounded rule codes; no original persona/source text.
        print(json.dumps(result))
        return int(not result["ok"])
    finally:
        if pool:
            await pool.close()
