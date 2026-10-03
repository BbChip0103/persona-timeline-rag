"""Use the author's exact post-to-carousel image mapping, never filename guessing."""

import ast
import csv
import json
import re
from pathlib import Path


def load_selection(path: Path) -> list[dict]:
    people = json.loads(path.read_text(encoding="utf-8"))["people"]
    if not isinstance(people, list) or not people or len(people) > 20:
        raise ValueError("Selection must contain 1–20 people")
    names = []
    for person in people:
        name = person["username"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_.]{1,30}", name):
            raise ValueError("Invalid Instagram username in selection")
        names.append(name)
    if len(set(names)) != len(names):
        raise ValueError("Duplicate selected username")
    return people


def filter_mapping(path: Path, usernames: set[str]) -> dict[str, list[str]]:
    result: dict[str, list[str]] = {}
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for number, row in enumerate(csv.reader(handle, delimiter="\t"), 1):
            if number == 1:
                continue
            if not row or row[0] not in usernames:
                continue
            if len(row) != 3 or not re.fullmatch(r"\d+\.info", row[1]):
                raise ValueError(f"Invalid mapping row {number}")
            files = ast.literal_eval(row[2])
            if not isinstance(files, list) or not all(
                isinstance(name, str) and re.fullmatch(r"\d+\.jpg", name) for name in files
            ):
                raise ValueError(f"Invalid image list on mapping row {number}")
            key = f"{row[0]}-{row[1]}"
            images = [f"{row[0]}-{name}" for name in files]
            if key in result and result[key] != images:
                raise ValueError(f"Conflicting mapping for {key}")
            result[key] = images
    return result
