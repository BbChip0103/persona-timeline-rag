import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

from persona_timeline_rag.cli import main


class CliTests(unittest.TestCase):
    def test_audit_missing_dataset_returns_nonzero_and_writes_explicit_report(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                code = main(["--root", directory, "audit"])
            self.assertEqual(code, 1)
            self.assertFalse(json.loads(output.getvalue())["complete"])
            report = Path(directory) / "reports/dataset_audit.json"
            self.assertTrue(report.exists())
            self.assertEqual(json.loads(report.read_text())["account_count"], 0)
