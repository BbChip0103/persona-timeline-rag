"""Inventory and extract selected accounts; never pretend 300 posts are guaranteed."""

import hashlib
import json
import shutil
import threading
import time
import zlib
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from pathlib import Path, PurePosixPath

from persona_timeline_rag.datasets.drive import DriveClient, DriveFile, DriveRangeReader
from persona_timeline_rag.datasets.mapping import load_selection
from persona_timeline_rag.datasets.range_zip import SplitZipArchive, ZipEntry


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def archive_files(manifest: Path, kind: str) -> list[DriveFile]:
    data = json.loads(manifest.read_text(encoding="utf-8"))
    return [DriveFile(**item) for item in data[kind]]


def index_archive(root: Path, kind: str, chunk_size: int = 16 * 1024 * 1024) -> dict:
    """Cache central-directory ranges privately, making failed runs resumable."""
    selection = root / "data/manifests/candidates.json"
    manifest = root / "data/manifests/archive_volumes.json"
    usernames = {person["username"] for person in load_selection(selection)}
    provenance = hashlib.sha256(selection.read_bytes() + manifest.read_bytes()).hexdigest()
    output = root / f"data/manifests/{kind}_index.json"
    if output.exists():
        data = json.loads(output.read_text(encoding="utf-8"))
        if data.get("provenance_sha256") == provenance and data.get("scan_complete") is True:
            print(f"{kind}: verified completed index reused", flush=True)
            return data
    files = archive_files(manifest, kind)
    client = DriveClient(timeout=180)
    reader = DriveRangeReader(client, files, root / f"data/cache/{kind}")
    archive = SplitZipArchive(reader, [file.size_bytes for file in files], chunk_size=chunk_size)
    print(
        f"{kind}: scanning {archive.directory.size:,} directory bytes; "
        f"{archive.directory.entries:,} source entries",
        flush=True,
    )
    start = time.monotonic()
    entries = []
    for entry in archive.iter_entries(usernames):
        expected_suffix = ".info" if kind == "metadata" else ".jpg"
        if not entry.filename.endswith(expected_suffix):
            continue
        entries.append(asdict(entry))
        if len(entries) % 500 == 0:
            print(
                f"{kind}: matched {len(entries):,}; "
                f"network {client.network_bytes / 1024**2:.1f} MiB; "
                f"elapsed {time.monotonic() - start:.0f}s",
                flush=True,
            )
    counts = Counter(PurePosixPath(entry["filename"]).name.split("-", 1)[0] for entry in entries)
    data = {
        "kind": kind,
        "scan_complete": True,
        "provenance_sha256": provenance,
        "directory": asdict(archive.directory),
        "network_bytes": client.network_bytes,
        "selected_counts": {name: counts[name] for name in sorted(usernames)},
        "entries": entries,
    }
    write_json(output, data)
    print(f"{kind}: index complete, {len(entries):,} selected members", flush=True)
    return data


def _valid_existing(path: Path, entry: ZipEntry) -> bool:
    if not path.is_file() or path.stat().st_size != entry.uncompressed_size:
        return False
    crc = 0
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            crc = zlib.crc32(chunk, crc)
    return crc & 0xFFFFFFFF == entry.crc32


def _validate_member(body: bytes, kind: str, username: str) -> None:
    if kind == "metadata":
        record = json.loads(body)
        if not isinstance(record, dict) or not isinstance(record.get("owner"), dict):
            raise ValueError("Invalid metadata record/owner shape")
        if record["owner"].get("username") != username:
            raise ValueError("Metadata owner mismatch")
    elif not body.startswith(b"\xff\xd8"):
        raise ValueError("Non-JPEG member")


def completion_report(
    kind: str,
    entries: list[ZipEntry],
    completed: list[dict],
    errors: list[dict],
    people: set[str],
    network_bytes: int,
) -> dict:
    counts = Counter(Path(item["path"]).parts[-3] for item in completed)
    missing = sorted(people - counts.keys())
    return {
        "kind": kind,
        "expected": len(entries),
        "verified": len(completed),
        "complete": bool(entries) and len(completed) == len(entries) and not errors and not missing,
        "missing_accounts": missing,
        "account_counts": dict(counts),
        "network_bytes": network_bytes,
        "errors": errors,
        "files": completed,
    }


def _groups(entries: list[ZipEntry], sizes: list[int]) -> list[list[ZipEntry]]:
    """Coalesce nearby members, reducing HTTP requests without reading full volumes."""
    groups: list[list[ZipEntry]] = []
    end = 0
    for entry in sorted(entries, key=lambda value: (value.disk, value.offset)):
        estimated_end = min(sizes[entry.disk], entry.offset + entry.compressed_size + 4096)
        if (
            not groups
            or groups[-1][0].disk != entry.disk
            or entry.offset > end + 64 * 1024
            or estimated_end - groups[-1][0].offset > 8 * 1024 * 1024
        ):
            groups.append([entry])
            end = estimated_end
        else:
            groups[-1].append(entry)
            end = max(end, estimated_end)
    return groups


def download_subset(root: Path, kind: str, workers: int = 4) -> dict:
    if not 1 <= workers <= 8:
        raise ValueError("workers must be between 1 and 8")
    index_path = root / f"data/manifests/{kind}_index.json"
    index = json.loads(index_path.read_text(encoding="utf-8"))
    if not index.get("scan_complete"):
        raise ValueError("Incomplete central-directory scan")
    selection = root / "data/manifests/candidates.json"
    manifest = root / "data/manifests/archive_volumes.json"
    provenance = hashlib.sha256(selection.read_bytes() + manifest.read_bytes()).hexdigest()
    if index.get("provenance_sha256") != provenance:
        raise ValueError("Index belongs to a different selection or source manifest")
    people = {person["username"] for person in load_selection(selection)}
    files = archive_files(manifest, kind)
    sizes = [file.size_bytes for file in files]
    client = DriveClient(timeout=180)
    entries = [ZipEntry(**item) for item in index["entries"]]
    target_root = root / "data/subsets/instagram"
    target_root.mkdir(parents=True, exist_ok=True)
    total_size = sum(entry.uncompressed_size for entry in entries)
    if shutil.disk_usage(target_root).free < total_size + 512 * 1024 * 1024:
        raise ValueError("Insufficient disk space for selected member extraction")
    completed = []
    errors = []
    pending = []

    def destination(entry: ZipEntry) -> Path:
        name = PurePosixPath(entry.filename).name
        username = name.split("-", 1)[0]
        if username not in people or ".." in PurePosixPath(entry.filename).parts:
            raise ValueError("Index contains a non-selected or unsafe member")
        return target_root / username / kind / name

    for entry in entries:
        path = destination(entry)
        if _valid_existing(path, entry):
            _validate_member(path.read_bytes(), kind, path.parent.parent.name)
            completed.append(
                {
                    "filename": entry.filename,
                    "path": str(path.relative_to(root)),
                    "bytes": entry.uncompressed_size,
                    "crc32": entry.crc32,
                }
            )
        else:
            pending.append(entry)
    report_path = root / f"reports/{kind}_download.json"
    groups = _groups(pending, sizes)
    print(
        f"{kind}: {len(entries):,} total, {len(pending):,} pending, "
        f"{len(groups):,} HTTP batches, {total_size / 1024**2:.1f} MiB output",
        flush=True,
    )
    start = time.monotonic()
    local = threading.local()

    def extract_group(group: list[ZipEntry]) -> tuple[list[dict], list[dict]]:
        successes: list[dict] = []
        failures: list[dict] = []
        try:
            if not hasattr(local, "reader"):
                local.reader = DriveRangeReader(client, files)
                local.archive = SplitZipArchive(local.reader, sizes)
            disk, offset = group[0].disk, group[0].offset
            end = min(sizes[disk], max(e.offset + e.compressed_size + 4096 for e in group))
            local.reader.prefetch(disk, offset, end - offset)
        except (ValueError, OSError, RuntimeError) as error:
            return [], [{"filenames": [e.filename for e in group], "reason": str(error)}]
        for entry in group:
            try:
                path = destination(entry)
                body = local.archive.extract(entry)
                _validate_member(body, kind, path.parent.parent.name)
                path.parent.mkdir(parents=True, exist_ok=True)
                temporary = path.with_suffix(path.suffix + ".part")
                temporary.write_bytes(body)
                temporary.replace(path)
                successes.append(
                    {
                        "filename": entry.filename,
                        "path": str(path.relative_to(root)),
                        "bytes": len(body),
                        "crc32": entry.crc32,
                        "sha256": hashlib.sha256(body).hexdigest(),
                    }
                )
            except (ValueError, OSError, RuntimeError) as error:
                failures.append({"filename": entry.filename, "reason": str(error)})
        return successes, failures

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = [executor.submit(extract_group, group) for group in groups]
        for group_number, future in enumerate(as_completed(futures), 1):
            successes, failures = future.result()
            completed.extend(successes)
            errors.extend(failures)
            for failure in failures:
                print(f"{kind}: batch failed: {failure['reason']}", flush=True)
            if group_number % 25 == 0 or group_number == len(groups):
                report = completion_report(
                    kind, entries, completed, errors, people, client.network_bytes
                )
                write_json(report_path, report)
                print(
                    f"{kind}: verified {len(completed):,}/{len(entries):,}; "
                    f"batches {group_number}/{len(groups)}; "
                    f"elapsed {time.monotonic() - start:.0f}s",
                    flush=True,
                )
    report = completion_report(kind, entries, completed, errors, people, client.network_bytes)
    write_json(report_path, report)
    return report
