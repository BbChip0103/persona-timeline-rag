"""Read the author's TSV, keeping snapshot metrics distinct from subset counts."""

import csv
from dataclasses import asdict, dataclass
from pathlib import Path


@dataclass(frozen=True)
class Influencer:
    username: str
    category: str
    followers_at_collection: int
    following_at_collection: int
    profile_posts_at_collection: int

    def to_dict(self) -> dict:
        return asdict(self)


def load_catalog(path: Path) -> list[Influencer]:
    records: list[Influencer] = []
    seen: set[str] = set()
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for line_number, row in enumerate(csv.reader(handle, delimiter="\t"), 1):
            if not row or row[0] == "Username" or set(row[0]) == {"="}:
                continue
            if len(row) != 5:
                raise ValueError(f"Invalid catalog row {line_number}: expected 5 columns")
            username, category, followers, following, posts = row
            if username in seen:
                raise ValueError(f"Duplicate username: {username}")
            numbers = [int(value) for value in (followers, following, posts)]
            if any(value < 0 for value in numbers):
                raise ValueError(f"Negative metric for {username}")
            records.append(Influencer(username, category, *numbers))
            seen.add(username)
    return records
