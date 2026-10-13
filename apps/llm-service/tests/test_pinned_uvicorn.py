"""The installed worker validates its dependency without source-tree files."""

import pytest

import ptr_llm.__main__ as worker_main


def test_pinned_uvicorn_accepts_installed_version_without_source_tree(monkeypatch):
    monkeypatch.setattr(worker_main, "__file__", "/missing/installed/ptr_llm/__main__.py")
    monkeypatch.setattr(worker_main, "version", lambda package: "0.54.0")

    worker_main._assert_pinned_uvicorn()


def test_pinned_uvicorn_rejects_other_installed_version(monkeypatch):
    monkeypatch.setattr(worker_main, "__file__", "/missing/installed/ptr_llm/__main__.py")
    monkeypatch.setattr(worker_main, "version", lambda package: "0.53.0")

    with pytest.raises(RuntimeError, match="^UVICORN_VERSION_UNSUPPORTED$"):
        worker_main._assert_pinned_uvicorn()
