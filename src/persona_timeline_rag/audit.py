"""Local, aggregate-only verification of a selected Instagram snapshot.

Reports never include captions, post identifiers, member filenames, or Drive IDs.
Completion means verified local files *and* a consistent normalized post corpus,
not a downloader's historical success flag or a promised 300 posts per person.
"""

from __future__ import annotations

import hashlib
import json
import re
import zlib
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath

from persona_timeline_rag.datasets.mapping import load_selection
from persona_timeline_rag.ingestion.instagram import normalize_post
from persona_timeline_rag.schemas import Post


def _json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        return None
    return value if isinstance(value, dict) else None


def _members(directory: Path, suffix: str, boundary: Path) -> tuple[dict[str, Path], int]:
    """Do not follow symlinks out of the private subset while checking files."""
    if not directory.exists():
        return {}, 0
    if directory.is_symlink() or not directory.resolve().is_relative_to(boundary.resolve()):
        return {}, 1
    files = {}
    unsafe = 0
    for path in directory.glob(f"*{suffix}"):
        if path.is_symlink():
            unsafe += 1
        elif path.is_file():
            files[path.name] = path
    return files, unsafe


def _index(index: dict | None, usernames: set[str], kind: str) -> tuple[dict, int]:
    grouped: dict[str, dict[str, dict]] = {name: {} for name in usernames}
    invalid = 0
    entries = index.get("entries", []) if index else []
    if not isinstance(entries, list):
        return grouped, 1
    folder, suffix = ("info", "info") if kind == "metadata" else ("image", "jpg")
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("filename"), str):
            invalid += 1
            continue
        path = PurePosixPath(entry["filename"])
        name = path.name
        username = name.split("-", 1)[0]
        if (
            username not in usernames
            or path.parts != (folder, name)
            or not re.fullmatch(rf"{re.escape(username)}-\d+\.{suffix}", name)
            or name in grouped[username]
            or not isinstance(entry.get("uncompressed_size"), int)
            or isinstance(entry.get("uncompressed_size"), bool)
            or entry["uncompressed_size"] < 0
            or not isinstance(entry.get("crc32"), int)
            or isinstance(entry.get("crc32"), bool)
            or not 0 <= entry["crc32"] <= 0xFFFFFFFF
        ):
            invalid += 1
            continue
        grouped[username][name] = entry
    if index and index.get("selected_counts") is not None:
        counts = index["selected_counts"]
        if not isinstance(counts, dict) or any(
            counts.get(name) != len(grouped[name]) for name in usernames
        ):
            invalid += 1
    return grouped, invalid


def _crc_matches(path: Path, entry: dict) -> bool:
    try:
        if path.stat().st_size != entry["uncompressed_size"]:
            return False
        crc = 0
        with path.open("rb") as handle:
            while chunk := handle.read(1024 * 1024):
                crc = zlib.crc32(chunk, crc)
        return crc & 0xFFFFFFFF == entry["crc32"]
    except OSError:
        return False


def _file_stats(expected: dict, actual: dict, unsafe: int) -> tuple[dict, set[str]]:
    verified = {
        name
        for name in expected.keys() & actual.keys()
        if _crc_matches(actual[name], expected[name])
    }
    stats = {
        "expected": len(expected),
        "actual": len(actual),
        "verified": len(verified),
        "missing": len(expected.keys() - actual.keys()),
        "corrupt": len(expected.keys() & actual.keys()) - len(verified),
        "unexpected": len(actual.keys() - expected.keys()),
        "unsafe": unsafe,
    }
    stats["complete"] = (
        bool(expected)
        and len(verified) == len(expected)
        and not (stats["unexpected"] or stats["unsafe"])
    )
    return stats, verified


def _report_valid(report: dict | None, expected: dict[str, dict], kind: str) -> bool:
    if not report or report.get("complete") is not True or report.get("errors"):
        return False
    total = sum(len(entries) for entries in expected.values())
    if not total or report.get("expected") != total or report.get("verified") != total:
        return False
    records = report.get("files")
    if not isinstance(records, list) or len(records) != total:
        return False
    seen = set()
    for record in records:
        if not isinstance(record, dict) or not isinstance(record.get("filename"), str):
            return False
        name = PurePosixPath(record["filename"]).name
        username = name.split("-", 1)[0]
        if username not in expected or name not in expected[username]:
            return False
        entry = expected[username][name]
        path = f"data/subsets/instagram/{username}/{kind}/{name}"
        if (
            name in seen
            or record.get("filename") != entry["filename"]
            or record.get("path") != path
            or record.get("bytes") != entry["uncompressed_size"]
            or record.get("crc32") != entry["crc32"]
        ):
            return False
        seen.add(name)
    return True


def _normalized(path: Path, usernames: set[str]) -> tuple[dict, int, bool]:
    records: dict[str, list[dict]] = {name: [] for name in usernames}
    invalid = 0
    if not path.is_file() or path.is_symlink():
        return records, invalid, False
    try:
        with path.open(encoding="utf-8") as handle:
            for line in handle:
                try:
                    post = json.loads(line)
                    if not isinstance(post, dict) or post.get("person_id") not in usernames:
                        invalid += 1
                    else:
                        records[post["person_id"]].append(post)
                except (ValueError, TypeError):
                    invalid += 1
    except (OSError, UnicodeError):
        return records, invalid + 1, False
    return records, invalid, True


def _source_coverage(mapping: dict | None, username: str, metadata: dict, images: dict) -> dict:
    """Separate original mapping/archive gaps from failed local downloads."""
    source_posts = set()
    source_images = set()
    orphan_images: set[str] = set()
    invalid = 0
    for name, names in (mapping or {}).items():
        if not isinstance(name, str) or not name.startswith(username + "-"):
            continue
        if (
            not re.fullmatch(rf"{re.escape(username)}-\d+\.info", name)
            or not isinstance(names, list)
            or not all(
                isinstance(image, str) and re.fullmatch(rf"{re.escape(username)}-\d+\.jpg", image)
                for image in names
            )
            or len(names) != len(set(names))
        ):
            invalid += 1
            continue
        source_posts.add(name)
        source_images.update(names)
        if name not in metadata:
            orphan_images.update(image for image in names if image in images)
    missing_posts = len(source_posts - metadata.keys())
    missing_images = len(source_images - images.keys())
    return {
        "mapping_posts": len(source_posts),
        "mapping_images": len(source_images),
        "source_mapping_posts_without_metadata": missing_posts,
        "source_mapping_images_without_archive": missing_images,
        "provided_orphan_images": len(orphan_images),
        "archive_images_not_in_mapping": len(images.keys() - source_images),
        "invalid_mapping_records": invalid,
        "complete": bool(source_posts) and not missing_posts and not missing_images and not invalid,
    }


def audit_subset(root: Path) -> dict:
    """Recheck files and joins without networking, writing, or leaking source data."""
    root = Path(root)
    manifests = root / "data/manifests"
    try:
        people = load_selection(manifests / "candidates.json")
    except (OSError, ValueError, TypeError, KeyError):
        people = []
    usernames = {person["username"] for person in people}
    mapping = _json(manifests / "image_mapping.json")
    indexes = {kind: _json(manifests / f"{kind}_index.json") for kind in ("metadata", "images")}
    try:
        provenance = hashlib.sha256(
            (manifests / "candidates.json").read_bytes()
            + (manifests / "archive_volumes.json").read_bytes()
        ).hexdigest()
    except OSError:
        provenance = None
    provenance_valid = {
        kind: bool(index and provenance and index.get("provenance_sha256") == provenance)
        for kind, index in indexes.items()
    }
    expected = {}
    index_invalid = {}
    for kind, index in indexes.items():
        expected[kind], index_invalid[kind] = _index(index, usernames, kind)
    reports_valid = {
        kind: _report_valid(_json(root / f"reports/{kind}_download.json"), expected[kind], kind)
        for kind in indexes
    }
    normalized, invalid_normalized, normalized_present = _normalized(
        root / "data/processed/posts.jsonl", usernames
    )
    subset = root / "data/subsets/instagram"
    accounts = []
    for person in people:
        username = person["username"]
        metadata_files, unsafe_metadata = _members(subset / username / "metadata", ".info", subset)
        image_files, unsafe_images = _members(subset / username / "images", ".jpg", subset)
        metadata_stats, verified_metadata = _file_stats(
            expected["metadata"][username], metadata_files, unsafe_metadata
        )
        image_stats, verified_images = _file_stats(
            expected["images"][username], image_files, unsafe_images
        )
        posts: dict[str, Post] = {}
        image_links: dict[str, list[str]] = {}
        counts: Counter[str] = Counter()
        source_coverage = _source_coverage(
            mapping, username, expected["metadata"][username], expected["images"][username]
        )
        for name in sorted(verified_metadata):
            names = mapping.get(name) if mapping is not None else None
            if names is None:
                counts["unmapped_metadata"] += 1
                names = []
            elif (
                not isinstance(names, list)
                or not all(
                    isinstance(image, str)
                    and re.fullmatch(rf"{re.escape(username)}-\d+\.jpg", image)
                    for image in names
                )
                or len(names) != len(set(names))
            ):
                counts["invalid_mapping"] += 1
                names = []
            counts["mapped_image_links"] += len(names)
            counts["missing_mapped_files"] += sum(
                image in expected["images"][username] and image not in image_files
                for image in names
            )
            counts["mapped_images_not_indexed"] += sum(
                image not in expected["images"][username] for image in names
            )
            counts["invalid_mapped_files"] += sum(
                image in expected["images"][username] and image not in verified_images
                for image in names
            )
            matching = [f"{username}/images/{image}" for image in names if image in verified_images]
            image_links[name] = matching
            counts["posts_without_images"] += not bool(matching)
            counts["posts_with_complete_image_join"] += bool(names) and len(matching) == len(names)
            counts["posts_with_complete_provided_image_join"] += bool(names) and all(
                image in verified_images for image in names if image in expected["images"][username]
            )
            try:
                record = json.loads(metadata_files[name].read_text(encoding="utf-8"))
                post = normalize_post(record, f"{username}/metadata/{name}", matching)
                if post.person_id != username or name != f"{username}-{post.post_id}.info":
                    raise ValueError("Owner/post mismatch")
                posts[name] = post
            except (OSError, ValueError, TypeError, KeyError, AttributeError, OverflowError):
                counts["invalid_metadata"] += 1
        normalized_names = set()
        normalized_good = 0
        normalized_join_good = 0
        duplicates = 0
        mismatches = 0
        for record in normalized[username]:
            source = record.get("source_file")
            name = PurePosixPath(source).name if isinstance(source, str) else ""
            if name in normalized_names:
                duplicates += 1
                continue
            normalized_names.add(name)
            normalized_post = posts.get(name)
            if normalized_post is None:
                mismatches += 1
                continue
            expected_post = normalized_post.to_dict()
            if record.get("image_files") == image_links[name]:
                normalized_join_good += 1
            if record == expected_post:
                normalized_good += 1
            else:
                mismatches += 1
        dates = sorted(post.posted_at for post in posts.values())
        joins = {
            field: counts[field]
            for field in (
                "unmapped_metadata",
                "invalid_mapping",
                "mapped_image_links",
                "missing_mapped_files",
                "mapped_images_not_indexed",
                "invalid_mapped_files",
                "posts_without_images",
                "posts_with_complete_image_join",
                "posts_with_complete_provided_image_join",
            )
        }
        joins["complete"] = (
            mapping is not None
            and bool(verified_metadata)
            and not any(
                counts[field]
                for field in ("unmapped_metadata", "invalid_mapping", "invalid_mapped_files")
            )
        )
        normalized_stats = {
            "actual": len(normalized[username]),
            "verified": normalized_good,
            "verified_image_joins": normalized_join_good,
            "duplicates": duplicates,
            "mismatches": mismatches,
            "missing": len(posts.keys() - normalized_names),
            "complete": normalized_present
            and bool(posts)
            and normalized_good == len(posts)
            and not duplicates
            and not mismatches
            and not counts["invalid_metadata"],
        }
        downloads_complete = metadata_stats["complete"] and image_stats["complete"]
        accounts.append(
            {
                "username": username,
                "cohort": person.get("cohort", "unknown"),
                "category": person.get("category", "unknown"),
                "metadata": metadata_stats,
                "images": image_stats,
                "valid_posts": len(posts),
                "invalid_metadata_records": counts["invalid_metadata"],
                "posted_at_min": dates[0] if dates else None,
                "posted_at_max": dates[-1] if dates else None,
                "image_join": joins,
                "source_coverage": source_coverage,
                "local_download_missing": metadata_stats["missing"] + image_stats["missing"],
                "normalized": normalized_stats,
                "download_complete": bool(downloads_complete),
                "complete": bool(
                    downloads_complete and joins["complete"] and normalized_stats["complete"]
                ),
            }
        )
    index_complete = {
        kind: bool(
            index
            and index.get("scan_complete") is True
            and provenance_valid[kind]
            and not index_invalid[kind]
        )
        for kind, index in indexes.items()
    }
    downloads_complete = (
        bool(accounts)
        and all(index_complete.values())
        and all(reports_valid.values())
        and all(account["download_complete"] for account in accounts)
    )
    normalized_complete = (
        bool(accounts)
        and normalized_present
        and not invalid_normalized
        and all(
            account["normalized"]["complete"] and account["image_join"]["complete"]
            for account in accounts
        )
    )
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "account_count": len(accounts),
        "cohort_counts": dict(Counter(account["cohort"] for account in accounts)),
        "index_scan_complete": index_complete,
        "index_provenance_consistent": provenance_valid,
        "invalid_index_entries": index_invalid,
        "download_reports_consistent": reports_valid,
        "mapping_available": mapping is not None,
        "normalized_available": normalized_present,
        "invalid_normalized_records": invalid_normalized,
        "download_complete": downloads_complete,
        "normalized_complete": normalized_complete,
        "source_complete": bool(accounts)
        and all(account["source_coverage"]["complete"] for account in accounts),
        "source_mapping_posts_without_metadata": sum(
            account["source_coverage"]["source_mapping_posts_without_metadata"]
            for account in accounts
        ),
        "source_mapping_images_without_archive": sum(
            account["source_coverage"]["source_mapping_images_without_archive"]
            for account in accounts
        ),
        "local_download_missing": sum(account["local_download_missing"] for account in accounts),
        "complete": bool(
            downloads_complete
            and normalized_complete
            and all(account["complete"] for account in accounts)
        ),
        "accounts": accounts,
    }


def write_candidate_report(root: Path, audit: dict) -> Path:
    """Write an aggregate JSON audit and a human-readable candidate table."""
    reports = Path(root) / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    path = reports / "candidates20.md"
    lines = [
        "# Instagram candidate subset audit",
        "",
        f"Accounts: {audit['account_count']}. Complete: **{audit['complete']}**.",
        "Dates are upload timestamps (UTC), not inferred event dates.",
        "Counts reflect this provided historical snapshot, not current profiles.",
        "Completion refers to provided archive members, not full author-mapping coverage.",
        f"Source gaps: {audit['source_mapping_posts_without_metadata']} mapped posts absent from "
        f"metadata archive; {audit['source_mapping_images_without_archive']} mapped images absent "
        "from image archive. These are not local download failures.",
        "",
        "| Account | Cohort | Metadata verified/expected | Images verified/expected "
        "| Posted range (UTC) | Missing local mapped images | Unmapped posts | Complete |",
        "|---|---|---:|---:|---|---:|---:|---|",
    ]
    for account in audit["accounts"]:
        dates = (
            "—"
            if account["posted_at_min"] is None
            else f"{account['posted_at_min'][:10]} – {account['posted_at_max'][:10]}"
        )
        lines.append(
            f"| {account['username']} | {account['cohort']} "
            f"| {account['metadata']['verified']}/{account['metadata']['expected']} "
            f"| {account['images']['verified']}/{account['images']['expected']} | {dates} "
            f"| {account['image_join']['missing_mapped_files']} "
            f"| {account['image_join']['unmapped_metadata']} | {account['complete']} |"
        )
    lines.extend(
        ["", "No captions, post identifiers, member filenames, or Drive IDs are included.", ""]
    )
    outputs = {
        reports / "dataset_audit.json": json.dumps(audit, ensure_ascii=False, indent=2) + "\n",
        path: "\n".join(lines),
    }
    for destination, body in outputs.items():
        temporary = destination.with_suffix(destination.suffix + ".part")
        temporary.write_text(body, encoding="utf-8")
        temporary.replace(destination)
    return path
