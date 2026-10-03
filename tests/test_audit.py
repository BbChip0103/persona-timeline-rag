"""Synthetic local datasets: source gaps are distinct from download failures."""

import hashlib
import json
import tempfile
import unittest
import zlib
from pathlib import Path

from persona_timeline_rag.audit import audit_subset, write_candidate_report
from persona_timeline_rag.ingestion.instagram import normalize_post


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def make_dataset(root, count=2):
    people = [
        {"username": f"person{i}", "cohort": "domestic" if i < count // 2 else "overseas"}
        for i in range(count)
    ]
    mapping = {}
    indexes = {
        kind: {"scan_complete": True, "entries": [], "selected_counts": {}}
        for kind in ["metadata", "images"]
    }
    reports = {kind: {"complete": True, "errors": [], "files": []} for kind in indexes}
    normalized = []

    def add_file(kind, username, name, body):
        path = root / f"data/subsets/instagram/{username}/{kind}/{name}"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        folder = "info" if kind == "metadata" else "image"
        entry = {
            "filename": f"{folder}/{name}",
            "uncompressed_size": len(body),
            "crc32": zlib.crc32(body) & 0xFFFFFFFF,
        }
        indexes[kind]["entries"].append(entry)
        reports[kind]["files"].append(
            {
                "filename": entry["filename"],
                "path": str(path.relative_to(root)),
                "bytes": len(body),
                "crc32": entry["crc32"],
            }
        )

    for i, person in enumerate(people):
        username = person["username"]
        for j in range(2):
            post_id = str(1000 + i * 10 + j)
            name = f"{username}-{post_id}.info"
            # A carousel's image IDs intentionally differ from its parent post ID.
            image_names = [
                f"{username}-{2000 + i * 10 + j * 2 + k}.jpg" for k in range(2 if j == 0 else 1)
            ]
            mapping[name] = image_names
            record = {
                "owner": {"username": username, "is_private": False},
                "id": post_id,
                "taken_at_timestamp": 1560000000 + j * 86400,
                "shortcode": "private-test-shortcode",
                "is_video": False,
                "edge_media_to_caption": {"edges": [{"node": {"text": "SECRET_CAPTION"}}]},
            }
            add_file("metadata", username, name, json.dumps(record).encode())
            for image_name in image_names:
                add_file("images", username, image_name, b"\xff\xd8SYNTHETIC_JPEG\xff\xd9")
            normalized.append(
                normalize_post(
                    record,
                    f"{username}/metadata/{name}",
                    [f"{username}/images/{image}" for image in image_names],
                ).to_dict()
            )
        indexes["metadata"]["selected_counts"][username] = 2
        indexes["images"]["selected_counts"][username] = 3
    write_json(root / "data/manifests/candidates.json", {"people": people})
    write_json(
        root / "data/manifests/archive_volumes.json",
        {
            "metadata": [{"name": "synthetic.zip", "id": "SECRET_DRIVE_ID", "size_bytes": 100}],
            "images": [{"name": "synthetic.zip", "id": "SECRET_DRIVE_ID", "size_bytes": 100}],
        },
    )
    provenance = hashlib.sha256(
        (root / "data/manifests/candidates.json").read_bytes()
        + (root / "data/manifests/archive_volumes.json").read_bytes()
    ).hexdigest()
    write_json(root / "data/manifests/image_mapping.json", mapping)
    for kind in indexes:
        reports[kind]["expected"] = reports[kind]["verified"] = len(indexes[kind]["entries"])
        indexes[kind]["approval_token"] = "SECRET_DRIVE_ID"
        indexes[kind]["provenance_sha256"] = provenance
        write_json(root / f"data/manifests/{kind}_index.json", indexes[kind])
        write_json(root / f"reports/{kind}_download.json", reports[kind])
    processed = root / "data/processed/posts.jsonl"
    processed.parent.mkdir(parents=True, exist_ok=True)
    processed.write_text("".join(json.dumps(post) + "\n" for post in normalized), encoding="utf-8")
    return mapping, normalized


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.mapping, self.normalized = make_dataset(self.root)

    def account(self, result, username="person0"):
        return next(account for account in result["accounts"] if account["username"] == username)

    def rewrite_normalized(self, records):
        (self.root / "data/processed/posts.jsonl").write_text(
            "".join(json.dumps(record) + "\n" for record in records), encoding="utf-8"
        )

    def test_complete_and_exact_carousel_join(self):
        result = audit_subset(self.root)
        self.assertTrue(result["complete"])
        self.assertTrue(result["source_complete"])
        self.assertEqual(result["cohort_counts"], {"domestic": 1, "overseas": 1})
        account = self.account(result)
        self.assertEqual(account["metadata"]["verified"], 2)
        self.assertEqual(account["images"]["verified"], 3)
        self.assertEqual(account["normalized"]["verified_image_joins"], 2)
        self.assertEqual(account["image_join"]["mapped_image_links"], 3)
        self.assertLess(account["posted_at_min"], account["posted_at_max"])

    def test_twenty_accounts_and_cohorts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            make_dataset(root, 20)
            result = audit_subset(root)
            self.assertTrue(result["complete"])
            self.assertEqual(result["account_count"], 20)
            self.assertEqual(result["cohort_counts"], {"domestic": 10, "overseas": 10})

    def test_missing_local_image_invalidates_historical_report(self):
        (self.root / "data/subsets/instagram/person0/images/person0-2000.jpg").unlink()
        result = audit_subset(self.root)
        self.assertFalse(result["download_complete"])
        self.assertFalse(result["complete"])
        self.assertEqual(result["local_download_missing"], 1)
        self.assertEqual(self.account(result)["image_join"]["missing_mapped_files"], 1)
        self.assertEqual(result["source_mapping_images_without_archive"], 0)

    def test_crc_reverification_same_size_corruption(self):
        path = self.root / "data/subsets/instagram/person0/images/person0-2000.jpg"
        body = bytearray(path.read_bytes())
        body[5] ^= 1
        path.write_bytes(body)
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        self.assertEqual(self.account(result)["images"]["corrupt"], 1)

    def test_missing_metadata_file(self):
        (self.root / "data/subsets/instagram/person0/metadata/person0-1000.info").unlink()
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        self.assertEqual(self.account(result)["metadata"]["missing"], 1)

    def test_original_source_gaps_do_not_trigger_download_failure(self):
        self.mapping["person0-9999.info"] = ["person0-2000.jpg"]
        self.mapping["person0-1000.info"].append("person0-8888.jpg")
        write_json(self.root / "data/manifests/image_mapping.json", self.mapping)
        result = audit_subset(self.root)
        self.assertTrue(result["download_complete"])
        self.assertTrue(result["complete"])
        self.assertFalse(result["source_complete"])
        self.assertEqual(result["source_mapping_posts_without_metadata"], 1)
        self.assertEqual(result["source_mapping_images_without_archive"], 1)
        self.assertEqual(result["local_download_missing"], 0)
        account = self.account(result)
        self.assertEqual(account["source_coverage"]["provided_orphan_images"], 1)
        self.assertEqual(account["image_join"]["posts_with_complete_provided_image_join"], 2)

    def test_unmapped_metadata_does_not_get_guessed_image(self):
        del self.mapping["person0-1000.info"]
        write_json(self.root / "data/manifests/image_mapping.json", self.mapping)
        result = audit_subset(self.root)
        self.assertTrue(result["download_complete"])
        self.assertFalse(result["normalized_complete"])
        self.assertEqual(self.account(result)["image_join"]["unmapped_metadata"], 1)

    def test_wrong_normalized_carousel_images(self):
        self.normalized[0]["image_files"] = ["person0/images/person0-1000.jpg"]
        self.rewrite_normalized(self.normalized)
        result = audit_subset(self.root)
        self.assertFalse(result["normalized_complete"])
        self.assertEqual(self.account(result)["normalized"]["mismatches"], 1)

    def test_stale_source_manifest_invalidates_otherwise_consistent_downloads(self):
        path = self.root / "data/manifests/archive_volumes.json"
        source = json.loads(path.read_text())
        source["images"][0]["id"] = "different-approved-source"
        write_json(path, source)
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        self.assertFalse(result["index_provenance_consistent"]["images"])

    def test_normalized_extra_private_fields_are_rejected(self):
        self.normalized[0]["comments"] = ["PRIVATE_COMMENT"]
        self.rewrite_normalized(self.normalized)
        result = audit_subset(self.root)
        self.assertFalse(result["normalized_complete"])
        self.assertEqual(self.account(result)["normalized"]["mismatches"], 1)

    def test_missing_normalized_record(self):
        self.rewrite_normalized(self.normalized[1:])
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        self.assertEqual(self.account(result)["normalized"]["missing"], 1)

    def test_duplicate_normalized_record(self):
        self.rewrite_normalized(self.normalized + self.normalized[:1])
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        self.assertEqual(self.account(result)["normalized"]["duplicates"], 1)

    def test_no_normalized_file_is_not_complete(self):
        (self.root / "data/processed/posts.jsonl").unlink()
        result = audit_subset(self.root)
        self.assertTrue(result["download_complete"])
        self.assertFalse(result["complete"])

    def test_absent_or_incomplete_index_is_not_complete(self):
        path = self.root / "data/manifests/metadata_index.json"
        path.unlink()
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        write_json(path, {"scan_complete": False, "entries": []})
        self.assertFalse(audit_subset(self.root)["complete"])

    def test_zero_expected_account_is_not_complete(self):
        path = self.root / "data/manifests/candidates.json"
        people = json.loads(path.read_text())["people"]
        people.append({"username": "empty_person", "cohort": "domestic"})
        write_json(path, {"people": people})
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        self.assertFalse(self.account(result, "empty_person")["download_complete"])

    def test_empty_selection_is_not_complete(self):
        write_json(self.root / "data/manifests/candidates.json", {"people": []})
        result = audit_subset(self.root)
        self.assertEqual(result["account_count"], 0)
        self.assertFalse(result["complete"])

    def test_false_download_report_claim(self):
        path = self.root / "reports/images_download.json"
        report = json.loads(path.read_text())
        report["verified"] += 1
        write_json(path, report)
        result = audit_subset(self.root)
        self.assertFalse(result["download_complete"])
        self.assertFalse(result["download_reports_consistent"]["images"])

    def test_symlink_is_not_verified(self):
        path = self.root / "data/subsets/instagram/person0/images/person0-2000.jpg"
        body = path.read_bytes()
        path.unlink()
        other = self.root / "outside.jpg"
        other.write_bytes(body)
        path.symlink_to(other)
        result = audit_subset(self.root)
        self.assertFalse(result["complete"])
        self.assertEqual(self.account(result)["images"]["unsafe"], 1)

    def test_reports_do_not_expose_private_values(self):
        result = audit_subset(self.root)
        path = write_candidate_report(self.root, result)
        self.assertEqual(path, self.root / "reports/candidates20.md")
        public = path.read_text() + (self.root / "reports/dataset_audit.json").read_text()
        for secret in [
            "SECRET_CAPTION",
            "SECRET_DRIVE_ID",
            "person0-1000.info",
            "private-test-shortcode",
        ]:
            self.assertNotIn(secret, public)
        self.assertIn("upload timestamps", public)


if __name__ == "__main__":
    unittest.main()
