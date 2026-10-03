"""Read selected members of split ZIP archives without downloading every volume.

The reader performs transport/authentication; this module validates ZIP structure,
streams its central directory in bounded chunks, and checks extracted bytes.
Disk numbers are zero-based (``.z01`` is disk 0; the final ``.zip`` is last).
"""

from __future__ import annotations

import struct
import zlib
from bisect import bisect_right
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Protocol


class ArchiveError(ValueError):
    """An archive is malformed, unsupported, truncated, or exceeds a limit."""


class RangeReader(Protocol):
    def read(self, disk: int, offset: int, size: int) -> bytes:
        """Return exactly ``size`` bytes from one volume, or raise an error."""


@dataclass(frozen=True)
class ZipEntry:
    filename: str
    disk: int
    offset: int
    compressed_size: int
    uncompressed_size: int
    crc32: int
    method: int
    flags: int = 0


@dataclass(frozen=True)
class CentralDirectory:
    disk: int
    offset: int
    size: int
    entries: int


_EOCD = struct.Struct("<4s4H2LH")
_ZIP64_END = struct.Struct("<4sQ2H2L4Q")
_ZIP64_LOCATOR = struct.Struct("<4sLQL")
_CENTRAL = struct.Struct("<4s6H3L5H2L")
_LOCAL = struct.Struct("<4s5H3L2H")
_MAX16 = 0xFFFF
_MAX32 = 0xFFFFFFFF


def _extras(data: bytes) -> Iterator[tuple[int, bytes]]:
    pos = 0
    while pos < len(data):
        if pos + 4 > len(data):
            raise ArchiveError("Truncated ZIP extra field")
        tag, size = struct.unpack_from("<HH", data, pos)
        pos += 4
        if pos + size > len(data):
            raise ArchiveError("Truncated ZIP extra field payload")
        yield tag, data[pos : pos + size]
        pos += size


def _zip64_values(extra: bytes, specifications: Sequence[tuple[int, bool]]) -> list[int]:
    """Read only sentinel-replaced fields, in the ordering mandated by ZIP64."""
    payloads = [value for tag, value in _extras(extra) if tag == 0x0001]
    if any(required for _, required in specifications) and len(payloads) != 1:
        raise ArchiveError("Missing or ambiguous ZIP64 extra field")
    data = payloads[0] if payloads else b""
    result: list[int] = []
    pos = 0
    for size, required in specifications:
        if required:
            if pos + size > len(data):
                raise ArchiveError("Truncated ZIP64 extra field")
            result.append(int.from_bytes(data[pos : pos + size], "little"))
            pos += size
    return result


def _decode_name(raw: bytes, flags: int) -> str:
    try:
        return raw.decode("utf-8" if flags & 0x800 else "cp437")
    except UnicodeDecodeError as exc:
        raise ArchiveError("Invalid ZIP filename encoding") from exc


def _validate_path(filename: str) -> None:
    path = PurePosixPath(filename)
    if (
        not filename
        or "\x00" in filename
        or "\\" in filename
        or path.is_absolute()
        or not path.parts
        or ".." in path.parts
        or ":" in path.parts[0]
        or any(ord(char) < 32 for char in filename)
    ):
        raise ArchiveError(f"Unsafe ZIP member path: {filename!r}")


class _DirectoryCursor:
    """Buffer remote ranges instead of making one HTTP request per member."""

    def __init__(self, archive: SplitZipArchive, directory: CentralDirectory):
        self.archive = archive
        self.absolute = archive._absolute(directory.disk, directory.offset)
        self.remaining = directory.size
        self.buffer = b""
        self.position = 0

    def read(self, size: int) -> bytes:
        if size < 0 or size > self.remaining + len(self.buffer) - self.position:
            raise ArchiveError("Truncated central directory")
        parts: list[bytes] = []
        while size:
            available = len(self.buffer) - self.position
            if not available:
                count = min(self.archive.chunk_size, self.remaining)
                if not count:
                    raise ArchiveError("Truncated central directory")
                self.buffer = self.archive._read_absolute(self.absolute, count)
                self.position = 0
                self.absolute += count
                self.remaining -= count
                available = count
            count = min(size, available)
            parts.append(self.buffer[self.position : self.position + count])
            self.position += count
            size -= count
        return b"".join(parts)

    @property
    def available(self) -> int:
        return self.remaining + len(self.buffer) - self.position


class SplitZipArchive:
    def __init__(
        self,
        reader: RangeReader,
        sizes: Sequence[int],
        *,
        chunk_size: int = 1024 * 1024,
        max_uncompressed_size: int = 64 * 1024 * 1024,
        max_compressed_size: int = 64 * 1024 * 1024,
    ):
        if not sizes or any(not isinstance(size, int) or size <= 0 for size in sizes):
            raise ArchiveError("Volume sizes must be positive integers")
        if chunk_size <= 0 or max_uncompressed_size <= 0 or max_compressed_size <= 0:
            raise ArchiveError("Chunk and extraction limits must be positive")
        self.reader = reader
        self.sizes = tuple(sizes)
        self.chunk_size = chunk_size
        self.max_uncompressed_size = max_uncompressed_size
        self.max_compressed_size = max_compressed_size
        self._starts = [0]
        for size in sizes:
            self._starts.append(self._starts[-1] + size)
        self.directory = self._find_directory()

    def _absolute(self, disk: int, offset: int) -> int:
        if not 0 <= disk < len(self.sizes) or not 0 <= offset <= self.sizes[disk]:
            raise ArchiveError(f"Invalid archive location: disk {disk}, offset {offset}")
        return self._starts[disk] + offset

    def _read_absolute(self, absolute: int, size: int) -> bytes:
        if absolute < 0 or size < 0 or absolute + size > self._starts[-1]:
            raise ArchiveError("Range extends beyond archive volumes")
        parts: list[bytes] = []
        while size:
            disk = bisect_right(self._starts, absolute) - 1
            offset = absolute - self._starts[disk]
            count = min(size, self.sizes[disk] - offset)
            result = self.reader.read(disk, offset, count)
            if not isinstance(result, bytes) or len(result) != count:
                raise ArchiveError(
                    f"Short range read from disk {disk} at {offset}: expected {count}"
                )
            parts.append(result)
            absolute += count
            size -= count
        return b"".join(parts)

    def _read(self, disk: int, offset: int, size: int) -> bytes:
        return self._read_absolute(self._absolute(disk, offset), size)

    def _find_directory(self) -> CentralDirectory:
        final_disk = len(self.sizes) - 1
        tail_size = min(self.sizes[-1], _EOCD.size + _MAX16)
        tail_offset = self.sizes[-1] - tail_size
        tail = self._read(final_disk, tail_offset, tail_size)
        pos = len(tail)
        while True:
            pos = tail.rfind(b"PK\x05\x06", 0, pos)
            if pos < 0:
                raise ArchiveError("End of central directory not found")
            if pos + _EOCD.size <= len(tail):
                end = _EOCD.unpack_from(tail, pos)
                if pos + _EOCD.size + end[-1] == len(tail):
                    break
        _, disk, cd_disk, disk_entries, entries, cd_size, cd_offset, _ = end
        eocd_absolute = self._absolute(final_disk, tail_offset + pos)
        if disk not in (final_disk, _MAX16):
            raise ArchiveError("EOCD disk count does not match provided volumes")
        needs_zip64 = (
            disk == _MAX16
            or cd_disk == _MAX16
            or disk_entries == _MAX16
            or entries == _MAX16
            or cd_size == _MAX32
            or cd_offset == _MAX32
        )
        if needs_zip64:
            locator = self._read_absolute(eocd_absolute - _ZIP64_LOCATOR.size, _ZIP64_LOCATOR.size)
            signature, record_disk, record_offset, volumes = _ZIP64_LOCATOR.unpack(locator)
            if signature != b"PK\x06\x07" or volumes != len(self.sizes):
                raise ArchiveError("Invalid ZIP64 locator or volume count")
            raw = self._read(record_disk, record_offset, _ZIP64_END.size)
            (
                signature,
                record_size,
                _,
                _,
                disk,
                cd_disk,
                disk_entries,
                entries,
                cd_size,
                cd_offset,
            ) = _ZIP64_END.unpack(raw)
            if signature != b"PK\x06\x06" or record_size < 44 or disk != final_disk:
                raise ArchiveError("Invalid ZIP64 end record")
            record_absolute = self._absolute(record_disk, record_offset)
            if record_absolute + 12 + record_size > eocd_absolute - _ZIP64_LOCATOR.size:
                raise ArchiveError("ZIP64 end record overlaps its locator")
            directory_end_limit = record_absolute
        else:
            directory_end_limit = eocd_absolute
        start = self._absolute(cd_disk, cd_offset)
        if (
            cd_size < 0
            or start + cd_size > directory_end_limit
            or entries > cd_size // _CENTRAL.size
        ):
            raise ArchiveError("Invalid central directory size or entry count")
        if disk_entries > entries:
            raise ArchiveError("Invalid per-volume central directory entry count")
        return CentralDirectory(cd_disk, cd_offset, cd_size, entries)

    def iter_entries(self, usernames: set[str] | None = None) -> Iterator[ZipEntry]:
        """Stream all headers; yield only exact username matches when supplied.

        A complete scan validates the reported count. Early generator termination
        deliberately does not claim validation of unread directory records.
        """
        cursor = _DirectoryCursor(self, self.directory)
        for _ in range(self.directory.entries):
            values = _CENTRAL.unpack(cursor.read(_CENTRAL.size))
            if values[0] != b"PK\x01\x02":
                raise ArchiveError("Invalid central directory member signature")
            flags, method, crc, compressed, uncompressed = (
                values[3],
                values[4],
                values[7],
                values[8],
                values[9],
            )
            name_size, extra_size, comment_size, disk, offset = (
                values[10],
                values[11],
                values[12],
                values[13],
                values[16],
            )
            name = _decode_name(cursor.read(name_size), flags)
            extra = cursor.read(extra_size)
            cursor.read(comment_size)
            specifications = (
                (8, uncompressed == _MAX32),
                (8, compressed == _MAX32),
                (8, offset == _MAX32),
                (4, disk == _MAX16),
            )
            extended = iter(_zip64_values(extra, specifications))
            uncompressed = next(extended) if uncompressed == _MAX32 else uncompressed
            compressed = next(extended) if compressed == _MAX32 else compressed
            offset = next(extended) if offset == _MAX32 else offset
            disk = next(extended) if disk == _MAX16 else disk
            self._absolute(disk, offset)
            if usernames is None or name.rsplit("/", 1)[-1].split("-", 1)[0] in usernames:
                _validate_path(name)
                yield ZipEntry(name, disk, offset, compressed, uncompressed, crc, method, flags)
        if cursor.available:
            raise ArchiveError(
                "Central directory has unexpected trailing records or count mismatch"
            )

    def extract(self, entry: ZipEntry) -> bytes:
        """Return a validated member. No filesystem extraction takes place here."""
        _validate_path(entry.filename)
        if entry.flags & (1 | 0x40):
            raise ArchiveError("Encrypted ZIP members are unsupported")
        if entry.method not in (0, 8):
            raise ArchiveError(f"Unsupported ZIP compression method: {entry.method}")
        if not 0 <= entry.uncompressed_size <= self.max_uncompressed_size:
            raise ArchiveError("ZIP member exceeds uncompressed size limit")
        if not 0 <= entry.compressed_size <= self.max_compressed_size:
            raise ArchiveError("ZIP member exceeds compressed size limit")
        if entry.method == 0 and entry.compressed_size != entry.uncompressed_size:
            raise ArchiveError("Stored ZIP member has inconsistent sizes")
        start = self._absolute(entry.disk, entry.offset)
        values = _LOCAL.unpack(self._read_absolute(start, _LOCAL.size))
        if values[0] != b"PK\x03\x04":
            raise ArchiveError("Invalid local file header signature")
        _, _, flags, method, _, _, crc, compressed, uncompressed, name_size, extra_size = values
        variable = self._read_absolute(start + _LOCAL.size, name_size + extra_size)
        name = _decode_name(variable[:name_size], flags)
        _validate_path(name)
        if name != entry.filename or flags != entry.flags or method != entry.method:
            raise ArchiveError("Local file header disagrees with central directory")
        extra = variable[name_size:]
        if not flags & 8:  # With a data descriptor, central directory values are authoritative.
            extended = iter(
                _zip64_values(extra, ((8, uncompressed == _MAX32), (8, compressed == _MAX32)))
            )
            uncompressed = next(extended) if uncompressed == _MAX32 else uncompressed
            compressed = next(extended) if compressed == _MAX32 else compressed
            if (crc, compressed, uncompressed) != (
                entry.crc32,
                entry.compressed_size,
                entry.uncompressed_size,
            ):
                raise ArchiveError("Local file CRC or sizes disagree with central directory")
        data_start = start + _LOCAL.size + name_size + extra_size
        if data_start + entry.compressed_size > self._starts[-1]:
            raise ArchiveError("Compressed member extends beyond archive")
        output = bytearray()
        decompressor = zlib.decompressobj(-15) if method == 8 else None
        consumed = 0
        crc_actual = 0
        while consumed < entry.compressed_size:
            count = min(self.chunk_size, entry.compressed_size - consumed)
            chunk = self._read_absolute(data_start + consumed, count)
            consumed += count
            try:
                plain = (
                    decompressor.decompress(chunk, entry.uncompressed_size - len(output) + 1)
                    if decompressor
                    else chunk
                )
            except zlib.error as exc:
                raise ArchiveError("Invalid deflate stream") from exc
            if len(output) + len(plain) > entry.uncompressed_size:
                raise ArchiveError("Expanded ZIP member exceeds declared size")
            if decompressor and (decompressor.unused_data or decompressor.unconsumed_tail):
                raise ArchiveError("Deflate stream has trailing data or exceeds its limit")
            output.extend(plain)
            crc_actual = zlib.crc32(plain, crc_actual)
        if decompressor and not decompressor.eof:
            raise ArchiveError("Truncated deflate stream")
        if len(output) != entry.uncompressed_size:
            raise ArchiveError("Extracted ZIP member size mismatch")
        if crc_actual & _MAX32 != entry.crc32:
            raise ArchiveError("Extracted ZIP member CRC mismatch")
        return bytes(output)
