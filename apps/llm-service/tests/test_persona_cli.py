import json
from types import SimpleNamespace as NS
from unittest.mock import AsyncMock

import pytest

from ptr_llm.evaluation.persona_cli import operate, preflight, read_private_json

PERSONA = {
    "id": "synthetic",
    "personId": "synthetic-person",
    "label": "Synthetic",
    "language": "ko",
    "revision": "v1",
    "reviewStatus": "synthetic",
    "identity": "Fictional",
    "concept": "Research",
    "style": ["brief"],
    "boundaries": ["AI disclosure"],
    "sourceRefs": [],
    "greeting": "안녕",
}


def _file(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False))
    path.chmod(0o600)
    return str(path)


def _args(tmp_path):
    return NS(
        operation="publish",
        target="ptr_split_test",
        confirm=True,
        file=_file(tmp_path / "input.json", [PERSONA]),
        sources_doc=_file(tmp_path / "sources.json", []),
        captions_file=_file(tmp_path / "captions.json", []),
        split_file=_file(tmp_path / "split.json", {}),
        generated_list=None,
        baseline=None,
        authored_list=str(tmp_path / "authored.json"),
        publish_log=str(tmp_path / "publish.json"),
    )


async def test_publish_preserves_other_personas_and_log(tmp_path):
    args = _args(tmp_path)
    other = {**PERSONA, "id": "other", "personId": "other-person"}
    _file(tmp_path / "authored.json", {"database": "ptr_split_test", "personas": [other]})
    _file(tmp_path / "publish.json", [{"operation": "historical", "revision": "original"}])
    repo = AsyncMock()
    repo.import_personas.return_value = [{"inserted": True, "previousRevision": None}]
    result = await operate(args, repo)
    assert result["ok"] and result["published"] == 1
    data = read_private_json(args.authored_list)
    assert len(data["personas"]) == 2 and data["personas"][0] == other
    log = read_private_json(args.publish_log)
    assert len(log) == 2 and log[0]["revision"] == "original"
    assert (tmp_path / "authored.json").stat().st_mode & 0o777 == 0o600


async def test_database_artifact_mismatch_writes_nothing(tmp_path):
    args = _args(tmp_path)
    _file(tmp_path / "authored.json", {"database": "ptr_split_research", "personas": []})
    repo = AsyncMock()
    with pytest.raises(ValueError, match="database"):
        await operate(args, repo)
    repo.import_personas.assert_not_called()


async def test_restore_requires_existing_binding_and_preserves_revision(tmp_path):
    args = _args(tmp_path)
    args.operation = "restore"
    _file(tmp_path / "authored.json", {"database": "ptr_split_test", "personas": [PERSONA]})
    repo = AsyncMock()
    repo.restore_revisions.return_value = [{"previousRevision": "v2"}]
    result = await operate(args, repo)
    assert result["ok"]
    assert repo.restore_revisions.call_args.args[0][0]["revision"] == "v1"


async def test_invalid_baseline_cannot_exempt_publish(tmp_path):
    args = _args(tmp_path)
    args.baseline = _file(tmp_path / "baseline.json", [PERSONA])
    repo = AsyncMock()
    repo.verify_baselines.return_value = [False]
    with pytest.raises(ValueError, match="validation"):
        await operate(args, repo)
    repo.import_personas.assert_not_called()


def test_preflight_symlink_rejected(tmp_path):
    args = _args(tmp_path)
    target = tmp_path / "target.json"
    _file(target, {"database": "ptr_split_test", "personas": []})
    (tmp_path / "authored.json").symlink_to(target)
    with pytest.raises(ValueError):
        preflight(args, "ptr_split_test")
