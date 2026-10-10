"""Bounded, verified downloads from the author's Google Drive distribution.

No Google login, Instagram scraping, or authentication-bypass logic is used.
Only the ordinary Drive large-file virus-scan warning form is supported.
"""

import codecs
import hashlib
import json
import re
import shutil
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from http.client import IncompleteRead
from http.cookiejar import Cookie, CookieJar, DefaultCookiePolicy
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse
from urllib.request import HTTPRedirectHandler

import httpx
from bs4 import BeautifulSoup, Tag
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential


class DownloadError(RuntimeError):
    pass


@dataclass(frozen=True)
class DriveFile:
    name: str
    id: str
    size_bytes: int


class _FormEndPositions(HTMLParser):
    """Native closing-token positions preserve legacy malformed-form boundaries."""

    def __init__(self) -> None:
        super().__init__()
        self.positions: list[tuple[int, int]] = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "form":
            self.positions.append(self.getpos())


class _NoCookies(DefaultCookiePolicy):
    """The original urllib opener had no HTTPCookieProcessor."""

    def set_ok(self, cookie: Cookie, request: Any) -> bool:
        return False

    def return_ok(self, cookie: Cookie, request: Any) -> bool:
        return False


def parse_warning(html: str, file_id: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    ends = _FormEndPositions()
    ends.feed(html)
    action = None
    fields: dict[str, str] = {}
    # BeautifulSoup owns attribute/entity parsing and tag traversal. Its repaired
    # DOM parentage is NOT the old policy: any closing form ended the active
    # region, while unrelated malformed end tags did not. Replay native token
    # positions, retaining only this distribution-specific compatibility policy.
    events: list[tuple[int, int, int, Tag | None]] = [
        (element.sourceline or 0, element.sourcepos or 0, 0, element)
        for element in soup.find_all(["form", "input"])
    ]
    events.extend((line, column, 1, None) for line, column in ends.positions)
    active = False
    for _line, _column, _kind, element in sorted(events, key=lambda event: event[:3]):
        if element is None:
            active = False
        elif element.name == "form" and element.get("id") == "download-form":
            active = True
            value = element.get("action")
            action = str(value) if value is not None else None
        elif element.name == "input" and active and element.get("name"):
            fields[str(element.get("name"))] = str(element.get("value") or "")
    if not action or urlparse(action).hostname != "drive.usercontent.google.com":
        raise DownloadError("Drive access/quota/login page instead of a download warning")
    if urlparse(action).scheme != "https" or fields.get("id") != file_id:
        raise DownloadError("Invalid Drive download warning form")
    if fields.get("confirm") != "t" or not fields.get("uuid"):
        raise DownloadError("Unsupported Drive warning; no automatic acceptance")
    return action + "?" + urlencode(fields)


def _read_bounded(response: httpx.Response, size: int) -> bytes:
    """Read at most the caller's sentinel budget, without decoding binary data."""
    body = bytearray()
    for chunk in response.iter_raw():
        body.extend(chunk[: size - len(body)])
        if len(body) == size:
            break
    return bytes(body)


def parse_folder(html: str) -> list[DriveFile]:
    """Read the public page's existing JSON inventory without evaluating JS."""
    match = re.search(r"window\['_DRIVE_ivd'\]\s*=\s*'((?:\\.|[^'\\])*)'", html)
    if not match:
        raise DownloadError("Folder listing unavailable (access/login/layout change)")
    payload = codecs.decode(match.group(1).replace(r"\/", "/"), "unicode_escape")
    rows = json.loads(payload)[0]
    result = []
    for row in rows:
        if row[3] == "application/vnd.google-apps.folder":
            continue
        result.append(DriveFile(row[2], row[0], int(row[13])))
    return result


class DriveClient:
    def __init__(self, timeout: float = 90, attempts: int = 4) -> None:
        self.timeout = timeout
        self.attempts = attempts
        self.urls: dict[str, str] = {}
        self.lock = threading.Lock()
        self.network_bytes = 0

    def _retrying(self, predicate: Callable[[BaseException], bool]) -> Retrying:
        return Retrying(
            stop=stop_after_attempt(self.attempts),
            wait=wait_exponential(multiplier=1, max=10),
            retry=retry_if_exception(predicate),
            reraise=True,
        )

    @contextmanager
    def _open(self, url: str, headers: dict[str, str] | None = None) -> Iterator[httpx.Response]:
        if self.attempts <= 0:
            raise DownloadError("Retry limit reached")

        def retryable(error: BaseException) -> bool:
            if isinstance(error, httpx.HTTPStatusError):
                return error.response.status_code in (429, 500, 502, 503, 504)
            return isinstance(error, (httpx.TransportError, TimeoutError, OSError))

        visited: dict[str, int] = {}
        initial_request = True

        def redirect_policy(request: httpx.Request) -> None:
            nonlocal initial_request
            if initial_request:
                initial_request = False
                return
            # HTTPX owns redirect construction and dispatch. Match urllib's
            # distinct-target/repeat policy on the resulting native next request;
            # a total-10 cap would wrongly reject allowed multi-URL cycles.
            target = str(request.url)
            if (visited.get(target, 0) >= HTTPRedirectHandler.max_repeats
                    or len(visited) >= HTTPRedirectHandler.max_redirections):
                raise DownloadError("Drive redirect limit exceeded")
            visited[target] = visited.get(target, 0) + 1

        # Per-open ownership avoids a persistent client escaping this historical
        # synchronous API. HTTPX follows the redirects urllib previously followed;
        # native transport retries stay disabled so Tenacity owns all attempts.
        with httpx.Client(
            timeout=self.timeout,
            follow_redirects=True,
            headers={"Accept-Encoding": "identity"},
            cookies=CookieJar(policy=_NoCookies()),
            max_redirects=HTTPRedirectHandler.max_repeats * HTTPRedirectHandler.max_redirections,
            event_hooks={"request": [redirect_policy]},
        ) as client:
            request = client.build_request("GET", url, headers=headers)

            def send() -> httpx.Response:
                nonlocal initial_request
                initial_request = True
                visited.clear()
                response = client.send(request, stream=True)
                try:
                    response.raise_for_status()
                except BaseException:
                    response.close()
                    raise
                return response

            try:
                response = self._retrying(retryable)(send)
            except httpx.HTTPStatusError as error:
                raise DownloadError(
                    f"Drive HTTP {error.response.status_code}: access/quota/network failure"
                ) from error
            except httpx.TooManyRedirects as error:
                raise DownloadError("Drive redirect limit exceeded") from error
            except (httpx.TransportError, TimeoutError, OSError) as error:
                raise DownloadError(f"Drive transport failed: {error}") from error
            try:
                yield response
            except httpx.TimeoutException as error:
                raise TimeoutError("Drive body transfer timed out") from error
            except httpx.TransportError as error:
                # Keep the historical CLI's OSError boundary for interrupted
                # streamed bodies; range retries remain owned by the outer policy.
                raise OSError("Drive body transfer failed") from error
            finally:
                response.close()

    def folder(self, folder_id: str) -> list[DriveFile]:
        with self._open(f"https://drive.google.com/drive/folders/{folder_id}") as response:
            body = _read_bounded(response, 8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise DownloadError("Folder HTML exceeded bounded inventory limit")
        return parse_folder(body.decode("utf-8"))

    def resolve(self, file_id: str) -> str:
        with self.lock:
            if file_id in self.urls:
                return self.urls[file_id]
        url = "https://drive.usercontent.google.com/download?" + urlencode(
            {"id": file_id, "export": "download"}
        )
        with self._open(url) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text/html" in content_type:
                body = _read_bounded(response, 65537)
                if len(body) > 65536:
                    raise DownloadError("Drive returned an oversized non-file HTML page")
                url = parse_warning(body.decode("utf-8"), file_id)
            else:
                url = str(response.url)
        with self.lock:
            self.urls[file_id] = url
        return url

    def read_range(self, file: DriveFile, offset: int, size: int) -> bytes:
        if size == 0:
            return b""
        if offset < 0 or size < 0 or offset + size > file.size_bytes:
            raise DownloadError("Range is outside the declared archive volume")
        url = self.resolve(file.id)
        headers = {"Range": f"bytes={offset}-{offset + size - 1}", "Accept-Encoding": "identity"}
        if self.attempts <= 0:
            raise DownloadError("Range retry limit reached")

        def transfer() -> bytes:
            with self._open(url, headers) as response:
                expected = f"bytes {offset}-{offset + size - 1}/{file.size_bytes}"
                if response.status_code != 206 or response.headers.get("Content-Range") != expected:
                    raise DownloadError(
                        "Server ignored/mismatched Range; refusing full archive download"
                    )
                if "text/html" in response.headers.get("Content-Type", ""):
                    raise DownloadError("HTML returned for a binary archive range")
                body = _read_bounded(response, size + 1)
            if len(body) != size:
                raise IncompleteRead(body, size - len(body))
            return body

        failures = (IncompleteRead, TimeoutError, OSError, httpx.TransportError)
        try:
            body = self._retrying(lambda error: isinstance(error, failures))(transfer)
        except failures as error:
            raise DownloadError(f"Archive range transfer failed: {error}") from error
        with self.lock:
            self.network_bytes += size
        return body

    def download(self, file: DriveFile, destination: Path, max_bytes: int) -> dict:
        if file.size_bytes > max_bytes:
            raise DownloadError(f"{file.name} exceeds the explicit download byte budget")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if shutil.disk_usage(destination.parent).free < file.size_bytes + 256 * 1024 * 1024:
            raise DownloadError("Insufficient free disk space for bounded download")
        temporary = destination.with_name(destination.name + ".part")
        digest = hashlib.sha256()
        written = 0
        try:
            with self._open(self.resolve(file.id)) as response:
                if "text/html" in response.headers.get("Content-Type", ""):
                    raise DownloadError("Drive returned HTML, not dataset bytes")
                with temporary.open("wb") as handle:
                    for chunk in response.iter_raw():
                        chunk = chunk[:max_bytes - written + 1]
                        written += len(chunk)
                        if written > max_bytes or written > file.size_bytes:
                            raise DownloadError("Download exceeded its declared size")
                        handle.write(chunk)
                        digest.update(chunk)
            if written != file.size_bytes:
                raise DownloadError(f"Size mismatch for {file.name}: {written}/{file.size_bytes}")
            temporary.replace(destination)
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
        return {
            **asdict(file),
            "sha256": digest.hexdigest(),
            "retrieved_at": datetime.now(UTC).isoformat(),
            "path": str(destination),
        }


class DriveRangeReader:
    def __init__(self, client: DriveClient, files: list[DriveFile], cache_root: Path | None = None):
        self.client = client
        self.files = files
        fingerprint = hashlib.sha256(
            json.dumps([(file.id, file.size_bytes) for file in files]).encode()
        ).hexdigest()
        self.cache_root = cache_root / fingerprint if cache_root else None
        self.cached_span: tuple[int, int, bytes] | None = None

    def read(self, disk: int, offset: int, size: int) -> bytes:
        if size == 0:
            return b""
        if self.cached_span:
            span_disk, start, body = self.cached_span
            if span_disk == disk and start <= offset and offset + size <= start + len(body):
                return body[offset - start : offset - start + size]
        cache = None
        if self.cache_root:
            cache = self.cache_root / f"{disk}-{offset}-{size}.bin"
            if cache.exists() and cache.stat().st_size == size:
                return cache.read_bytes()
        body = self.client.read_range(self.files[disk], offset, size)
        if cache is not None:
            cache.parent.mkdir(parents=True, exist_ok=True)
            temporary = cache.with_suffix(".part")
            temporary.write_bytes(body)
            temporary.replace(cache)
        return body

    def prefetch(self, disk: int, offset: int, size: int) -> None:
        self.cached_span = (disk, offset, self.client.read_range(self.files[disk], offset, size))
