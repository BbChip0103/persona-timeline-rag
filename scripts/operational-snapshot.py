#!/usr/bin/env python3
"""Capture and restore owned operational Compose rollback sources.

The helper intentionally reads only Docker labels, mount paths, image references
and container state. It never reads or prints container environment values.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Historical pre-L2 Compose service names are required to capture and restore
# the deployed rollback snapshot; current deployments never start these roles.
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
    # Required when restoring a pre-L2 deployment from its saved image.
    "/app/persona_timeline_rag/gateway_budget.py",
    "/app/ptr-config.yaml",
}
EXCLUDED_TREE_NAMES = {"node_modules", ".venv", "__pycache__", ".next", "dist", "build"}
MIN_COMPOSE_VERSION = (5, 0, 0)


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


def sha256_file(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


def replace_file_atomically(captured: Path, source: Path, mode: int) -> None:
    create_missing_private_parents(source.parent)
    temporary: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=source.parent, prefix=".ptr-restore-", delete=False) as output:
            temporary = Path(output.name)
            with captured.open("rb") as input_file:
                shutil.copyfileobj(input_file, output)
            os.fchmod(output.fileno(), mode)
        os.replace(temporary, source)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def docker(args: list[str]) -> str:
    result = subprocess.run(
        ["docker", *args],
        check=True,
        text=True,
        capture_output=True,
        timeout=120,
    )
    return result.stdout


def require_supported_compose() -> None:
    version = docker(["compose", "version", "--short"]).strip()
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", version)
    if match is None or tuple(map(int, match.groups())) < MIN_COMPOSE_VERSION:
        fail("Docker Compose v5.0.0 or later is required to preserve env_file references")


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


def checkout_states(working_dirs: Iterable[Path]) -> dict[Path, str]:
    states: dict[Path, str] = {}
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
            states[directory] = "none"
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
        revision = subprocess.run(
            ["git", "-C", root, "rev-parse", "HEAD"],
            check=True, text=True, capture_output=True, timeout=10,
        ).stdout.strip()
        states[directory] = f"clean@{revision}"
    return states


def rollback_groups(
    groups: dict[tuple[Path, tuple[Path, ...], Path], list[str]],
) -> list[tuple[tuple[Path, tuple[Path, ...], Path], list[str]]]:
    primary = {"api", "model-gateway-db", "model-gateway-redis"}
    ordered = sorted(groups.items(), key=lambda item: (str(item[0][0]), sorted(item[1])))
    first = [item for item in ordered if primary <= set(item[1])]
    if len(first) != 1:
        fail("rollback requires api and gateway db/redis in one Compose group")
    return first + [item for item in ordered if item is not first[0]]


def compose_hashes(
    project: str, env_file: Path, config_files: list[Path], working_dir: Path,
    services: list[str],
) -> dict[str, str]:
    command = ["docker", "compose", "--env-file", str(env_file), "-p", project]
    for path in config_files:
        command.extend(["-f", str(path)])
    command.extend(["config", "--hash", ",".join(services)])
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


def compose_file_references(
    project: str, env_file: Path, config_files: list[Path], working_dir: Path,
    expected_services: list[str],
) -> list[Path]:
    """Read resolved file paths only; never log Compose's expanded JSON or environment."""
    command = ["docker", "compose", "--env-file", str(env_file), "-p", project]
    for path in config_files:
        command.extend(["-f", str(path)])
    command.extend(["config", "--format", "json", "--no-env-resolution"])
    result = subprocess.run(
        command, check=True, text=True, capture_output=True, timeout=120, cwd=working_dir
    )
    config = json.loads(result.stdout)
    if not isinstance(config, dict):
        fail("invalid Compose config structure")
    paths: list[Path] = []
    services = config.get("services") or {}
    definitions = config.get("configs") or {}
    if not isinstance(services, dict) or not isinstance(definitions, dict):
        fail("invalid Compose file references")
    if not services:
        fail("Compose config missing services and env_file references")
    missing_services = set(expected_services) - services.keys()
    if missing_services:
        fail(f"Compose config missing deployed services: {', '.join(sorted(missing_services))}")
    for service_name, service in services.items():
        if not isinstance(service, dict):
            fail("invalid Compose service")
        env_files = service.get("env_file")
        if not isinstance(env_files, list) or not env_files:
            fail(f"Compose config missing env_file references for service: {service_name}")
        for entry in env_files:
            raw = entry if isinstance(entry, str) else entry.get("path") if isinstance(entry, dict) else None
            if not isinstance(raw, str):
                fail("invalid Compose env_file reference")
            path = resolve_compose_reference(raw, config_files, working_dir)
            if path.exists():
                add_unique(paths, path)
            elif not isinstance(entry, dict) or entry.get("required", True):
                fail(f"required Compose env_file is missing: {path}")
    for definition in definitions.values():
        if not isinstance(definition, dict):
            fail("invalid Compose config definition")
        raw = definition.get("file")
        if isinstance(raw, str):
            add_unique(paths, resolve_compose_reference(raw, config_files, working_dir))
    return paths


def resolve_compose_reference(raw: str, config_files: list[Path], working_dir: Path) -> Path:
    path = Path(raw)
    if path.is_absolute():
        return path.resolve()
    return (config_files[0].parent / path).resolve() if config_files else (working_dir / path).resolve()


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
) -> None:
    if any(part in EXCLUDED_TREE_NAMES for part in source.parts):
        fail(f"required source is inside an excluded generated tree: {source}")
    if not source.exists():
        fail(f"source path does not exist: {source}")
    source = source.absolute()
    paths: list[Path] = []
    def visit(path: Path) -> None:
        if path.name in EXCLUDED_TREE_NAMES:
            return
        paths.append(path)
        if stat.S_ISDIR(path.lstat().st_mode):
            for child in sorted(path.iterdir()):
                visit(child)
    visit(source)
    for path in paths:
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


def data_mounts(services: dict[str, dict[str, Any]]) -> list[dict[str, str]]:
    mounts: list[dict[str, str]] = []
    for service, row in sorted(services.items()):
        if service not in {"api", "worker"}:
            continue
        for mount in row.get("Mounts", []):
            if not isinstance(mount, dict) or mount.get("Type") != "bind":
                continue
            target = mount.get("Destination")
            source = mount.get("Source")
            if not isinstance(source, str) or not Path(source).is_absolute():
                fail("operational bind source must be absolute")
            mounts.append({"service": service, "target": target, "source": source})
    return mounts


def snapshot_data_mounts(snapshot: Path) -> list[dict[str, str]]:
    manifest = read_json(snapshot / "manifest.json")
    mounts = manifest.get("data_mounts") if isinstance(manifest, dict) else None
    if not isinstance(mounts, list) or not mounts:
        fail("snapshot has no recorded data mounts")
    if any(
        not isinstance(row, dict)
        or not all(isinstance(row.get(key), str) for key in ("service", "target", "source"))
        or row["service"] not in {"api", "worker"}
        or not row["target"].startswith("/app/")
        or not Path(row["source"]).is_absolute()
        for row in mounts
    ):
        fail("invalid snapshot data mounts")
    return mounts


def data_dir(args: argparse.Namespace) -> int:
    mounts = snapshot_data_mounts(args.snapshot)
    generated = [row["source"] for row in mounts
                 if row["service"] == "api" and row["target"] == "/app/data/generated"]
    if len(generated) != 1 or Path(generated[0]).name != "generated":
        fail("snapshot must have one API /app/data/generated bind source")
    print(Path(generated[0]).parent)
    return 0


def check_data_mounts(args: argparse.Namespace) -> int:
    expected = snapshot_data_mounts(args.snapshot)
    rendered = (
        json.load(sys.stdin)
        if args.rendered_config == Path("-")
        else read_json(args.rendered_config)
    )
    services = rendered.get("services") if isinstance(rendered, dict) else None
    if not isinstance(services, dict):
        fail("rendered Compose config missing services")
    actual: list[tuple[str, str, str]] = []
    for service, config in services.items():
        if not isinstance(config, dict):
            continue
        volumes = config.get("volumes", [])
        if not isinstance(volumes, list):
            fail("rendered Compose volumes must be a list")
        for mount in volumes:
            if service not in {"api", "worker"}:
                continue
            if not isinstance(mount, dict) or mount.get("type") != "bind":
                fail("unexpected API or worker mount type")
            if not isinstance(mount.get("source"), str) or not isinstance(mount.get("target"), str):
                fail("rendered operational bind source or target missing")
            bind = mount.get("bind")
            if not isinstance(bind, dict) or bind.get("create_host_path") is not False:
                fail("rendered operational bind must set create_host_path: false")
            actual.append((service, mount["target"], mount["source"]))
    expected_sources = [(row["service"], row["target"], row["source"]) for row in expected]
    if sorted(actual) != sorted(expected_sources):
        fail("rendered data bind sources differ from snapshot")
    print("data_mounts_match=true")
    return 0


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
    output = args.output.resolve()
    if output == Path("/tmp") or Path("/tmp") in output.parents:
        fail("snapshot output must be on persistent storage, outside /tmp")
    inspections = (
        read_json(args.inspect_fixture)
        if args.inspect_fixture is not None
        else docker_inspections(args.project)
    )
    if not isinstance(inspections, list):
        fail("inspect fixture must be a JSON array")
    services = validate_services(inspections, args.project, args.owner)
    require_supported_compose()

    files: dict[Path, CapturedFile] = {}
    directories: set[Path] = set()
    links: dict[Path, CapturedLink] = {}
    working_dirs: list[Path] = []
    config_files: list[Path] = []
    mount_paths: list[Path] = []
    env_files: list[Path] = []
    referenced_files: list[Path] = []
    groups: dict[tuple[Path, tuple[Path, ...], Path], list[str]] = {}
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
        service_configs = tuple(
            path.resolve() for path in parse_config_files(config_label, working_dir)
        )
        if not service_configs:
            fail(f"empty config_files label: {service}")
        for config_file in service_configs:
            add_unique(config_files, config_file)
        env_label = row_labels.get(ENV_FILE_LABEL)
        if not env_label:
            fail(f"missing environment_file label: {service}")
        env_path = Path(env_label)
        if not env_path.is_absolute():
            env_path = working_dir / env_path
        env_path = env_path.resolve()
        add_unique(env_files, env_path)
        groups.setdefault((working_dir, service_configs, env_path), []).append(service)
        for mount_path in mount_sources(row):
            mount_paths.append(mount_path)

    git_states = checkout_states(working_dirs)
    ordered_groups = rollback_groups(groups)
    hashes: dict[str, str] = {}
    for (working_dir, service_configs, env_path), group_services in groups.items():
        expected = sorted(group_services)
        group_hashes = compose_hashes(
            args.project, env_path, list(service_configs), working_dir, expected
        )
        if set(group_hashes) != set(expected) or any(
            group_hashes[service] != labels(services[service]).get(CONFIG_HASH_LABEL)
            for service in expected
        ):
            fail(HASH_MISMATCH)
        hashes.update(group_hashes)
        for path in compose_file_references(
            args.project, env_path, list(service_configs), working_dir, expected
        ):
            add_unique(referenced_files, path)

    assert_output_outside_sources(
        output, [*working_dirs, *config_files, *env_files, *referenced_files, *mount_paths]
    )
    for config_file in config_files:
        add_source(files, directories, links, config_file, output, "compose_config")
    for env_file in env_files:
        add_source(files, directories, links, env_file, output, "compose_env")
    for reference in referenced_files:
        add_source(files, directories, links, reference, output, "compose_reference")
    for service, row in services.items():
        for mount_path in mount_sources(row):
            add_source(files, directories, links, mount_path, output, f"mount:{service}")
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
        "schema": 2,
        "project": args.project,
        "owner_label": OWNER_LABEL,
        "owner": args.owner,
        "expected_services": sorted(EXPECTED_SERVICES),
        "services": service_rows,
        "data_mounts": data_mounts(services),
        "working_dirs": [str(path) for path in working_dirs],
        "compose_config_files": [str(path) for path in config_files],
        "compose_groups": [
            {
                "working_dir": str(working_dir),
                "compose_config_files": [str(path) for path in service_configs],
                "compose_env_file": str(env_path),
                "services": sorted(group_services),
            }
            for (working_dir, service_configs, env_path), group_services in ordered_groups
        ],
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
    if len(groups) == 1:
        manifest["compose_env_file"] = str(env_files[0])
    for group in manifest["compose_groups"]:
        group["git"] = git_states[Path(group["working_dir"])]
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
    print("rollback_order=" + " | ".join(
        ",".join(sorted(group_services)) for _, group_services in ordered_groups
    ))
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
    directories_created = 0
    for row in sorted(
        directories, key=lambda value: (len(Path(value["source"]).parts), value["source"])
    ):
        directory = Path(str(row.get("source") or ""))
        if not directory.is_absolute() or not snapshot_path_for(directory, snapshot).is_dir():
            fail(f"snapshot directory missing: {directory}")
        if args.apply and not directory.exists():
            create_missing_private_parents(directory)
            directory.chmod(int(str(row.get("mode") or "0o700"), 8))
            directories_created += 1
    restored = 0
    skipped_files = 0
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
        if source.is_file() and not source.is_symlink() and sha256_file(source) == sha256_file(captured):
            skipped_files += 1
            continue
        if args.apply:
            replace_file_atomically(captured, source, mode)
        restored += 1
    restored_links = 0
    skipped_links = 0
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
        if source.is_symlink() and os.readlink(source) == target:
            skipped_links += 1
            continue
        if args.apply:
            create_missing_private_parents(source.parent)
            if source.exists() and source.is_dir() and not source.is_symlink():
                fail(f"restore link target is a directory: {source}")
            temporary = source.with_name(f".ptr-restore-link-{os.getpid()}-{restored_links}")
            try:
                temporary.symlink_to(target)
                os.replace(temporary, source)
            finally:
                temporary.unlink(missing_ok=True)
        restored_links += 1
    action = "restored" if args.apply else "would_restore"
    print(f"files_{action}={restored}")
    print(f"files_skipped_identical={skipped_files}")
    print(f"links_{action}={restored_links}")
    print(f"links_skipped_identical={skipped_links}")
    print(f"directories_created={directories_created}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    capture_parser = sub.add_parser("capture")
    capture_parser.add_argument("--project", required=True)
    capture_parser.add_argument("--owner", required=True)
    capture_parser.add_argument("--output", required=True, type=Path)
    capture_parser.add_argument("--inspect-fixture", type=Path)
    capture_parser.set_defaults(func=capture)
    data_parser = sub.add_parser("data-dir")
    data_parser.add_argument("--snapshot", required=True, type=Path)
    data_parser.set_defaults(func=data_dir)
    check_data_parser = sub.add_parser("check-data-mounts")
    check_data_parser.add_argument("--snapshot", required=True, type=Path)
    check_data_parser.add_argument("--rendered-config", required=True, type=Path)
    check_data_parser.set_defaults(func=check_data_mounts)
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
