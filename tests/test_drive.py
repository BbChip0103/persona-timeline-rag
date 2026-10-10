import unittest
from unittest.mock import patch

from persona_timeline_rag.datasets.drive import DownloadError, DriveClient, DriveFile, parse_warning


class FakeResponse:
    status = 200
    headers = {"Content-Type": "application/octet-stream", "Content-Range": "bytes 0-3/100"}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, size):
        return b"data"

    @property
    def status_code(self):
        return self.status

    def iter_raw(self):
        yield self.read(65536)


class DriveTests(unittest.TestCase):
    def test_warning_only_allows_correct_drive_host_and_id(self):
        html = '<form id="download-form" action="https://drive.usercontent.google.com/download">'
        html += '<input name="id" value="fake"><input name="confirm" value="t">'
        html += '<input name="uuid" value="fake-uuid"></form>'
        self.assertIn("confirm=t", parse_warning(html, "fake"))
        for bad in [
            html.replace("drive.usercontent.google.com", "example.com"),
            html.replace('value="fake"', 'value="wrong"'),
            "Access denied",
        ]:
            with self.subTest(bad=bad), self.assertRaises(DownloadError):
                parse_warning(bad, "fake")

    def test_server_ignoring_range_is_rejected_without_reading_body(self):
        client = DriveClient(attempts=1)
        file = DriveFile("archive.zip", "fake", 100)
        with (
            patch.object(client, "resolve", return_value="https://example.invalid"),
            patch.object(client, "_open", return_value=FakeResponse()),
            patch.object(FakeResponse, "read", side_effect=AssertionError("must not read")),
        ):
            with self.assertRaises(DownloadError):
                client.read_range(file, 0, 4)

    def test_truncated_and_mismatched_ranges_rejected(self):
        client = DriveClient(attempts=1)
        file = DriveFile("archive.zip", "fake", 100)
        response = FakeResponse()
        response.status = 206
        response.headers = {"Content-Range": "bytes 0-3/100"}
        with (
            patch.object(client, "resolve", return_value="https://example.invalid"),
            patch.object(client, "_open", return_value=response),
            patch.object(FakeResponse, "read", return_value=b"bad"),
        ):
            with self.assertRaises(DownloadError):
                client.read_range(file, 0, 4)

    def test_interrupted_body_transfer_retries_without_accepting_partial_bytes(self):
        client = DriveClient(attempts=2)
        response = FakeResponse()
        response.status = 206
        with (
            patch.object(client, "resolve", return_value="https://example.invalid"),
            patch.object(client, "_open", return_value=response),
            patch.object(FakeResponse, "read", side_effect=[TimeoutError(), b"data"]) as read,
            patch("tenacity.nap.time.sleep"),
        ):
            self.assertEqual(client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), b"data")
            self.assertEqual(read.call_count, 2)
            self.assertEqual(client.network_bytes, 4)
