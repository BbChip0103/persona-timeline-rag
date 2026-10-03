import json
import tempfile
import unittest
from pathlib import Path

from persona_timeline_rag.datasets.mapping import filter_mapping, load_selection


class MappingTests(unittest.TestCase):
    def test_carousel_uses_author_mapping(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mapping.txt"
            path.write_text(
                "header\nsynthetic_author\t12.info\t['101.jpg', '102.jpg']\n"
                "other\t13.info\t['13.jpg']\n"
            )
            result = filter_mapping(path, {"synthetic_author"})
            self.assertEqual(
                result,
                {
                    "synthetic_author-12.info": [
                        "synthetic_author-101.jpg",
                        "synthetic_author-102.jpg",
                    ]
                },
            )

    def test_unsafe_mapping_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mapping.txt"
            path.write_text("header\nx\t12.info\t['../bad.jpg']\n")
            with self.assertRaises(ValueError):
                filter_mapping(path, {"x"})

    def test_selection_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "selection.json"
            for names in [["../x"], ["x", "x"], [str(i) for i in range(21)]]:
                path.write_text(json.dumps({"people": [{"username": n} for n in names]}))
                with self.subTest(names=names), self.assertRaises(ValueError):
                    load_selection(path)
