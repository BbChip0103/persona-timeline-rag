"""Small reproducible local commands; no paid model calls are made."""

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

from persona_timeline_rag.audit import audit_subset, write_candidate_report
from persona_timeline_rag.datasets.catalog import load_catalog
from persona_timeline_rag.datasets.drive import DriveClient
from persona_timeline_rag.datasets.mapping import filter_mapping, load_selection
from persona_timeline_rag.datasets.subset import download_subset, index_archive, write_json
from persona_timeline_rag.ingestion.instagram import normalize_subset


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Licensed Instagram timeline research tools")
    parser.add_argument("--root", type=Path, default=Path.cwd())
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("catalog", help="Summarize the downloaded influencer catalog")
    pilot = commands.add_parser("download-pilot", help="Download only small starter files")
    pilot.add_argument("--folder-id", required=True)
    for command in ["index", "download-subset"]:
        sub = commands.add_parser(command)
        sub.add_argument("--kind", choices=["metadata", "images"], required=True)
        if command == "download-subset":
            sub.add_argument("--workers", type=int, default=4)
    commands.add_parser("map-images", help="Filter author mapping to selected accounts")
    commands.add_parser("normalize", help="Normalize source JSONs, not event extraction")
    commands.add_parser("audit", help="Recheck local files, CRCs, image joins and source gaps")
    args = parser.parse_args(argv)
    root = args.root.resolve()
    try:
        if args.command == "catalog":
            records = load_catalog(root / "data/raw/instagram/influencers.txt")
            result = {
                "accounts": len(records),
                "categories": dict(Counter(record.category for record in records)),
            }
        elif args.command == "download-pilot":
            client = DriveClient()
            files = client.folder(args.folder_id)
            receipts = []
            for file in files:
                if file.name in {"influencers.txt", "README.docx", "sample_images.zip"}:
                    path = root / "data/raw/instagram" / file.name
                    receipts.append(client.download(file, path, 60 * 1024 * 1024))
            if len(receipts) != 3:
                raise ValueError("Expected starter files absent from author folder")
            result = {"files": receipts}
            write_json(root / "data/manifests/pilot_receipts.json", result)
        elif args.command == "index":
            indexed = index_archive(root, args.kind)
            result = {key: value for key, value in indexed.items() if key != "entries"}
        elif args.command == "download-subset":
            report = download_subset(root, args.kind, args.workers)
            result = {key: value for key, value in report.items() if key != "files"}
            if not report["complete"]:
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 1
        elif args.command == "map-images":
            people = load_selection(root / "data/manifests/candidates.json")
            mapping = filter_mapping(
                root / "data/raw/instagram/JSON-Image_files_mapping.txt",
                {person["username"] for person in people},
            )
            write_json(root / "data/manifests/image_mapping.json", mapping)
            result = {"posts_mapped": len(mapping), "image_links": sum(map(len, mapping.values()))}
        elif args.command == "audit":
            audit = audit_subset(root)
            path = write_candidate_report(root, audit)
            result = {key: value for key, value in audit.items() if key != "accounts"}
            result["report"] = str(path.relative_to(root))
            if not audit["complete"]:
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 1
        else:
            result = normalize_subset(
                root / "data/subsets/instagram",
                root / "data/processed/posts.jsonl",
                root / "data/manifests/image_mapping.json",
                {p["username"] for p in load_selection(root / "data/manifests/candidates.json")},
            )
            write_json(root / "reports/normalization.json", result)
            if result["rejected"]:
                print(json.dumps(result, ensure_ascii=False, indent=2))
                return 1
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, RuntimeError, KeyError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
