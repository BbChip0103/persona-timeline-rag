"""Synthetic native-client regressions; never access Drive or a real archive."""

import hashlib
import io
import tempfile
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from email.message import Message
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlsplit
from urllib.request import BaseHandler, ProxyHandler, build_opener
from urllib.response import addinfourl

import httpx
from bs4 import BeautifulSoup
from tenacity import Retrying
from test_range_zip import fixture

from persona_timeline_rag.datasets.drive import DownloadError, DriveClient, DriveFile, parse_warning


class Stream(httpx.SyncByteStream):
    def __init__(self, chunks=(), error=None):
        self.chunks, self.error = chunks, error
        self.reads, self.closed = 0, False

    def __iter__(self):
        for chunk in self.chunks:
            self.reads += 1
            yield chunk
        if self.error:
            raise self.error

    def close(self):
        self.closed = True


class NativeDriveTests(unittest.TestCase):
    def transport(self, handler):
        clients = []
        native = httpx.Client

        def owned(**options):
            client = native(transport=httpx.MockTransport(handler), **options)
            clients.append(client)
            return client

        return patch("persona_timeline_rag.datasets.drive.httpx.Client", owned), clients

    def urllib_redirect_count(self, next_path, terminal_after=None):
        requests = []

        class Synthetic(BaseHandler):
            handler_order = 100  # Before the default HTTPHandler; no sockets.

            def http_open(self, request):
                requests.append(request.full_url)
                headers = Message()
                terminal = len(requests) == terminal_after
                if not terminal:
                    headers["Location"] = "http://synthetic.invalid/" + str(
                        next_path(int(urlsplit(request.full_url).path[1:]))
                    )
                response = addinfourl(
                    io.BytesIO(b"data" if terminal else b""),
                    headers,
                    request.full_url,
                    206 if terminal else 302,
                )
                response.msg = "synthetic"
                return response

        # Explicitly disable ambient proxies; sockets are a hard test failure.
        with patch("socket.create_connection", side_effect=AssertionError("No network permitted")):
            try:
                with build_opener(ProxyHandler({}), Synthetic()).open(
                    "http://synthetic.invalid/0"
                ) as response:
                    self.assertEqual(response.read(), b"data")
                return len(requests), True
            except HTTPError as error:
                error.close()
                return len(requests), False

    def test_native_redirect_limits_match_actual_urllib_distinct_and_repeat_counts(self):
        for name, next_path, expected in [
            ("self", lambda current: current, 5),
            ("two-url-cycle", lambda current: (current + 1) % 2, 9),
            ("nine-url-cycle", lambda current: (current + 1) % 9, 37),
            ("distinct-chain", lambda current: current + 1, 11),
        ]:
            with self.subTest(name=name):
                self.assertEqual(self.urllib_redirect_count(next_path), (expected, False))
                requests, streams = [], []

                def handler(request):
                    requests.append(request)
                    stream = Stream([b"redirect"])
                    streams.append(stream)
                    target = next_path(int(request.url.path[1:]))
                    return httpx.Response(302, headers={"Location": f"/{target}"}, stream=stream)

                transport, clients = self.transport(handler)
                client = DriveClient(attempts=4)
                with (
                    transport,
                    patch.object(client, "resolve", return_value="http://synthetic.invalid/0"),
                    patch("tenacity.nap.time.sleep") as sleep,
                    self.assertRaises(DownloadError),
                ):
                    client.read_range(DriveFile("a.zip", "fake", 100), 0, 4)
                self.assertEqual(len(requests), expected)
                sleep.assert_not_called()
                self.assertEqual(client.network_bytes, 0)
                self.assertTrue(all(s.closed for s in streams))
                self.assertTrue(all(c.is_closed for c in clients))

    def test_native_redirect_allowed_boundaries_and_retry_budget_reset(self):
        for name, next_path, redirects in [
            ("four-self-redirects", lambda current: current, 4),
            ("ten-distinct-redirects", lambda current: current + 1, 10),
            ("thirty-redirect-cycle", lambda current: (current + 1) % 9, 30),
        ]:
            with self.subTest(name=name):
                self.assertEqual(
                    self.urllib_redirect_count(next_path, redirects + 1), (redirects + 1, True)
                )
                requests, streams = [], []

                def handler(request):
                    requests.append(request)
                    in_attempt = (len(requests) - 1) % (redirects + 1)
                    terminal = in_attempt == redirects
                    status = 503 if terminal and len(requests) == redirects + 1 else 206
                    headers = (
                        {"Content-Range": "bytes 0-3/100"}
                        if terminal
                        else {"Location": f"/{next_path(int(request.url.path[1:]))}"}
                    )
                    stream = Stream([b"data" if terminal else b"redirect"])
                    streams.append(stream)
                    return httpx.Response(
                        status if terminal else 302, headers=headers, stream=stream
                    )

                transport, clients = self.transport(handler)
                client = DriveClient(attempts=2)
                with (
                    transport,
                    patch.object(client, "resolve", return_value="http://synthetic.invalid/0"),
                    patch("tenacity.nap.time.sleep") as sleep,
                ):
                    self.assertEqual(
                        client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), b"data"
                    )
                self.assertEqual(len(requests), (redirects + 1) * 2)
                sleep.assert_called_once_with(1.0)
                self.assertTrue(all(s.closed for s in streams))
                self.assertTrue(all(c.is_closed for c in clients))

    def test_native_redirect_exception_is_sanitized_nonretryable_and_closes_client(self):
        native, clients, streams = httpx.Client, [], []

        def handler(request):
            stream = Stream([b"redirect"])
            streams.append(stream)
            return httpx.Response(302, headers={"Location": "/next"}, stream=stream)

        def bounded_native(**options):
            options["max_redirects"] = 0  # Exercise real HTTPX's defensive cap.
            client = native(transport=httpx.MockTransport(handler), **options)
            clients.append(client)
            return client

        client = DriveClient(attempts=4)
        with (
            patch("persona_timeline_rag.datasets.drive.httpx.Client", bounded_native),
            patch.object(client, "resolve", return_value="http://synthetic.invalid/0"),
            patch("tenacity.nap.time.sleep") as sleep,
            self.assertRaisesRegex(DownloadError, "^Drive redirect limit exceeded$"),
        ):
            client.read_range(DriveFile("a.zip", "fake", 100), 0, 4)
        self.assertEqual(len(streams), 1)
        sleep.assert_not_called()
        self.assertTrue(all(s.closed for s in streams))
        self.assertTrue(all(c.is_closed for c in clients))

    def test_native_html_traversal_preserves_multiple_forms_entities_and_all_inputs(self):
        html = (
            '<form id="download-form" action="https://drive.usercontent.google.com/download">'
            '<input name="id" value="fake"><input name="confirm" value="t">'
            '<input name="extra" value="one&amp;two"></form>'
            '<form id="download-form" action="https://drive.usercontent.google.com/final">'
            '<input name="uuid" value="token"><input name="empty"></form>'
        )
        with patch("persona_timeline_rag.datasets.drive.BeautifulSoup", wraps=BeautifulSoup) as sdk:
            url = parse_warning(html, "fake")
        sdk.assert_called_once()
        self.assertEqual(urlsplit(url).path, "/final")
        self.assertEqual(
            parse_qs(urlsplit(url).query, keep_blank_values=True),
            {
                "id": ["fake"],
                "confirm": ["t"],
                "extra": ["one&two"],
                "uuid": ["token"],
                "empty": [""],
            },
        )

    def test_nested_form_closing_boundary_does_not_accept_later_fields(self):
        start = (
            '<form id="download-form" '
            'action="https://drive.usercontent.google.com/download">'
            '<input name="id" value="fake"><input name="confirm" value="t">'
        )
        for nested in [
            '<form id="other"></form>',
            '<form id="download-form" action="https://drive.usercontent.google.com/other"></form>',
        ]:
            with self.subTest(nested=nested), self.assertRaises(DownloadError):
                parse_warning(start + nested + '<input name="uuid" value="after"></form>', "fake")
        url = parse_warning(
            start + '<form id="other"><input name="uuid" value="nested">'
            '</form><input name="uuid" value="after"></form>',
            "fake",
        )
        self.assertEqual(parse_qs(urlsplit(url).query)["uuid"], ["nested"])

    def test_unrelated_malformed_closing_tag_does_not_end_active_form(self):
        html = (
            '<div><form id="download-form" '
            'action="https://drive.usercontent.google.com/download"></div>'
            '<input name="uuid" value="token"><input name="id" value="fake">'
            '<input name="confirm" value="t"></form>'
        )
        self.assertEqual(
            parse_qs(urlsplit(parse_warning(html, "fake")).query),
            {"uuid": ["token"], "id": ["fake"], "confirm": ["t"]},
        )

    def test_set_cookie_is_not_retained_or_forwarded_on_redirect_or_retry(self):
        requests = []

        def handler(request):
            requests.append(request)
            self.assertNotIn("cookie", request.headers)
            if request.url.path == "/start":
                return httpx.Response(
                    302, headers={"Location": "/file", "Set-Cookie": "secret=synthetic; Path=/"}
                )
            return httpx.Response(
                503 if len(requests) == 2 else 206,
                headers={
                    "Set-Cookie": "secret=synthetic; Path=/",
                    "Content-Range": "bytes 0-3/100",
                },
                stream=Stream([b"data"]),
            )

        transport, clients = self.transport(handler)
        client = DriveClient(attempts=2)
        with (
            transport,
            patch.object(client, "resolve", return_value="https://synthetic.invalid/start"),
            patch("tenacity.nap.time.sleep"),
        ):
            self.assertEqual(client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), b"data")
        self.assertEqual(len(requests), 4)
        self.assertTrue(all(not c.cookies and c.is_closed for c in clients))

    def test_all_retryable_statuses_and_capped_backoff_use_native_scheduler(self):
        for status in [429, 500, 502, 503, 504]:
            with self.subTest(status=status):
                requests, sleeps = [], []

                def handler(request):
                    requests.append(request)
                    self.assertEqual(request.headers["accept-encoding"], "identity")
                    return httpx.Response(
                        status if len(requests) < 6 else 206,
                        headers={"Content-Range": "bytes 0-3/100"},
                        stream=Stream([b"data"]),
                    )

                transport, clients = self.transport(handler)
                client = DriveClient(attempts=6)
                with (
                    transport,
                    patch.object(client, "resolve", return_value="https://synthetic.invalid"),
                    patch("tenacity.nap.time.sleep", side_effect=sleeps.append),
                ):
                    self.assertEqual(
                        client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), b"data"
                    )
                self.assertEqual(sleeps, [1, 2, 4, 8, 10])
                self.assertEqual(len(requests), 6)
                self.assertTrue(all(c.is_closed for c in clients))

    def test_parallel_range_reads_keep_success_only_accounting_and_owned_clients(self):
        def handler(request):
            return httpx.Response(
                206, headers={"Content-Range": "bytes 0-3/100"}, stream=Stream([b"data"])
            )

        transport, clients = self.transport(handler)
        client = DriveClient(attempts=1)
        client.urls["fake"] = "https://synthetic.invalid"
        with transport, ThreadPoolExecutor(max_workers=4) as executor:
            values = list(
                executor.map(
                    lambda _: client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), range(8)
                )
            )
        self.assertEqual(values, [b"data"] * 8)
        self.assertEqual(client.network_bytes, 32)
        self.assertEqual(len(clients), 8)
        self.assertTrue(all(c.is_closed for c in clients))

    def test_warning_and_folder_html_limits_stop_stream_and_close(self):
        for method, limit in [("resolve", 65536), ("folder", 8 * 1024 * 1024)]:
            with self.subTest(method=method):
                stream = Stream([b"x" * (limit + 1), b"must not consume"])
                transport, clients = self.transport(
                    lambda _: httpx.Response(
                        200, headers={"Content-Type": "text/html"}, stream=stream
                    )
                )
                with transport, self.assertRaises(DownloadError):
                    getattr(DriveClient(attempts=1), method)("fake")
                self.assertEqual(stream.reads, 1)
                self.assertTrue(stream.closed and all(c.is_closed for c in clients))

    def test_body_transport_failure_keeps_oserror_cleanup_boundary(self):
        stream = Stream([b"da"], error=httpx.ReadError("synthetic"))
        transport, clients = self.transport(lambda _: httpx.Response(200, stream=stream))
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "file"
            client = DriveClient(attempts=1)
            with (
                transport,
                patch.object(client, "resolve", return_value="https://synthetic.invalid"),
                self.assertRaises(OSError),
            ):
                client.download(DriveFile("file", "fake", 4), destination, 4)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_name("file.part").exists())
        self.assertTrue(stream.closed and all(c.is_closed for c in clients))

    def test_native_retry_statuses_schedule_exact_backoff_and_close_responses(self):
        streams, sends, sleeps, calls = [], [], [], []
        native_call = Retrying.__call__

        def tracked(self, *args, **kwargs):
            calls.append(self)
            return native_call(self, *args, **kwargs)

        def handler(request):
            sends.append(request)
            stream = Stream([b"data"])
            streams.append(stream)
            return httpx.Response(
                503 if len(sends) < 4 else 206,
                headers={"Content-Range": "bytes 0-3/100"},
                stream=stream,
            )

        transport, clients = self.transport(handler)
        client = DriveClient(attempts=4)
        with (
            transport,
            patch.object(client, "resolve", return_value="https://synthetic.invalid"),
            patch("tenacity.nap.time.sleep", side_effect=sleeps.append),
            patch.object(Retrying, "__call__", tracked),
        ):
            self.assertEqual(client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), b"data")
        self.assertEqual(len(calls), 2)
        self.assertEqual(sleeps, [1, 2, 4])
        self.assertEqual(len(sends), 4)
        self.assertTrue(all(stream.closed for stream in streams))
        self.assertTrue(all(client.is_closed for client in clients))
        self.assertEqual(client.network_bytes, 4)

    def test_native_nested_attempts_restart_open_counter_after_body_failure(self):
        statuses = iter([503, 206, 503, 206])
        streams, sends, sleeps = [], [], []

        def handler(request):
            sends.append(request)
            status = next(statuses)
            stream = (
                Stream(error=httpx.ReadTimeout("synthetic"))
                if len(sends) == 2
                else Stream([b"data"])
            )
            streams.append(stream)
            return httpx.Response(status, headers={"Content-Range": "bytes 0-3/100"}, stream=stream)

        transport, clients = self.transport(handler)
        client = DriveClient(attempts=2)
        with (
            transport,
            patch.object(client, "resolve", return_value="https://synthetic.invalid"),
            patch("tenacity.nap.time.sleep", side_effect=sleeps.append),
        ):
            self.assertEqual(client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), b"data")
        self.assertEqual(sleeps, [1, 1, 1])
        self.assertEqual(len(sends), 4)
        self.assertTrue(all(s.closed for s in streams))
        self.assertTrue(all(c.is_closed for c in clients))
        self.assertEqual(client.network_bytes, 4)

    def test_rejected_status_and_range_never_read_body_or_retry(self):
        for status, headers in [
            (403, {}),
            (200, {}),
            (206, {"Content-Range": "bytes 0-2/100"}),
            (206, {"Content-Range": "bytes 0-3/99"}),
            (206, {"Content-Range": "bytes 0-3/100", "Content-Type": "text/html"}),
        ]:
            with self.subTest(status=status, headers=headers):
                stream, requests = Stream([b"must not consume"]), []

                def handler(request):
                    requests.append(request)
                    return httpx.Response(status, headers=headers, stream=stream)

                transport, clients = self.transport(handler)
                client = DriveClient(attempts=4)
                with (
                    transport,
                    patch.object(client, "resolve", return_value="https://synthetic.invalid"),
                    self.assertRaises(DownloadError),
                ):
                    client.read_range(DriveFile("a.zip", "fake", 100), 0, 4)
                self.assertEqual((len(requests), stream.reads), (1, 0))
                self.assertTrue(stream.closed and all(c.is_closed for c in clients))

    def test_native_redirect_range_headers_and_resolution_cache(self):
        requests = []

        def handler(request):
            requests.append(request)
            if request.url.host == "drive.usercontent.google.com":
                return httpx.Response(302, headers={"Location": "https://synthetic.invalid/file"})
            return httpx.Response(
                206 if "range" in request.headers else 200,
                headers={"Content-Range": "bytes 0-3/100"},
                stream=Stream([b"data"]),
            )

        transport, clients = self.transport(handler)
        client = DriveClient(attempts=1)
        with transport:
            self.assertEqual(client.resolve("fake"), "https://synthetic.invalid/file")
            self.assertEqual(client.resolve("fake"), "https://synthetic.invalid/file")
            self.assertEqual(client.read_range(DriveFile("a.zip", "fake", 100), 0, 4), b"data")
        self.assertEqual(len(requests), 3)
        self.assertEqual(requests[-1].headers["range"], "bytes=0-3")
        self.assertEqual(requests[-1].headers["accept-encoding"], "identity")
        self.assertTrue(all(c.is_closed for c in clients))

    def test_bounded_range_never_consumes_following_chunks(self):
        stream = Stream([b"12345", b"must not consume"])
        transport, clients = self.transport(
            lambda _: httpx.Response(206, headers={"Content-Range": "bytes 0-3/100"}, stream=stream)
        )
        client = DriveClient(attempts=1)
        with (
            transport,
            patch.object(client, "resolve", return_value="https://synthetic.invalid"),
            self.assertRaises(DownloadError),
        ):
            client.read_range(DriveFile("a.zip", "fake", 100), 0, 4)
        self.assertEqual(stream.reads, 1)
        self.assertEqual(client.network_bytes, 0)
        self.assertTrue(stream.closed and all(c.is_closed for c in clients))

    def test_atomic_download_hash_and_oversize_cleanup(self):
        for chunks, success in [([b"da", b"ta"], True), ([b"12345", b"unread"], False)]:
            with self.subTest(success=success), tempfile.TemporaryDirectory() as directory:
                stream = Stream(chunks)
                transport, clients = self.transport(lambda _: httpx.Response(200, stream=stream))
                destination = Path(directory) / "file"
                destination.write_bytes(b"old")
                client = DriveClient(attempts=1)
                with (
                    transport,
                    patch.object(client, "resolve", return_value="https://synthetic.invalid"),
                ):
                    if success:
                        receipt = client.download(DriveFile("file", "fake", 4), destination, 4)
                        self.assertEqual(destination.read_bytes(), b"data")
                        self.assertEqual(receipt["sha256"], hashlib.sha256(b"data").hexdigest())
                    else:
                        with self.assertRaises(DownloadError):
                            client.download(DriveFile("file", "fake", 4), destination, 4)
                        self.assertEqual(destination.read_bytes(), b"old")
                        self.assertEqual(stream.reads, 1)
                self.assertFalse(destination.with_name("file.part").exists())
                self.assertTrue(stream.closed and all(c.is_closed for c in clients))

    def test_stdlib_concatenation_is_not_genuine_split_zip_support(self):
        for zip64 in [False, True]:
            with self.subTest(zip64=zip64):
                volumes, _ = fixture(
                    [("info/alice-1.info", b"a" * 200, 0), ("info/bob-2.info", b"b" * 200, 8)],
                    cuts=(17, 70, 180),
                    zip64=zip64,
                )
                with (
                    self.assertRaises(zipfile.BadZipFile),
                    zipfile.ZipFile(io.BytesIO(b"".join(volumes))) as archive,
                ):
                    for item in archive.infolist():
                        archive.read(item)
