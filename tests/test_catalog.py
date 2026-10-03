import tempfile
import unittest
from pathlib import Path

from persona_timeline_rag.datasets.catalog import load_catalog


class CatalogTests(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "influencers.txt"
            path.write_text(text, encoding="utf-8")
            return load_catalog(path)

    def test_snapshot_metrics_not_subset_count(self):
        rows = self.parse(
            "Username\tCategory\t#Followers\t#Followees\t#Posts\n===\n"
            "synthetic_author\ttravel\t1200\t50\t900\n"
        )
        self.assertEqual(rows[0].profile_posts_at_collection, 900)
        self.assertNotIn("downloaded_posts", rows[0].to_dict())

    def test_invalid_duplicate_and_negative(self):
        for text in [
            "x\ttravel\t1\t2\n",
            "x\ttravel\t-1\t2\t3\n",
            "x\ttravel\t1\t2\t3\nx\ttravel\t1\t2\t3\n",
        ]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.parse(text)
