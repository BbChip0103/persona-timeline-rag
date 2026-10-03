import json
import tempfile
import unittest
from pathlib import Path

from persona_timeline_rag.ingestion.instagram import normalize_post, normalize_subset


def synthetic_record():
    return {
        "owner": {"username": "synthetic_author", "is_private": False},
        "id": "12",
        "shortcode": "SYNTHETIC",
        "taken_at_timestamp": 1695772800,
        "edge_media_to_caption": {"edges": [{"node": {"text": "지난주 여행 사진"}}]},
        "edge_media_to_comment": {"edges": [{"node": {"text": "PRIVATE_COMMENT"}}]},
        "is_video": False,
        "is_ad": False,
    }


class IngestionTests(unittest.TestCase):
    def test_malformed_record_and_owner_are_rejected(self):
        for record in [None, [], {"owner": ["wrong"]}]:
            with self.subTest(record=record), self.assertRaises(ValueError):
                normalize_post(record, "synthetic.info", [])

    def test_unknown_event_date_and_comments_excluded(self):
        post = normalize_post(synthetic_record(), "synthetic.info", [])
        self.assertTrue(post.posted_at.endswith("+00:00"))
        self.assertIsNone(post.event_date)
        self.assertEqual(post.event_date_basis, "unknown")
        self.assertNotIn("PRIVATE_COMMENT", json.dumps(post.to_dict()))

    def test_private_owner_and_invalid_timestamp_rejected(self):
        for change in [
            {"owner": {"username": "x", "is_private": True}},
            {"taken_at_timestamp": True},
            {"id": ""},
            {"id": None},
            {"id": True},
        ]:
            record = synthetic_record() | change
            with self.subTest(change=change), self.assertRaises(ValueError):
                normalize_post(record, "synthetic.info", [])

    def test_mapping_and_owner_are_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata = root / "subsets/synthetic_author/metadata"
            metadata.mkdir(parents=True)
            images = root / "subsets/synthetic_author/images"
            images.mkdir()
            (images / "synthetic_author-101.jpg").write_bytes(b"SYNTHETIC_NOT_REAL_IMAGE")
            (metadata / "synthetic_author-12.info").write_text(json.dumps(synthetic_record()))
            (metadata / "wrong-owner.info").write_text(
                json.dumps(synthetic_record() | {"owner": {"username": "other"}})
            )
            mapping = root / "mapping.json"
            mapping.write_text(
                json.dumps({"synthetic_author-12.info": ["synthetic_author-101.jpg"]})
            )
            output = root / "posts.jsonl"
            report = normalize_subset(root / "subsets", output, mapping, {"synthetic_author"})
            self.assertEqual(report["written"], 1)
            self.assertEqual(report["rejected"], 1)
            post = json.loads(output.read_text())
            self.assertEqual(
                post["image_files"], ["synthetic_author/images/synthetic_author-101.jpg"]
            )

    def test_stale_nonselected_account_is_not_normalized(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["synthetic_author", "stale_author"]:
                metadata = root / "subsets" / name / "metadata"
                metadata.mkdir(parents=True)
                record = synthetic_record() | {"owner": {"username": name}}
                (metadata / f"{name}-12.info").write_text(json.dumps(record))
            mapping = root / "mapping.json"
            mapping.write_text("{}")
            report = normalize_subset(
                root / "subsets", root / "posts.jsonl", mapping, {"synthetic_author"}
            )
            self.assertEqual(report["written"], 1)
            self.assertEqual(report["unexpected_directories_skipped"], ["stale_author"])
