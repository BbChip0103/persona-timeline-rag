"""Frozen TS current-domain parity; exclusively generated synthetic registries."""

import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace as NS

import pytest

from ptr_llm.evaluation import domain

GOLD = json.loads(Path(__file__).with_name("domain_goldens.json").read_text())


def snapshot(migration):
    result = migration.model_dump(exclude_unset=True)
    result["cases"] = [
        hashlib.sha256(
            json.dumps(case, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()
        ).hexdigest()
        for case in result["cases"]
    ]
    return result


def test_full_original_registries_preserve_case_rubric_versions_and_conditions():
    assert GOLD["syntheticOnly"]
    natural = domain.migrate_natural_case_registry(
        GOLD["natural"], [GOLD["source"]], GOLD["versions"]
    )
    assert snapshot(natural) == GOLD["naturalExpected"]
    semantic = domain.migrate_natural_case_registry(
        GOLD["natural"],
        [GOLD["source"]],
        GOLD["versions"],
        {"retrievalMode": "semantic", "revision": "approved-semantic-v2"},
    )
    assert snapshot(semantic) == GOLD["semanticExpected"]
    legacy = domain.migrate_legacy_case_registry(GOLD["legacy"], [GOLD["source"]], GOLD["versions"])
    assert snapshot(legacy) == GOLD["legacyExpected"]
    extraction = domain.migrate_legacy_extraction_registry(
        GOLD["legacy"], [GOLD["source"]], GOLD["versions"]
    )
    assert snapshot(extraction) == GOLD["extractionExpected"]
    assert (len(natural.cases), len(legacy.cases), len(extraction.cases)) == (96, 222, 50)
    assert domain.natural_review_dimensions(GOLD["natural"]) == GOLD["reviewDimensions"]
    assert domain.EXTRACTION_SYSTEM_PROMPT == GOLD["extractionPrompt"]
    assert domain.EXTRACTION_PROMPT_REVISION == GOLD["extractionPromptRevision"]


@pytest.mark.parametrize("case", GOLD["appGoldens"])
def test_existing_ts_domain_metric_and_multiplicity_parity(case):
    scores = domain.app_evaluator(input=case["input"], output=case["output"])
    assert [{"name": s.name, "value": s.value} for s in scores] == [
        {"name": s["name"], "value": s["value"]} for s in case["expected"]
    ]
    assert domain.app_expected(case["input"]) == case["policy"]


@pytest.mark.parametrize("case", GOLD["extraction"])
def test_original_extraction_surface_validator_exact_parity(case):
    assert domain.validate_extraction_candidate(case["raw"], case["caption"]) == case["expected"]


@pytest.mark.parametrize("mutation", ["balance", "duplicates", "cardinality", "turns", "unknown"])
def test_registry_failclosed_before_any_execution(mutation):
    raw = copy.deepcopy(GOLD["legacy"])
    if mutation == "balance":
        raw["cases"][0]["category"] = "absent"
    elif mutation == "duplicates":
        raw["cases"][1]["id"] = raw["cases"][0]["id"]
    elif mutation == "cardinality":
        raw["cases"].pop()
    elif mutation == "turns":
        raw["scenarios"][0]["turns"].pop()
    else:
        raw["cases"][0]["unknown"] = "sentinel"
    with pytest.raises(ValueError):
        domain.migrate_legacy_case_registry(raw, [], GOLD["versions"])


@pytest.mark.parametrize(
    "name,value",
    [
        ("intent", None),
        ("goldSourceIds", None),
        ("expectedStatus", "unknown"),
        ("text", 1),
        ("hiddenGold", "never send"),
    ],
)
def test_current_domain_input_strict_types(name, value):
    raw = copy.deepcopy(GOLD["appGoldens"][0]["input"])
    raw["turns"][0][name] = value
    with pytest.raises(ValueError):
        domain.AppExperimentInput.model_validate(raw)


async def test_default_domain_uses_real_engine_with_zero_model_or_retrieval_calls():
    task = domain.synthetic_domain_task()
    for case in domain.synthetic_domain_migration().cases:
        output = await task(item=NS(input=case.input))
        assert output["modelSubmissionChecks"] == 0
        assert all(
            score.value == 1 for score in domain.app_evaluator(input=case.input, output=output)
        )
        assert len(output["rows"]) == 1
        assert output["rows"][0]["turn"]["reply"]["status"] == "out_of_scope"


class ProbeEngine:
    def __init__(self):
        self.contexts = []
        self.personas = NS(get=self.persona)
        self.retrieval = None

    async def persona(self, *_):
        return copy.deepcopy(domain.SYNTHETIC_PERSONA)

    async def handle(self, grant, **_):
        c = grant["context"]
        self.contexts.append(copy.deepcopy(c))
        return {
            "kind": "completed",
            "reply": {
                "personId": c["session"]["personId"],
                "personaRevision": c["session"]["personaRevision"],
                "sessionId": c["session"]["id"],
                "status": "answered",
                "content": "Fictional answer.",
                "claims": [],
                "evidence": [],
            },
        }


@pytest.mark.parametrize("kind", ["fixed", "evolving", "single"])
async def test_core_adapter_history_binding_and_no_gold_or_rubric_in_model_user_input(kind):
    engine = ProbeEngine()
    raw = copy.deepcopy(domain.synthetic_domain_migration().cases[0].input)
    raw["historyKind"] = kind
    raw["fixedHistory"] = [{"role": "assistant", "content": "Frozen assistant."}]
    raw["turns"] *= 3
    for i, turn in enumerate(raw["turns"]):
        turn["id"] = str(i)
    raw["turns"][0]["goldSourceIds"] = ["hidden-gold-sentinel"]
    raw["sources"] = []
    result = await domain.create_core_app_task(engine, "synthetic/no-model")(item=NS(input=raw))
    assert len(result["rows"]) == 3
    assert all(set(c["input"]) == {"text", "intent"} for c in engine.contexts)
    if kind == "fixed":
        assert all(
            [m["content"] for m in c["history"]][-1] == "Frozen assistant." for c in engine.contexts
        )
        assert len({c["session"]["id"] for c in engine.contexts}) == 3
        assert all("previousReply" not in c for c in engine.contexts)
    elif kind == "evolving":
        assert [len(c["history"]) for c in engine.contexts] == [1, 3, 5]
        assert len({c["session"]["id"] for c in engine.contexts}) == 1
        assert (
            engine.contexts[1]["previousReply"]["sessionId"] == engine.contexts[1]["session"]["id"]
        )
    else:
        assert all(len(c["history"]) == 1 for c in engine.contexts)


async def test_extraction_uses_original_prompt_without_metadata_or_gold_and_keeps_pending():
    sent = []

    class Provider:
        async def generate(self, messages, **_):
            sent.extend(messages)
            return json.dumps(
                {
                    "eventDate": "2026-01-03",
                    "timeExpression": "2026-1-3",
                    "quote": GOLD["source"]["caption"],
                }
            )

    value = GOLD["extractionInput"]
    result = await domain.create_extraction_task(Provider(), GOLD["versions"]["model"])(
        item=NS(input=value)
    )
    assert sent[0]["content"] == GOLD["extractionPrompt"]
    assert (
        "postedAt" not in sent[1]["content"] and "silverExpectedEventDate" not in sent[1]["content"]
    )
    assert result["correctnessAccuracy"] is None and result["humanReview"] == "pending"
    assert all(s.value == 1 for s in domain.extraction_evaluator(input=value, output=result))
    wrong = copy.deepcopy(value)
    wrong["versions"]["model"] = "another-model"
    with pytest.raises(ValueError):
        await domain.create_extraction_task(Provider(), GOLD["versions"]["model"])(
            item=NS(input=wrong)
        )


@pytest.mark.parametrize("action", ["refuse", "support", "deflect", "none", None])
async def test_evolving_context_matches_backend_safety_exclusion_policy(action):
    class SafetyEngine(ProbeEngine):
        async def handle(self, grant, **kwargs):
            result = await super().handle(grant, **kwargs)
            result["reply"]["status"] = "out_of_scope"
            if action:
                result["reply"]["inputSafety"] = {"action": action}
            return result

    engine = SafetyEngine()
    raw = copy.deepcopy(domain.synthetic_domain_migration().cases[0].input)
    raw["historyKind"] = "evolving"
    raw["turns"] *= 2
    await domain.create_core_app_task(engine, "synthetic/no-model")(item=NS(input=raw))
    second = engine.contexts[1]
    assert bool(second["refusedTurnIds"]) == (action == "refuse")
    assert bool(second["loreExcludedTurnIds"]) == (action not in (None, "none"))
