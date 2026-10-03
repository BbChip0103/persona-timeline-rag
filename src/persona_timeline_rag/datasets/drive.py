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
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from html.parser import HTMLParser
from http.client import IncompleteRead
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen


class DownloadError(RuntimeError):
    pass


@dataclass(frozen=True)
class DriveFile:
    name: str
    id: str
    size_bytes: int


class WarningForm(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.action: str | None = None
        self.fields: dict[str, str] = {}
        self.inside = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if tag == "form" and values.get("id") == "download-form":
            self.inside = True
            self.action = values.get("action")
        if tag == "input" and self.inside and values.get("name"):
            self.fields[str(values["name"])] = values.get("value") or ""

    def handle_endtag(self, tag: str) -> None:
        if tag == "form":
            self.inside = False


def parse_warning(html: str, file_id: str) -> str:
    form = WarningForm()
    form.feed(html)
    if not form.action or urlparse(form.action).hostname != "drive.usercontent.google.com":
        raise DownloadError("Drive access/quota/login page instead of a download warning")
    if urlparse(form.action).scheme != "https" or form.fields.get("id") != file_id:
        raise DownloadError("Invalid Drive download warning form")
    if form.fields.get("confirm") != "t" or not form.fields.get("uuid"):
        raise DownloadError("Unsupported Drive warning; no automatic acceptance")
    return form.action + "?" + urlencode(form.fields)


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

    def _open(self, request: Request):
        for attempt in range(self.attempts):
            try:
                return urlopen(request, timeout=self.timeout)
            except HTTPError as error:
                if error.code not in (429, 500, 502, 503, 504) or attempt + 1 == self.attempts:
                    raise DownloadError(
                        f"Drive HTTP {error.code}: access/quota/network failure"
                    ) from error
            except (URLError, TimeoutError, OSError) as error:
                if attempt + 1 == self.attempts:
                    raise DownloadError(f"Drive transport failed: {error}") from error
            time.sleep(min(2**attempt, 10))
        raise DownloadError("Retry limit reached")

    def folder(self, folder_id: str) -> list[DriveFile]:
        request = Request(f"https://drive.google.com/drive/folders/{folder_id}")
        with self._open(request) as response:
            body = response.read(8 * 1024 * 1024 + 1)
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
        with self._open(Request(url)) as response:
            content_type = response.headers.get("Content-Type", "")
            if "text/html" in content_type:
                body = response.read(65537)
                if len(body) > 65536:
                    raise DownloadError("Drive returned an oversized non-file HTML page")
                url = parse_warning(body.decode("utf-8"), file_id)
            else:
                url = response.url
        with self.lock:
            self.urls[file_id] = url
        return url

    def read_range(self, file: DriveFile, offset: int, size: int) -> bytes:
        if size == 0:
            return b""
        if offset < 0 or size < 0 or offset + size > file.size_bytes:
            raise DownloadError("Range is outside the declared archive volume")
        request = Request(
            self.resolve(file.id),
            headers={"Range": f"bytes={offset}-{offset + size - 1}", "Accept-Encoding": "identity"},
        )
        for attempt in range(self.attempts):
            try:
                with self._open(request) as response:
                    expected = f"bytes {offset}-{offset + size - 1}/{file.size_bytes}"
                    if response.status != 206 or response.headers.get("Content-Range") != expected:
                        raise DownloadError(
                            "Server ignored/mismatched Range; refusing full archive download"
                        )
                    if "text/html" in response.headers.get("Content-Type", ""):
                        raise DownloadError("HTML returned for a binary archive range")
                    body = response.read(size + 1)
                if len(body) != size:
                    raise IncompleteRead(body, size - len(body))
            except (IncompleteRead, TimeoutError, OSError) as error:
                if attempt + 1 == self.attempts:
                    raise DownloadError(f"Archive range transfer failed: {error}") from error
                time.sleep(min(2**attempt, 10))
                continue
            with self.lock:
                self.network_bytes += size
            return body
        raise DownloadError("Range retry limit reached")

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
            with self._open(Request(self.resolve(file.id))) as response:
                if "text/html" in response.headers.get("Content-Type", ""):
                    raise DownloadError("Drive returned HTML, not dataset bytes")
                with temporary.open("wb") as handle:
                    while chunk := response.read(min(1024 * 1024, max_bytes - written + 1)):
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
