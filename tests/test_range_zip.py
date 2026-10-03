"""Offline split-ZIP fixtures; no Drive access or real dataset is required."""

import io
import struct
import unittest
import zipfile
import zlib
from dataclasses import replace

from persona_timeline_rag.datasets.range_zip import ArchiveError, SplitZipArchive


class MemoryReader:
    def __init__(self, volumes):
        self.volumes = volumes
        self.calls = []

    def read(self, disk, offset, size):
        self.calls.append((disk, offset, size))
        return self.volumes[disk][offset : offset + size]


def fixture(members, *, cuts=(), zip64=False, descriptor=False, comment=b""):
    """Build archive offsets using real per-disk (not concatenated) semantics."""
    starts = (0, *cuts)

    def location(absolute):
        disk = max(i for i, start in enumerate(starts) if start <= absolute)
        return disk, absolute - starts[disk]

    blob = bytearray()
    entries = []
    for name, data, method in members:
        raw_name = name.encode("utf-8")
        flags = 0x800 | (8 if descriptor else 0)
        if method == 8:
            compressor = zlib.compressobj(wbits=-15)
            payload = compressor.compress(data) + compressor.flush()
        else:
            payload = data
        crc = zlib.crc32(data) & 0xFFFFFFFF
        offset = len(blob)
        extra = struct.pack("<HHQQ", 1, 16, len(data), len(payload)) if zip64 else b""
        compressed = uncompressed = 0xFFFFFFFF if zip64 else 0
        if not zip64:
            compressed, uncompressed = len(payload), len(data)
        blob.extend(
            struct.pack(
                "<4s5H3L2H",
                b"PK\x03\x04",
                45 if zip64 else 20,
                flags,
                method,
                0,
                0,
                0 if descriptor else crc,
                0 if descriptor else compressed,
                0 if descriptor else uncompressed,
                len(raw_name),
                len(extra),
            )
        )
        blob.extend(raw_name + extra)
        data_start = len(blob)
        blob.extend(payload)
        if descriptor:
            blob.extend(struct.pack("<4s3L", b"PK\x07\x08", crc, len(payload), len(data)))
        entries.append((raw_name, flags, method, crc, len(payload), len(data), offset, data_start))

    cd_start = len(blob)
    central_positions = []
    for name, flags, method, crc, compressed, uncompressed, offset, _ in entries:
        disk, local_offset = location(offset)
        extra = (
            struct.pack("<HHQQQL", 1, 28, uncompressed, compressed, local_offset, disk)
            if zip64
            else b""
        )
        central_positions.append(len(blob))
        blob.extend(
            struct.pack(
                "<4s6H3L5H2L",
                b"PK\x01\x02",
                45 if zip64 else 20,
                45 if zip64 else 20,
                flags,
                method,
                0,
                0,
                crc,
                0xFFFFFFFF if zip64 else compressed,
                0xFFFFFFFF if zip64 else uncompressed,
                len(name),
                len(extra),
                0,
                0xFFFF if zip64 else disk,
                0,
                0,
                0xFFFFFFFF if zip64 else local_offset,
            )
        )
        blob.extend(name + extra)
    cd_size = len(blob) - cd_start
    cd_disk, cd_offset = location(cd_start)
    final_disk = len(cuts)
    disk_entries = sum(location(pos)[0] == final_disk for pos in central_positions)
    if zip64:
        record_disk, record_offset = location(len(blob))
        blob.extend(
            struct.pack(
                "<4sQ2H2L4Q",
                b"PK\x06\x06",
                44,
                45,
                45,
                final_disk,
                cd_disk,
                disk_entries,
                len(entries),
                cd_size,
                cd_offset,
            )
        )
        blob.extend(struct.pack("<4sLQL", b"PK\x06\x07", record_disk, record_offset, len(cuts) + 1))
    blob.extend(
        struct.pack(
            "<4s4H2LH",
            b"PK\x05\x06",
            final_disk,
            cd_disk,
            0xFFFF if zip64 else disk_entries,
            0xFFFF if zip64 else len(entries),
            cd_size,
            cd_offset,
            len(comment),
        )
    )
    blob.extend(comment)
    if cuts and cuts[-1] >= len(blob) - 22 - len(comment) - (76 if zip64 else 0):
        raise ValueError("Fixture cuts must leave end records on the final disk")
    boundaries = (0, *cuts, len(blob))
    volumes = [bytes(blob[a:b]) for a, b in zip(boundaries, boundaries[1:])]
    return volumes, {
        "entries": entries,
        "central_positions": central_positions,
        "cd_start": cd_start,
    }


class SplitZipTests(unittest.TestCase):
    def archive(self, volumes, **kwargs):
        reader = MemoryReader(volumes)
        archive = SplitZipArchive(reader, list(map(len, volumes)), **kwargs)
        return archive, reader

    def test_regular_zip_matches_stdlib(self):
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as out:
            out.writestr("info/alice-1.info", b"first", compress_type=zipfile.ZIP_STORED)
            out.writestr("info/alice-2.info", b"hello" * 100, compress_type=zipfile.ZIP_DEFLATED)
            out.writestr("image/bob-3.jpg", b"jpeg", compress_type=zipfile.ZIP_DEFLATED)
        archive, _ = self.archive([stream.getvalue()], chunk_size=19)
        with zipfile.ZipFile(stream) as original:
            for entry in archive.iter_entries():
                self.assertEqual(archive.extract(entry), original.read(entry.filename))

    def test_exact_username_filter(self):
        volumes, _ = fixture(
            [
                ("info/alice-1.info", b"a", 0),
                ("info/alicesmith-2.info", b"b", 0),
                ("image/alice-3.jpg", b"c", 0),
                ("info/bob-4.info", b"d", 0),
            ]
        )
        archive, _ = self.archive(volumes, chunk_size=23)
        self.assertEqual(
            [entry.filename for entry in archive.iter_entries({"alice"})],
            ["info/alice-1.info", "image/alice-3.jpg"],
        )
        self.assertEqual(list(archive.iter_entries(set())), [])

    def test_split_headers_data_and_directory_across_volumes(self):
        data = bytes(range(256)) * 2
        volumes, _ = fixture(
            [("image/alice-1.jpg", data, 0), ("info/bob-2.info", b"other" * 100, 8)],
            cuts=(17, 70, 220, 640, 715),
        )
        archive, reader = self.archive(volumes, chunk_size=31)
        entries = list(archive.iter_entries())
        self.assertLess(archive.directory.disk, len(volumes) - 1)
        self.assertEqual(archive.extract(entries[0]), data)
        self.assertEqual(archive.extract(entries[1]), b"other" * 100)
        self.assertTrue(
            all(offset + size <= len(volumes[disk]) for disk, offset, size in reader.calls)
        )

    def test_zip64_disk_relative_offsets_and_sizes(self):
        data = bytes(range(200)) * 2
        volumes, _ = fixture(
            [("info/alice-1.info", data, 0), ("info/bob-2.info", b"text" * 100, 8)],
            cuts=(31, 130, 420, 630),
            zip64=True,
        )
        archive, _ = self.archive(volumes, chunk_size=37)
        entries = list(archive.iter_entries({"bob"}))
        self.assertEqual(len(entries), 1)
        self.assertGreater(entries[0].disk, 0)
        self.assertEqual(archive.extract(entries[0]), b"text" * 100)

    def test_data_descriptor(self):
        volumes, _ = fixture([("info/alice-1.info", b"x" * 400, 8)], descriptor=True)
        archive, _ = self.archive(volumes, chunk_size=3)
        self.assertEqual(archive.extract(next(archive.iter_entries())), b"x" * 400)

    def test_comment_with_false_end_signature(self):
        volumes, _ = fixture([("info/alice-1.info", b"a", 0)], comment=b"PK\x05\x06" + b"x" * 30)
        archive, _ = self.archive(volumes)
        self.assertEqual(len(list(archive.iter_entries())), 1)

    def test_empty_zip(self):
        volumes, _ = fixture([])
        archive, _ = self.archive(volumes)
        self.assertEqual(list(archive.iter_entries()), [])

    def test_directory_is_chunked_not_requested_per_entry(self):
        volumes, _ = fixture([(f"info/alice-{i}.info", b"hello", 0) for i in range(300)])
        archive, reader = self.archive(volumes, chunk_size=1024)
        reader.calls.clear()
        self.assertEqual(len(list(archive.iter_entries())), 300)
        self.assertLess(len(reader.calls), 30)
        self.assertTrue(all(size <= 1024 for _, _, size in reader.calls))

    def test_crc_mismatch(self):
        volumes, positions = fixture([("info/alice-1.info", b"abc", 0)])
        damaged = bytearray(volumes[0])
        damaged[positions["entries"][0][-1]] ^= 1
        archive, _ = self.archive([bytes(damaged)])
        with self.assertRaisesRegex(ArchiveError, "CRC mismatch"):
            archive.extract(next(archive.iter_entries()))

    def test_truncated_range_reader(self):
        volumes, _ = fixture([("info/alice-1.info", b"abc", 0)])

        class ShortReader(MemoryReader):
            def read(self, disk, offset, size):
                return super().read(disk, offset, size)[:-1]

        with self.assertRaisesRegex(ArchiveError, "Short range"):
            SplitZipArchive(ShortReader(volumes), list(map(len, volumes)))

    def test_truncated_archive(self):
        volumes, _ = fixture([("info/alice-1.info", b"abc", 0)])
        with self.assertRaises(ArchiveError):
            self.archive([volumes[0][:-10]])

    def test_unsafe_paths(self):
        for name in [
            "../alice-1.info",
            "/info/alice-1.info",
            "info/../alice-1.info",
            "info\\alice-1.info",
            "C:/alice-1.info",
            ".",
            "info/alice\x00-1.info",
        ]:
            with self.subTest(name=name):
                volumes, _ = fixture([(name, b"abc", 0)])
                archive, _ = self.archive(volumes)
                with self.assertRaisesRegex(ArchiveError, "Unsafe"):
                    list(archive.iter_entries())

    def test_local_filename_mismatch(self):
        volumes, _ = fixture([("info/alice-1.info", b"abc", 0)])
        damaged = bytearray(volumes[0])
        damaged[30 : 30 + len(b"info/alixe-1.info")] = b"info/alixe-1.info"
        archive, _ = self.archive([bytes(damaged)])
        with self.assertRaisesRegex(ArchiveError, "disagrees"):
            archive.extract(next(archive.iter_entries()))

    def test_header_crc_mismatch(self):
        volumes, _ = fixture([("info/alice-1.info", b"abc", 0)])
        damaged = bytearray(volumes[0])
        struct.pack_into("<L", damaged, 14, 0)
        archive, _ = self.archive([bytes(damaged)])
        with self.assertRaisesRegex(ArchiveError, "CRC or sizes"):
            archive.extract(next(archive.iter_entries()))

    def test_size_limits(self):
        volumes, _ = fixture([("info/alice-1.info", b"x" * 100, 8)])
        archive, _ = self.archive(volumes, max_uncompressed_size=10)
        with self.assertRaisesRegex(ArchiveError, "uncompressed size limit"):
            archive.extract(next(archive.iter_entries()))
        archive, _ = self.archive(volumes, max_compressed_size=1)
        with self.assertRaisesRegex(ArchiveError, "compressed size limit"):
            archive.extract(next(archive.iter_entries()))

    def test_deflate_declared_size_limit(self):
        volumes, _ = fixture([("info/alice-1.info", b"x" * 10000, 8)], descriptor=True)
        archive, _ = self.archive(volumes)
        entry = replace(next(archive.iter_entries()), uncompressed_size=1)
        with self.assertRaisesRegex(ArchiveError, "exceeds declared size"):
            archive.extract(entry)

    def test_truncated_deflate_stream(self):
        volumes, _ = fixture([("info/alice-1.info", b"abcdef" * 100, 8)], descriptor=True)
        archive, _ = self.archive(volumes)
        entry = next(archive.iter_entries())
        with self.assertRaises(ArchiveError):
            archive.extract(replace(entry, compressed_size=entry.compressed_size - 1))

    def test_encryption_and_unsupported_compression(self):
        volumes, _ = fixture([("info/alice-1.info", b"abc", 0)])
        archive, _ = self.archive(volumes)
        entry = next(archive.iter_entries())
        with self.assertRaisesRegex(ArchiveError, "Encrypted"):
            archive.extract(replace(entry, flags=entry.flags | 1))
        with self.assertRaisesRegex(ArchiveError, "Unsupported"):
            archive.extract(replace(entry, method=99))

    def test_invalid_central_header(self):
        volumes, positions = fixture([("info/alice-1.info", b"abc", 0)])
        damaged = bytearray(volumes[0])
        damaged[positions["cd_start"] : positions["cd_start"] + 4] = b"BAD!"
        archive, _ = self.archive([bytes(damaged)])
        with self.assertRaisesRegex(ArchiveError, "central directory member signature"):
            list(archive.iter_entries())

    def test_missing_zip64_extra(self):
        volumes, positions = fixture([("info/alice-1.info", b"abc", 0)], zip64=True)
        damaged = bytearray(volumes[0])
        extra_start = positions["cd_start"] + 46 + len("info/alice-1.info")
        struct.pack_into("<H", damaged, extra_start, 2)
        archive, _ = self.archive([bytes(damaged)])
        with self.assertRaisesRegex(ArchiveError, "ZIP64 extra"):
            list(archive.iter_entries())

    def test_wrong_volume_count(self):
        volumes, _ = fixture([("info/alice-1.info", b"abc", 0)], cuts=(40,), zip64=True)
        damaged = bytearray(volumes[-1])
        locator = damaged.rfind(b"PK\x06\x07")
        struct.pack_into("<L", damaged, locator + 16, 99)
        with self.assertRaisesRegex(ArchiveError, "volume count"):
            self.archive([volumes[0], bytes(damaged)])

    def test_entry_count_mismatch(self):
        volumes, _ = fixture([("info/alice-1.info", b"abc", 0), ("info/bob-2.info", b"x", 0)])
        damaged = bytearray(volumes[0])
        end = damaged.rfind(b"PK\x05\x06")
        struct.pack_into("<HH", damaged, end + 8, 1, 1)
        archive, _ = self.archive([bytes(damaged)])
        with self.assertRaisesRegex(ArchiveError, "count mismatch"):
            list(archive.iter_entries())

    def test_bad_parameters(self):
        for sizes in [[], [0], [-1], ["10"]]:
            with self.subTest(sizes=sizes), self.assertRaises(ArchiveError):
                SplitZipArchive(MemoryReader([]), sizes)


if __name__ == "__main__":
    unittest.main()
