#!/usr/bin/env python3
"""Capture and restore owned operational Compose rollback sources.

The helper intentionally reads only Docker labels, mount paths, image references
and container state. It never reads or prints container environment values.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import subprocess
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

EXPECTED_SERVICES = {
    "api",
    "web",
    "worker",
    "model-gateway",
    "model-gateway-db",
    "model-gateway-redis",
}
OWNER_LABEL = "ptr.operational.owner"
PROJECT_LABEL = "com.docker.compose.project"
SERVICE_LABEL = "com.docker.compose.service"
CONFIG_FILES_LABEL = "com.docker.compose.project.config_files"
WORKING_DIR_LABEL = "com.docker.compose.project.working_dir"
INSPECT_FORMAT = (
    '{"Id":{{json .Id}},"Name":{{json .Name}},"Image":{{json .Image}},'
    '"State":{{json .State}},"Config":{"Image":{{json .Config.Image}},'
    '"Labels":{{json .Config.Labels}}},"Mounts":{{json .Mounts}}}'
)
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
CONFIG_HASH_LABEL = "com.docker.compose.config-hash"
ENV_FILE_LABEL = "com.docker.compose.project.environment_file"
HASH_MISMATCH = (
    "captured files do not match the deployed config; check out the deployed revision and re-run"
)
DATA_MOUNT_TARGETS = {"/app/data", "/app/data/generated"}
CONFIG_MOUNT_TARGETS = {
    "/app/published-personas.private.json",
    "/app/ptr_routing.py",
    "/app/routing_state.py",
    "/app/routing_telemetry.py",
    "/app/persona_timeline_rag/gateway_budget.py",
    "/app/ptr-config.yaml",
}
DATA_TREE_NAMES = {"data"}


@dataclass(frozen=True)
class CapturedFile:
    source: Path
    snapshot: Path
    mode: int
    reason: str


@dataclass(frozen=True)
class CapturedLink:
    source: Path
    snapshot: Path
    target: str


def fail(message: str) -> None:
    raise ValueError(message)


def private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)


def create_missing_private_parents(path: Path) -> None:
    missing: list[Path] = []
    current = path
    while not current.exists():
        missing.append(current)
        parent = current.parent
        if parent == current:
            fail(f"cannot create restore parent: {path}")
        current = parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)


def copy_private_file(source: Path, destination: Path) -> None:
    private_dir(destination.parent)
    shutil.copyfile(source, destination, follow_symlinks=False)
    destination.chmod(0o600)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_private(path: Path, value: Any) -> None:
    private_dir(path.parent)
    temp = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    with temp.open("x", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
    temp.chmod(0o600)
    temp.replace(path)


def docker(args: list[str]) -> str:
    result = subprocess.run(
        ["docker", *args],
        check=True,
        text=True,
        capture_output=True,
        timeout=120,
    )
    return result.stdout


def docker_inspections(project: str) -> list[dict[str, Any]]:
    ids = [
        line.strip()
        for line in docker(
            ["ps", "--filter", f"label={PROJECT_LABEL}={project}", "--format", "{{.ID}}"]
        ).splitlines()
        if line.strip()
    ]
    if not ids:
        fail("no running containers found for project")
    inspections: list[dict[str, Any]] = []
    for container_id in ids:
        inspections.append(
            json.loads(docker(["inspect", container_id, "--format", INSPECT_FORMAT]))
        )
    return inspections


def labels(row: dict[str, Any]) -> dict[str, str]:
    config = row.get("Config")
    if not isinstance(config, dict):
        fail("inspect row missing Config labels")
    raw = config.get("Labels")
    if not isinstance(raw, dict):
        fail("inspect row missing labels")
    return {str(key): str(value) for key, value in raw.items()}


def ensure_private_output(output: Path) -> Path:
    if output.exists():
        fail("snapshot output already exists")
    output.mkdir(parents=True, mode=0o700)
    output.chmod(0o700)
    return output.resolve()


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def parse_config_files(value: str | None, working_dir: Path | None) -> list[Path]:
    if not value:
        return []
    paths: list[Path] = []
    for piece in value.split(","):
        raw = piece.strip()
        if not raw:
            continue
        path = Path(raw)
        if not path.is_absolute():
            if working_dir is None:
                fail("relative compose config file without working_dir label")
            path = working_dir / path
        paths.append(path)
    return paths


def assert_clean_checkouts(working_dirs: Iterable[Path]) -> None:
    for directory in working_dirs:
        try:
            root = subprocess.run(
                ["git", "-C", str(directory), "rev-parse", "--show-toplevel"],
                check=True,
                text=True,
                capture_output=True,
                timeout=10,
            ).stdout.strip()
        except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
            continue
        status = subprocess.run(
            ["git", "-C", root, "status", "--porcelain"],
            check=True,
            text=True,
            capture_output=True,
            timeout=20,
        )
        if status.stdout.strip():
            fail(
                "captured working directory has uncommitted changes; "
                "check out the deployed revision and re-run"
            )


def compose_hashes(
    project: str, env_file: Path, config_files: list[Path], working_dir: Path
) -> dict[str, str]:
    command = ["docker", "compose", "--env-file", str(env_file), "-p", project]
    for path in config_files:
        command.extend(["-f", str(path)])
    command.extend(["config", "--hash", "*"])
    result = subprocess.run(
        command, check=True, text=True, capture_output=True, timeout=120, cwd=working_dir
    )
    hashes: dict[str, str] = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) != 2 or not re.fullmatch(r"[0-9a-f]{64}", parts[1]) or parts[0] in hashes:
            fail(HASH_MISMATCH)
        hashes[parts[0]] = parts[1]
    return hashes


def snapshot_path_for(source: Path, root: Path) -> Path:
    if not source.is_absolute():
        source = source.resolve()
    return root / "root" / Path(*source.parts[1:])


def add_unique(paths: list[Path], path: Path) -> None:
    if path not in paths:
        paths.append(path)


def add_source(
    files: dict[Path, CapturedFile],
    directories: set[Path],
    links: dict[Path, CapturedLink],
    source: Path,
    snapshot_root: Path,
    reason: str,
    exclude_data: bool = False,
) -> None:
    if not source.exists():
        fail(f"source path does not exist: {source}")
    source = source.absolute()
    paths = [source]
    if stat.S_ISDIR(source.lstat().st_mode):
        paths.extend(sorted(source.rglob("*")))
    for path in paths:
        if exclude_data and any(part in DATA_TREE_NAMES for part in path.relative_to(source).parts):
            continue
        mode = path.lstat().st_mode
        if stat.S_ISDIR(mode):
            directories.add(path)
        elif stat.S_ISLNK(mode):
            links[path] = CapturedLink(
                path, snapshot_path_for(path, snapshot_root), os.readlink(path)
            )
        elif stat.S_ISREG(mode):
            files.setdefault(
                path,
                CapturedFile(
                    source=path,
                    snapshot=snapshot_path_for(path, snapshot_root),
                    mode=stat.S_IMODE(mode),
                    reason=reason,
                ),
            )
        else:
            fail(f"unsupported source type: {path}")


def validate_services(
    inspections: list[dict[str, Any]], project: str, owner: str
) -> dict[str, dict[str, Any]]:
    by_service: dict[str, dict[str, Any]] = {}
    for row in inspections:
        row_labels = labels(row)
        if row_labels.get(PROJECT_LABEL) != project:
            fail("container project label mismatch")
        if row_labels.get(OWNER_LABEL) != owner:
            fail("container owner label mismatch")
        service = row_labels.get(SERVICE_LABEL)
        if service not in EXPECTED_SERVICES:
            fail(f"unexpected service in project: {service}")
        if service in by_service:
            fail(f"duplicate service in project: {service}")
        state = row.get("State")
        if not isinstance(state, dict) or state.get("Running") is not True:
            fail(f"service is not running: {service}")
        by_service[service] = row
    missing = sorted(EXPECTED_SERVICES - set(by_service))
    if missing:
        fail("missing expected services: " + ", ".join(missing))
    return by_service


def mount_sources(row: dict[str, Any]) -> list[Path]:
    raw = row.get("Mounts")
    if not isinstance(raw, list):
        fail("inspect row missing mounts")
    paths: list[Path] = []
    for mount in raw:
        if not isinstance(mount, dict):
            continue
        if mount.get("Type") != "bind":
            continue
        target = mount.get("Destination")
        if target in DATA_MOUNT_TARGETS:
            continue
        if target not in CONFIG_MOUNT_TARGETS:
            fail(f"unclassified bind mount target: {target}")
        source = mount.get("Source")
        if isinstance(source, str) and source:
            paths.append(Path(source))
    return paths


def assert_output_outside_sources(output: Path, sources: Iterable[Path]) -> None:
    resolved_output = output.resolve()
    for source in sources:
        resolved_source = source.resolve()
        if resolved_output == resolved_source or is_relative_to(resolved_output, resolved_source):
            fail(f"snapshot output must not be inside captured source: {resolved_source}")


def write_rollback_images(snapshot_root: Path, services: list[dict[str, str]]) -> None:
    path = snapshot_root / "rollback-images.yml"
    lines = ["services:"]
    for row in sorted(services, key=lambda item: item["service"]):
        image = row["rollback_tag"]
        if not re.fullmatch(r"[a-z0-9_./:-]+", image):
            fail(f"invalid image tag for rollback override: {row['service']}")
        lines.extend([f"  {row['service']}:", f'    image: "{image}"'])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)


def save_images(snapshot_root: Path, image_ids: list[str]) -> None:
    private_dir(snapshot_root / "images")
    docker(
        [
            "image",
            "save",
            "-o",
            str(snapshot_root / "images" / "operational-images.tar"),
            *image_ids,
        ]
    )
    (snapshot_root / "images" / "operational-images.tar").chmod(0o600)


def tag_images(args: argparse.Namespace) -> int:
    manifest = read_json(args.snapshot.resolve() / "manifest.json")
    services = manifest.get("services")
    if not isinstance(services, list):
        fail("manifest missing services")
    tags: dict[str, str] = {}
    for row in services:
        if not isinstance(row, dict):
            fail("invalid service image entry")
        image_id = row.get("image")
        tag = row.get("rollback_tag")
        if not isinstance(image_id, str) or not IMAGE_ID.fullmatch(image_id):
            fail("invalid saved image ID")
        if not isinstance(tag, str) or not re.fullmatch(
            r"ptr-rollback/[a-z0-9_.-]+:[0-9a-f]{12}", tag
        ):
            fail("invalid saved image tag")
        if tag in tags and tags[tag] != image_id:
            fail("same image tag has conflicting saved IDs")
        tags[tag] = image_id
    for tag, image_id in tags.items():
        docker(["image", "tag", image_id, tag])
    print(f"tagged_images={len(tags)}")
    return 0


def capture(args: argparse.Namespace) -> int:
    inspections = (
        read_json(args.inspect_fixture)
        if args.inspect_fixture is not None
        else docker_inspections(args.project)
    )
    if not isinstance(inspections, list):
        fail("inspect fixture must be a JSON array")
    services = validate_services(inspections, args.project, args.owner)

    files: dict[Path, CapturedFile] = {}
    directories: set[Path] = set()
    links: dict[Path, CapturedLink] = {}
    output = args.output.resolve()
    working_dirs: list[Path] = []
    config_files: list[Path] = []
    mount_paths: list[Path] = []
    env_files: list[Path] = []
    if any(not path.is_absolute() for path in args.extra_path):
        fail("extra paths must be absolute")
    extra_paths = [path.absolute() for path in args.extra_path]
    for service, row in services.items():
        row_labels = labels(row)
        working_dir_raw = row_labels.get(WORKING_DIR_LABEL)
        if not working_dir_raw:
            fail(f"missing working_dir label: {service}")
        working_dir = Path(working_dir_raw).resolve()
        add_unique(working_dirs, working_dir)
        config_label = row_labels.get(CONFIG_FILES_LABEL)
        if not config_label:
            fail(f"missing config_files label: {service}")
        for config_file in parse_config_files(config_label, working_dir):
            add_unique(config_files, config_file.resolve())
        env_label = row_labels.get(ENV_FILE_LABEL)
        if not env_label:
            fail(f"missing environment_file label: {service}")
        env_path = Path(env_label)
        if not env_path.is_absolute():
            env_path = working_dir / env_path
        add_unique(env_files, env_path.resolve())
        for mount_path in mount_sources(row):
            mount_paths.append(mount_path)

    if len(working_dirs) != 1 or len(env_files) != 1:
        fail("services disagree on Compose working directory or environment file")
    assert_clean_checkouts(working_dirs)
    hashes = compose_hashes(args.project, env_files[0], config_files, working_dirs[0])
    if set(hashes) != set(services) or any(
        hashes[service] != labels(row).get(CONFIG_HASH_LABEL) for service, row in services.items()
    ):
        fail(HASH_MISMATCH)

    assert_output_outside_sources(
        output, [*working_dirs, *config_files, *mount_paths, *extra_paths]
    )
    for working_dir in working_dirs:
        add_source(files, directories, links, working_dir, output, "working_dir", exclude_data=True)
    for config_file in config_files:
        add_source(files, directories, links, config_file, output, "compose_config")
    for service, row in services.items():
        for mount_path in mount_sources(row):
            add_source(files, directories, links, mount_path, output, f"mount:{service}")
    for extra_path in extra_paths:
        add_source(files, directories, links, extra_path, output, "extra_path")
    output = ensure_private_output(args.output)
    for directory in sorted(directories, key=lambda path: (len(path.parts), str(path))):
        private_dir(snapshot_path_for(directory, output))
    for captured in files.values():
        copy_private_file(captured.source, captured.snapshot)
    for link in links.values():
        private_dir(link.snapshot.parent)
        link.snapshot.symlink_to(link.target)

    script_source = Path(__file__).resolve()
    copy_private_file(script_source, output / "tools" / "operational-snapshot.py")

    service_rows = []
    image_ids: list[str] = []
    for service in sorted(services):
        row = services[service]
        config = row.get("Config")
        if not isinstance(config, dict):
            fail("inspect row missing Config")
        image_id = str(row.get("Image") or "")
        image_ref = str(config.get("Image") or "")
        if not IMAGE_ID.fullmatch(image_id):
            fail(f"service missing image id: {service}")
        if not image_ref:
            fail(f"service missing Config.Image: {service}")
        image_ids.append(image_id)
        service_rows.append(
            {
                "service": service,
                "id": str(row.get("Id") or ""),
                "name": str(row.get("Name") or ""),
                "image": image_id,
                "config_image": image_ref,
                "rollback_tag": f"ptr-rollback/{args.project}-{service}:{image_id[7:19]}",
                "config_hash": hashes[service],
            }
        )

    write_rollback_images(output, service_rows)
    if not args.inspect_fixture:
        save_images(output, sorted(set(image_ids)))

    manifest = {
        "schema": 1,
        "project": args.project,
        "owner_label": OWNER_LABEL,
        "owner": args.owner,
        "expected_services": sorted(EXPECTED_SERVICES),
        "services": service_rows,
        "working_dirs": [str(path) for path in working_dirs],
        "compose_config_files": [str(path) for path in config_files],
        "compose_env_file": str(env_files[0]),
        "extra_paths": [str(path) for path in extra_paths],
        "directories": [
            {"source": str(path), "mode": oct(stat.S_IMODE(path.lstat().st_mode))}
            for path in sorted(directories)
        ],
        "links": [
            {
                "source": str(item.source),
                "snapshot": str(item.snapshot.relative_to(output)),
                "target": item.target,
            }
            for item in sorted(links.values(), key=lambda item: str(item.source))
        ],
        "files": [
            {
                "source": str(item.source),
                "snapshot": str(item.snapshot.relative_to(output)),
                "mode": oct(item.mode),
                "reason": item.reason,
            }
            for item in sorted(files.values(), key=lambda item: str(item.source))
        ],
    }
    write_json_private(output / "manifest.json", manifest)
    (output / "image-ids.txt").write_text(
        "\n".join(sorted(set(image_ids))) + "\n", encoding="utf-8"
    )
    (output / "image-ids.txt").chmod(0o600)
    print(f"snapshot={output}")
    print(f"manifest={output / 'manifest.json'}")
    print(f"files={len(files)}")
    print(f"services={','.join(sorted(services))}")
    print(f"image_ids={len(set(image_ids))}")
    return 0


def restore(args: argparse.Namespace) -> int:
    if args.apply == args.dry_run:
        fail("restore requires exactly one of --dry-run or --apply")
    snapshot = args.snapshot.resolve()
    manifest = read_json(snapshot / "manifest.json")
    files = manifest.get("files")
    directories = manifest.get("directories")
    links = manifest.get("links")
    if (
        not isinstance(files, list)
        or not isinstance(directories, list)
        or not isinstance(links, list)
    ):
        fail("manifest missing source entries")
    if any(
        not isinstance(row, dict) or not isinstance(row.get("source"), str) for row in directories
    ):
        fail("invalid directory manifest entry")
    for row in sorted(
        directories, key=lambda value: (len(Path(value["source"]).parts), value["source"])
    ):
        directory = Path(str(row.get("source") or ""))
        if not directory.is_absolute() or not snapshot_path_for(directory, snapshot).is_dir():
            fail(f"snapshot directory missing: {directory}")
        if args.apply and not directory.exists():
            create_missing_private_parents(directory)
            directory.chmod(int(str(row.get("mode") or "0o700"), 8))
    restored = 0
    for row in files:
        if not isinstance(row, dict):
            fail("invalid file manifest entry")
        source = Path(str(row.get("source") or ""))
        rel = Path(str(row.get("snapshot") or ""))
        if rel.is_absolute() or ".." in rel.parts:
            fail("invalid snapshot relative path")
        captured = snapshot / rel
        if not source.is_absolute():
            fail("restore source path must be absolute")
        if not captured.is_file():
            fail(f"snapshot file missing: {rel}")
        mode = int(str(row.get("mode") or "0o600"), 8)
        print(f"restore {captured.relative_to(snapshot)} -> {source}")
        if args.apply:
            create_missing_private_parents(source.parent)
            if source.is_symlink():
                source.unlink()
            shutil.copyfile(captured, source)
            source.chmod(mode)
        restored += 1
    for row in links:
        if not isinstance(row, dict):
            fail("invalid link manifest entry")
        source = Path(str(row.get("source") or ""))
        rel = Path(str(row.get("snapshot") or ""))
        target = row.get("target")
        if (
            not source.is_absolute()
            or rel.is_absolute()
            or ".." in rel.parts
            or not isinstance(target, str)
        ):
            fail("invalid link manifest path")
        captured = snapshot / rel
        if not captured.is_symlink() or os.readlink(captured) != target:
            fail(f"snapshot link missing: {rel}")
        print(f"restore {rel} -> {source}")
        if args.apply:
            create_missing_private_parents(source.parent)
            if source.is_symlink() or source.is_file():
                source.unlink()
            if source.exists():
                fail(f"restore link target is a directory: {source}")
            source.symlink_to(target)
        restored += 1
    print(f"restored={restored}" if args.apply else f"would_restore={restored}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    capture_parser = sub.add_parser("capture")
    capture_parser.add_argument("--project", required=True)
    capture_parser.add_argument("--owner", required=True)
    capture_parser.add_argument("--output", required=True, type=Path)
    capture_parser.add_argument("--inspect-fixture", type=Path)
    capture_parser.add_argument("--extra-path", action="append", default=[], type=Path)
    capture_parser.set_defaults(func=capture)
    restore_parser = sub.add_parser("restore")
    restore_parser.add_argument("--snapshot", required=True, type=Path)
    restore_parser.add_argument("--dry-run", action="store_true")
    restore_parser.add_argument("--apply", action="store_true")
    restore_parser.set_defaults(func=restore)
    tag_parser = sub.add_parser("tag-images")
    tag_parser.add_argument("--snapshot", required=True, type=Path)
    tag_parser.set_defaults(func=tag_images)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        return args.func(args)
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as exc:
        parser.exit(1, f"operational snapshot failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
