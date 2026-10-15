"""Run before the harness: its assertions must reject missing evidence."""

import unittest

from assertions import verify


class Contract(unittest.TestCase):
    def test_missing_observations_fail(self):
        for case in ("C1", "C2", "C3", "C4", "C5", "C6"):
            with self.subTest(case=case), self.assertRaises(AssertionError):
                verify(case, {})

    def test_receipt_mismatch_fails(self):
        with self.assertRaises(AssertionError):
            verify(
                "C1", dict(completed=20, total=20, maximum=2, submitted=4, receipts=3, duplicates=0)
            )

    def test_duplicates_fail(self):
        with self.assertRaises(AssertionError):
            verify(
                "C5", dict(failed=1, unknown=1, submitted=2, duplicates=1, unaffected=1, mode="500")
            )

    def test_unknown_is_not_a_settled_receipt(self):
        with self.assertRaises(AssertionError):
            verify(
                "C1",
                dict(
                    completed=20,
                    total=20,
                    maximum=2,
                    submitted=10,
                    receipts=10,
                    duplicates=0,
                    offloaded=10,
                    unknown=1,
                ),
            )


if __name__ == "__main__":
    unittest.main()
