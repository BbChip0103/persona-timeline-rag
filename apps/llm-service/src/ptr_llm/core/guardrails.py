"""Real Guardrails validators; no Hub, LLM, reask or remote inference calls."""

import json
from threading import local

from guardrails import Guard
from guardrails.classes.rc import RC
from guardrails.settings import settings

# Only Guardrails configuration is isolated; Langfuse/OpenTelemetry remain enabled.
from guardrails.validators import FailResult, PassResult, Validator, register_validator

from .policy import input_decision, reply_decision, rules_decision

settings.rc = RC(token=None, enable_metrics=False, use_remote_inferencing=False)


@register_validator(name="ptr-jev-input", data_type="string")
class JevInput(Validator):
    def _validate(self, value, metadata):
        decision = input_decision(metadata)
        if decision["action"] == "none":
            return PassResult()
        return FailResult(error_message=json.dumps(decision))


@register_validator(name="ptr-rules-input", data_type="string")
class RulesInput(Validator):
    def _validate(self, value, metadata):
        decision = rules_decision(value)
        if decision["action"] == "none":
            return PassResult()
        return FailResult(error_message=json.dumps(decision))


@register_validator(name="ptr-persona-output", data_type="string")
class PersonaOutput(Validator):
    def _validate(self, value, metadata):
        decision = reply_decision(value, metadata)
        if decision is None:
            return PassResult()
        return FailResult(
            error_message=json.dumps(
                {key: item for key, item in decision.items() if key != "content"}
            ),
            fix_value=decision["content"],
        )


# Synchronous FastAPI routes use worker threads. Never share a Guard or Validator
# between threads: their execution history and options are mutable upstream state.
_thread_guards = local()


class OutputValidationError(ValueError):
    code = "GUARDRAILS_OUTPUT_MISSING"

    def __init__(self):
        super().__init__(self.code)


def _get_guard(kind):
    guards = getattr(_thread_guards, "guards", None)
    if guards is None:
        guards = {}
        _thread_guards.guards = guards
    if kind not in guards:
        validator, on_fail = {
            "rules": (RulesInput, "noop"),
            "jev": (JevInput, "noop"),
            "output": (PersonaOutput, "fix"),
        }[kind]
        guard = Guard(use_server=False, history_max_length=1).use(validator(on_fail=on_fail))
        guard.configure(allow_metrics_collection=False)
        guards[kind] = guard
    return guards[kind]


def _validate(kind, text, metadata):
    guard = _get_guard(kind)
    try:
        return guard.validate(text, metadata=metadata, num_reasks=0)
    except Exception:
        # A failed invocation may have partially changed execution state.
        # Discard it rather than let that state affect a later request.
        _thread_guards.guards.pop(kind, None)
        raise
    finally:
        # The public Stack extends list; never retain request text/metadata in
        # the long-lived thread cache, even when a validator raises.
        guard.history.clear()


def validate_input(text, metadata):
    kind = "rules" if metadata.get("classification") == "rules-only" else "jev"
    outcome = _validate(kind, text, metadata)
    if outcome.validation_passed:
        return {"action": "none", "fired": []}
    return json.loads(outcome.validation_summaries[0].failure_reason)


def validate_output(reply, metadata):
    outcome = _validate("output", reply, metadata)
    if outcome.validated_output is None:
        decision = reply_decision(reply, metadata)
        if decision is not None and not decision.get("edited"):
            return decision
        raise OutputValidationError()
    summaries = outcome.validation_summaries
    if not summaries:
        return {"content": outcome.validated_output}
    return {**json.loads(summaries[0].failure_reason), "content": outcome.validated_output}
