import hashlib
import json
import tempfile
import unittest
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

from persona_timeline_rag.datasets.drive import DriveClient, DriveFile, DriveRangeReader
from persona_timeline_rag.datasets.range_zip import ZipEntry
from persona_timeline_rag.datasets.subset import (
    _groups,
    _validate_member,
    completion_report,
    download_subset,
)


class SubsetTests(unittest.TestCase):
    def test_invalid_metadata_shapes_are_member_failures_not_uncaught_exceptions(self):
        for body in [b"null", b"[]", b'{"owner": []}', b'{"owner": null}']:
            with self.subTest(body=body), self.assertRaises(ValueError):
                _validate_member(body, "metadata", "alice")

    def test_empty_and_missing_accounts_never_complete(self):
        result = completion_report("metadata", [], [], [], {"alice"}, 0)
        self.assertFalse(result["complete"])
        self.assertEqual(result["missing_accounts"], ["alice"])
        entry = ZipEntry("info/alice-1.info", 0, 0, 1, 1, 0, 0)
        files = [{"path": "data/subsets/instagram/alice/metadata/alice-1.info"}]
        self.assertFalse(
            completion_report("metadata", [entry], files, [], {"alice", "bob"}, 0)["complete"]
        )
        self.assertTrue(completion_report("metadata", [entry], files, [], {"alice"}, 0)["complete"])

    def test_source_volume_identity_changes_cache_namespace(self):
        client = DriveClient()
        a = DriveRangeReader(client, [DriveFile("x.zip", "source-a", 100)], Path("cache"))
        b = DriveRangeReader(client, [DriveFile("x.zip", "source-b", 100)], Path("cache"))
        self.assertNotEqual(a.cache_root, b.cache_root)

    def test_coalescing_does_not_cross_disks(self):
        entries = [
            ZipEntry("info/a-1.info", 0, 100, 20, 20, 0, 0),
            ZipEntry("info/a-2.info", 0, 150, 20, 20, 0, 0),
            ZipEntry("info/b-1.info", 1, 100, 20, 20, 0, 0),
        ]
        groups = _groups(entries, [10000, 10000])
        self.assertEqual([len(group) for group in groups], [2, 1])

    def test_bad_member_does_not_starve_next_member_in_same_batch(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifests = root / "data/manifests"
            manifests.mkdir(parents=True)
            selection = manifests / "candidates.json"
            selection.write_text(json.dumps({"people": [{"username": "alice"}]}))
            volumes = manifests / "archive_volumes.json"
            volumes.write_text(
                json.dumps(
                    {"metadata": [{"name": "archive.zip", "id": "fake", "size_bytes": 10000}]}
                )
            )
            entries = [
                ZipEntry("info/alice-1.info", 0, 100, 20, 20, 0, 0),
                ZipEntry("info/alice-2.info", 0, 150, 20, 20, 0, 0),
            ]
            index = {
                "scan_complete": True,
                "provenance_sha256": hashlib.sha256(
                    selection.read_bytes() + volumes.read_bytes()
                ).hexdigest(),
                "entries": [asdict(entry) for entry in entries],
            }
            (manifests / "metadata_index.json").write_text(json.dumps(index))
            valid = json.dumps({"owner": {"username": "alice"}}).encode()
            with (
                patch("persona_timeline_rag.datasets.subset.SplitZipArchive") as archive,
                patch("persona_timeline_rag.datasets.subset.DriveRangeReader"),
            ):
                archive.return_value.extract.side_effect = [ValueError("bad CRC"), valid]
                result = download_subset(root, "metadata")
            self.assertFalse(result["complete"])
            self.assertEqual(result["verified"], 1)
            self.assertEqual(len(result["errors"]), 1)
            self.assertTrue((root / "data/subsets/instagram/alice/metadata/alice-2.info").exists())
