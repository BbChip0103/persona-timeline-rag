"""Only owned synchronous service processes may freeze static imports before their loop."""

import asyncio
import gc
from contextlib import contextmanager
from types import SimpleNamespace

import pytest


def fake_bootstrap(monkeypatch):
    from ptr_llm import bootstrap
    from ptr_llm.control import _wire_module

    events = []
    monkeypatch.setattr(bootstrap, "_has_guardrails_rc", lambda: False)
    monkeypatch.setattr(bootstrap.gc, "isenabled", lambda: True)
    monkeypatch.setattr(bootstrap.gc, "get_threshold", lambda: (2000, 10, 10))
    monkeypatch.setattr(bootstrap.gc, "get_freeze_count", lambda: 0)
    monkeypatch.setattr(bootstrap.gc, "collect", lambda: events.append("collect"))
    monkeypatch.setattr(bootstrap.gc, "freeze", lambda: events.append("freeze"))
    monkeypatch.setattr(bootstrap.gc, "unfreeze", lambda: events.append("unfreeze"))
    monkeypatch.setattr(bootstrap.importlib, "import_module", lambda name: events.append(name))
    monkeypatch.setattr(bootstrap, "_load_wire_schema", lambda: events.append("schema"))
    assert callable(_wire_module)
    return bootstrap, events


def test_static_imports_before_one_owned_freeze_cleanup_and_unchanged_gc(monkeypatch):
    bootstrap, events = fake_bootstrap(monkeypatch)
    before = gc.get_threshold(), gc.isenabled()
    with bootstrap.static_import_gc() as owned:
        assert owned
        assert events[-3:] == ["schema", "collect", "freeze"]
        assert "langchain_openai" in events and "langfuse" in events
        assert "openai" in events and "ptr_llm.runtime" in events
        events.append("loop-and-owned-runtime-shutdown")
    assert events[-2:] == ["loop-and-owned-runtime-shutdown", "unfreeze"]
    assert events.count("freeze") == events.count("unfreeze") == 1
    assert (gc.get_threshold(), gc.isenabled()) == before


@pytest.mark.parametrize(
    "condition", ["preexisting", "disabled", "thresholds", "noncpython", "version", "rc"]
)
def test_host_ownership_or_private_rc_skips_without_imports_or_gc_changes(monkeypatch, condition):
    bootstrap, events = fake_bootstrap(monkeypatch)
    if condition == "preexisting":
        monkeypatch.setattr(bootstrap.gc, "get_freeze_count", lambda: 123)
    elif condition == "disabled":
        monkeypatch.setattr(bootstrap.gc, "isenabled", lambda: False)
    elif condition == "thresholds":
        monkeypatch.setattr(bootstrap.gc, "get_threshold", lambda: (100, 2, 3))
    elif condition == "noncpython":
        monkeypatch.setattr(bootstrap.sys, "implementation", SimpleNamespace(name="pypy"))
    elif condition == "version":
        monkeypatch.setattr(bootstrap.sys, "version_info", (3, 14, 0))
    else:
        monkeypatch.setattr(bootstrap, "_has_guardrails_rc", lambda: True)
    with bootstrap.static_import_gc() as owned:
        assert not owned
    assert events == []


async def test_async_library_call_never_mutates_gc(monkeypatch):
    bootstrap, events = fake_bootstrap(monkeypatch)
    with bootstrap.static_import_gc() as owned:
        assert not owned
    assert events == []


@pytest.mark.parametrize("failure", ["import", "loop"])
def test_bootstrap_startup_failure_releases_only_owned_freeze(monkeypatch, failure):
    bootstrap, events = fake_bootstrap(monkeypatch)
    if failure == "import":

        def failed_import(_):
            raise RuntimeError("SYNTHETIC_IMPORT_FAILED")

        monkeypatch.setattr(bootstrap.importlib, "import_module", failed_import)
    with pytest.raises(RuntimeError):
        with bootstrap.static_import_gc():
            raise RuntimeError("SYNTHETIC_RUNTIME_FAILED")
    assert events == (
        []
        if failure == "import"
        else [*bootstrap.STATIC_MODULES, "schema", "collect", "freeze", "unfreeze"]
    )


@pytest.mark.parametrize("mode", ["worker", "serve"])
def test_both_cli_routes_share_owned_sync_entrypoint_and_sanitized_failure(monkeypatch, mode):
    from ptr_llm import __main__, bootstrap, cli

    events = []

    @contextmanager
    def owned():
        events.append("before-loop")
        try:
            yield True
        finally:
            events.append("after-loop")

    async def run(selected):
        assert selected == mode

    def loop(coro):
        events.append("loop")
        coro.close()
        raise RuntimeError("SYNTHETIC_PRIVATE_STARTUP_BODY")

    monkeypatch.setattr(bootstrap, "static_import_gc", owned)
    monkeypatch.setattr(__main__, "run", run)
    monkeypatch.setattr(asyncio, "run", loop)
    monkeypatch.setattr(__main__.sys, "argv", ["ptr-llm", mode])
    for entry in [__main__.main, lambda: cli.main([mode])]:
        events.clear()
        with pytest.raises(SystemExit) as error:
            entry()
        assert error.value.code == "LLM_SERVICE_STARTUP_FAILED"
        assert events == (["before-loop", "loop", "after-loop"] if mode == "worker" else ["loop"])


def test_other_cli_route_does_not_bootstrap(monkeypatch):
    from ptr_llm import __main__, bootstrap, cli

    def denied():
        raise AssertionError("NON_SERVICE_MUST_NOT_FREEZE")

    monkeypatch.setattr(bootstrap, "static_import_gc", denied)
    monkeypatch.setattr(__main__.sys, "argv", ["ptr-llm", "evaluate"])
    monkeypatch.setattr(cli, "main", lambda: 1)
    with pytest.raises(SystemExit) as error:
        __main__.main()
    assert error.value.code == 1


def test_cold_static_import_phase_has_no_settings_clients_network_or_private_reads(tmp_path):
    """Cold child has absent RC; no production HOME or private config is consulted."""
    import json
    import os
    import subprocess
    import sys

    child = """
import gc,json,os,socket,sys
from pathlib import Path
home=Path(os.environ["HOME"])
assert not (home/".guardrailsrc").exists()
def audit(event,args):
    if event=="open" and isinstance(args[0],(str,bytes)):
        p=Path(os.fsdecode(args[0]))
        assert p.name not in {".env","roles.env","accounts.json"}
        # An absentRC metadata/open check is the pinned SDK's known import behavior.
        if p.parent==home:
            assert p.name==".guardrailsrc" and not p.exists()
sys.addaudithook(audit)
def denied(*a,**kw):raise AssertionError("STATIC_BOOTSTRAP_SIDE_EFFECT")
socket.socket.connect=denied
socket.socket.connect_ex=denied
import httpx
httpx.Client.__init__=denied
httpx.AsyncClient.__init__=denied
from psycopg_pool import AsyncConnectionPool
AsyncConnectionPool.__init__=denied
from ptr_llm.config import Settings
Settings.from_env=denied
Settings.__init__=denied
from ptr_llm.bootstrap import static_import_gc
before=gc.get_threshold(),gc.isenabled(),gc.get_freeze_count()
with static_import_gc() as owned:
    assert owned and gc.get_freeze_count()>0
    from ptr_llm import runtime
    from langfuse import Langfuse
    assert gc.get_threshold()==before[0] and gc.isenabled()==before[1]
    # Ensure helpers did not instantiate an app runtime or mutate the default loop.
    import asyncio
    try:asyncio.get_running_loop();raise AssertionError("LOOP_STARTED")
    except RuntimeError:pass
assert gc.get_freeze_count()==before[2]
print(json.dumps({"owned":True,"restored":True,"gcEnabled":gc.isenabled()}))
"""
    result = subprocess.run(
        [sys.executable, "-c", child],
        env={**os.environ, "HOME": str(tmp_path)},
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, "COLD_BOOTSTRAP_SIDE_EFFECT_CHECK_FAILED"
    assert json.loads(result.stdout) == {"owned": True, "restored": True, "gcEnabled": True}
