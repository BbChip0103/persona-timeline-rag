"""Normalize provided .info JSONs. Comments, user tags, and bystanders are omitted."""

import json
import re
from datetime import UTC, datetime
from pathlib import Path

from persona_timeline_rag.schemas import Post


def normalize_post(record: dict, source_file: str, image_files: list[str]) -> Post:
    if not isinstance(record, dict):
        raise ValueError("Invalid metadata record shape")
    owner = record.get("owner") or {}
    if not isinstance(owner, dict):
        raise ValueError("Invalid metadata owner shape")
    username = owner.get("username")
    if not isinstance(username, str) or not username:
        raise ValueError("Missing owner.username")
    if owner.get("is_private") is True:
        raise ValueError("Private-owner record excluded")
    raw_id = record.get("id")
    if isinstance(raw_id, bool) or not isinstance(raw_id, (str, int)):
        raise ValueError("Missing or invalid post ID")
    post_id = str(raw_id)
    if not re.fullmatch(r"\d+", post_id):
        raise ValueError("Missing or invalid post ID")
    timestamp = record.get("taken_at_timestamp")
    if not isinstance(timestamp, (int, float)) or isinstance(timestamp, bool):
        raise ValueError("Missing or invalid taken_at_timestamp")
    posted_at = datetime.fromtimestamp(timestamp, UTC).isoformat()
    edges = (record.get("edge_media_to_caption") or {}).get("edges") or []
    texts = [edge.get("node", {}).get("text", "") for edge in edges]
    caption = "\n".join(text for text in texts if isinstance(text, str))
    shortcode = record.get("shortcode")
    url = f"https://www.instagram.com/p/{shortcode}/" if shortcode else None
    is_ad = record.get("is_ad")
    return Post(
        person_id=username,
        post_id=post_id,
        posted_at=posted_at,
        caption=caption,
        source_url=url,
        source_file=source_file,
        is_video=bool(record.get("is_video", False)),
        is_ad=is_ad if isinstance(is_ad, bool) else None,
        image_files=image_files,
    )


def normalize_subset(
    subset_root: Path, output: Path, mapping_path: Path, usernames: set[str]
) -> dict:
    """Write only an allowlisted post schema, atomically, and audit exclusions."""
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".part")
    counts = {"written": 0, "rejected": 0, "duplicates": 0, "without_images": 0}
    errors: list[dict] = []
    seen: set[tuple[str, str]] = set()
    mapping = json.loads(mapping_path.read_text(encoding="utf-8"))
    unexpected = []
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            for person_dir in sorted(subset_root.iterdir()):
                if not person_dir.is_dir():
                    continue
                if person_dir.name not in usernames:
                    unexpected.append(person_dir.name)
                    continue
                metadata_dir = person_dir / "metadata"
                for path in sorted(metadata_dir.glob("*.info")):
                    try:
                        record = json.loads(path.read_text(encoding="utf-8"))
                        names = mapping.get(path.name, [])
                        matching = [
                            str(image.relative_to(subset_root))
                            for name in names
                            if Path(name).name == name
                            for image in [person_dir / "images" / name]
                            if image.is_file()
                        ]
                        post = normalize_post(record, str(path.relative_to(subset_root)), matching)
                        if post.person_id != person_dir.name:
                            raise ValueError("Owner does not match selected directory")
                        key = (post.person_id, post.post_id)
                        if key in seen:
                            counts["duplicates"] += 1
                            continue
                        seen.add(key)
                        handle.write(json.dumps(post.to_dict(), ensure_ascii=False) + "\n")
                        counts["written"] += 1
                        counts["without_images"] += not bool(matching)
                    except (ValueError, TypeError, KeyError, OverflowError, OSError) as error:
                        counts["rejected"] += 1
                        errors.append(
                            {
                                "source_file": str(path.relative_to(subset_root)),
                                "reason": str(error),
                            }
                        )
        temporary.replace(output)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return {**counts, "errors": errors, "unexpected_directories_skipped": unexpected}
