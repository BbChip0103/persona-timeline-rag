"""The split copy must never authorize a source write or unrelated database."""

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from persona_timeline_rag.split_migration import MigrationError, read_environment, validate_target


class SplitMigrationBoundaryTests(unittest.TestCase):
    def test_only_explicit_isolated_source(self):
        self.assertEqual(
            validate_target(
                "postgresql://ptr_researcher:private@127.0.0.1:56432/ptr_research", source=True
            )["dbname"],
            "ptr_research",
        )
        for url in [
            "postgresql://ptr_researcher:private@localhost:56432/ptr_research",
            "postgresql://postgres:private@127.0.0.1:56432/ptr_research",
            "postgresql://ptr_researcher:private@127.0.0.1:54322/ptr_research",
            "postgresql://ptr_researcher:private@127.0.0.1:56432/ptr_research?sslmode=require",
        ]:
            with self.assertRaises(MigrationError):
                validate_target(url, source=True)

    def test_target_requires_owner_and_new_database(self):
        self.assertEqual(
            validate_target(
                "postgresql://ptr_split_owner:private@127.0.0.1:58432/ptr_split_research"
            )["user"],
            "ptr_split_owner",
        )
        for url in [
            "postgresql://ptr_split_app:private@127.0.0.1:58432/ptr_split_research",
            "postgresql://ptr_split_owner:private@127.0.0.1:58432/ptr_research",
            "postgresql://ptr_split_owner:private@127.0.0.1:58432/ptr_split_research#anything",
        ]:
            with self.assertRaises(MigrationError):
                validate_target(url)

    def test_error_never_contains_credentials(self):
        with self.assertRaises(MigrationError) as raised:
            validate_target("postgresql://privateuser:privatepassword@privatehost/db")
        self.assertNotIn("private", str(raised.exception))

    def test_private_env_without_shell_evaluation(self):
        with TemporaryDirectory() as d:
            p = Path(d) / "roles.env"
            p.write_text('A="literal$VALUE"\n# comment\nB=other\n')
            p.chmod(0o600)
            self.assertEqual(read_environment(p), {"A": "literal$VALUE", "B": "other"})
            p.chmod(0o644)
            with self.assertRaises(MigrationError):
                read_environment(p)
