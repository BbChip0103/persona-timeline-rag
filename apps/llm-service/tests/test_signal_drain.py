"""Exercise shutdown with a real OS signal and uvicorn process."""

import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path


def _run_sigterm_child(tmp_path: Path, mode: str) -> list[str]:
    marker = tmp_path / "drain.log"
    child = Path(__file__).with_name("signal_drain_child.py")
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    process = subprocess.Popen(
        [sys.executable, str(child)],
        env={
            **os.environ,
            "PTR_TEST_DRAIN_MARKER": str(marker),
            "PTR_TEST_DRAIN_PORT": str(port),
            "PTR_TEST_DRAIN_MODE": mode,
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        until = time.monotonic() + 10
        while time.monotonic() < until:
            lines = marker.read_text().splitlines() if marker.exists() else []
            if ("started" in lines or mode == "serve"):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    pass
            if process.poll() is not None:
                raise AssertionError("worker exited before starting synthetic job")
            time.sleep(0.02)
        else:
            raise AssertionError("synthetic job did not start")
        process.send_signal(signal.SIGTERM)
        _, stderr = process.communicate(timeout=10)
        assert process.returncode == 0, stderr
        return marker.read_text().splitlines()
    finally:
        if process.poll() is None:
            process.terminate()
            process.communicate(timeout=10)


def test_sigterm_drains_active_job_and_ack(tmp_path: Path) -> None:
    assert _run_sigterm_child(tmp_path, "worker") == [
        "started", "completed", "acked", "control_closed", "runtime_closed"
    ]


def test_sigterm_drains_control_server(tmp_path: Path) -> None:
    assert _run_sigterm_child(tmp_path, "serve") == ["control_closed", "runtime_closed"]
