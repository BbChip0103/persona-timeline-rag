import json

import pytest

from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig, pseudonymous_id, redact_telemetry


def test_redaction_nested_json_bounds():
    data = {
        "authorization": "Bearer private",
        "normal": "mail@example.com",
        "array": ["sk-synthetic-private", {"rawEvidence": "private source"}],
        "json": json.dumps({"password": "private"}),
        "bad": float("nan"),
    }
    result = redact_telemetry(data)
    text = json.dumps(result)
    assert "private" not in text
    assert result["bad"] is None
    assert len(redact_telemetry(list(range(100)))) == 64
    assert len(redact_telemetry("x" * 20000)) == 16384


@pytest.mark.parametrize(
    "url,local",
    [
        ("http://external.example", True),
        ("http://localhost", False),
        ("https://user:secret@example.com", False),
        ("https://example.com?key=x", False),
    ],
)
def test_explicit_endpoint_rejects_unsafe(url, local):
    with pytest.raises(ValueError):
        TelemetryConfig(
            enabled=True,
            base_url=url,
            public_key="public",
            secret_key="secret",
            allow_local_http=local,
        ).validate()


def test_disabled_telemetry_no_sdk_or_network():
    telemetry = FrameworkTelemetry(TelemetryConfig())
    with telemetry.turn("synthetic-turn", "synthetic-session", "synthetic-user") as span:
        span.update(output="private")
    assert telemetry.client is None
    assert telemetry.flush() and telemetry.shutdown()
    assert pseudonymous_id("private") != "private"


def test_native_langfuse_version_and_config():
    from importlib.metadata import version

    assert version("langfuse") == "4.17.0"
    TelemetryConfig(
        enabled=True,
        base_url="http://127.0.0.1:59999",
        public_key="public",
        secret_key="secret",
        allow_local_http=True,
    ).validate()


def test_enabled_observation_sanitizes_exception_and_drops_content():
    from contextlib import contextmanager
    from unittest.mock import Mock

    telemetry = FrameworkTelemetry(TelemetryConfig())
    telemetry.config = TelemetryConfig(capture_content=False)
    client, sdk_span = Mock(), Mock()
    exited = []

    @contextmanager
    def context(**kwargs):
        assert "input" not in kwargs
        try:
            yield sdk_span
        except Exception:
            exited.append("exception-seen")
            raise

    client.start_as_current_observation = context
    telemetry.client = client
    with pytest.raises(RuntimeError, match="private-provider-body"):
        with telemetry.observation("generation", input="private-input") as observation:
            observation.update(output="private-output", metadata={"kind": "synthetic"})
            raise RuntimeError("private-provider-body")
    assert not exited
    assert sdk_span.update.call_args_list[0].kwargs == {"metadata": {"kind": "synthetic"}}
    assert sdk_span.update.call_args_list[1].kwargs == {
        "level": "ERROR",
        "status_message": "OPERATION_FAILED",
    }


def test_explicit_mapping_is_not_process_env(monkeypatch):
    monkeypatch.setenv("LANGFUSE_ENABLED", "true")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "process-private-key")
    assert not TelemetryConfig.from_env({}).enabled
    config = TelemetryConfig.from_env(
        {
            "LANGFUSE_ENABLED": "true",
            "LANGFUSE_BASE_URL": "http://127.0.0.1:59999",
            "LANGFUSE_PUBLIC_KEY": "synthetic-public",
            "LANGFUSE_SECRET_KEY": "mapping-private-key",
            "LANGFUSE_ALLOW_LOCAL_HTTP": "true",
            "LANGFUSE_TRACING_ENVIRONMENT": "synthetic",
        }
    )
    config.validate()
    assert config.secret_key == "mapping-private-key"
    assert "private-key" not in repr(config)


def test_export_filter_rejects_missing_instrumentation_scope(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    import langfuse

    captured = {}

    def factory(**kwargs):
        captured.update(kwargs)
        return Mock()

    monkeypatch.setattr(langfuse, "Langfuse", factory)
    telemetry = FrameworkTelemetry(
        TelemetryConfig(
            enabled=True,
            base_url="http://127.0.0.1:59999",
            public_key="public",
            secret_key="secret",
            allow_local_http=True,
        )
    )
    export = captured["should_export_span"]
    assert not export(SimpleNamespace(instrumentation_scope=None))
    assert export(SimpleNamespace(instrumentation_scope=SimpleNamespace(name="langfuse-sdk")))
    assert not export(SimpleNamespace(instrumentation_scope=SimpleNamespace(name="other-private")))
    telemetry.shutdown()
