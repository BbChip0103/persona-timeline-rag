# Core migration oracles

All documents and captions here are synthetic. The reference is the existing
TypeScript core at framework migration base `3dc6ff8`, not private research data.

- `core_policy_test.py` executes all 315 existing `apps/guardrails/tests/policy_fixtures.json`
  cases through real inline Guardrails validators. No HTTP, Hub, LLM, or reask is used.
- `core_domain_golden.json` locks exact persona rendering/revision/greetings/lore,
  conversation context, evidence quote binding, prompt bytes and publish decisions.
- `core_routing_golden.json` locks 39,680 original routing/classifier-gate combinations
  (62 utterances × 4 histories × 160 parameter combinations).
- Native Python graphs additionally test tool loops, fencing before calls, RAG off,
  state updates, retries without outer checkpoints, invalid output fallback, drafts,
  and refusal filtering.

To regenerate the static synthetic oracles, from the repository root:

```sh
node_modules/.bin/tsx apps/llm-service/tests/core_golden_generator.ts
node_modules/.bin/tsx apps/llm-service/tests/core_extra_golden_generator.ts
```

These commands execute only the TypeScript domain functions. They do not call a
provider or database. Regenerate only for an intentional reference-contract change;
otherwise fix the Python implementation rather than replacing failing goldens.
