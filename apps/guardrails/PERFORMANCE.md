# Genuine Guard lifecycle optimization (2026-10-10)

The first frozen full-runtime performance gate remains **FAIL** (throughput ratio
0.552, required >=0.60; p95 passed). This document does not change that gate.

## Evidence and cleanup plan

Synthetic local microbenchmark, 200 warmed calls per case before changes:

| Lifecycle | p50 ms | p95 ms |
|---|---:|---:|
| Constructor + use + configure | 20.903 | 23.493 |
| Original per-request input | 24.954 | 34.198 |
| Original per-request output | 25.084 | 30.047 |
| Same actual Guard, history cleared, input | 0.702 | 0.975 |
| Same actual Guard, history cleared, output | 0.694 | 0.940 |

These are local lifecycle timings, **not** throughput-gate results. Installed
0.11.0 cProfile: 50 input calls took 1.17s, including 1.03s in
GuardrailsApiClient initialization (two HTTPX clients creating SSL CA contexts).
No external call was made. Construction repeats this even with `use_server=False`.

Upstream/installed evidence inspected before changes:
- [Guard 0.11.0 implementation](https://github.com/guardrails-ai/guardrails/blob/v0.11.0/guardrails/guard.py):
  validate delegates to parse; each _execute creates a new context and appends
  a Call to public `history`; configuration and validator references live on Guard.
- [Upstream repeated validate usage](https://github.com/guardrails-ai/guardrails/blob/main/README.md):
  one configured Guard validates multiple inputs.
- [Stack 0.11.0 implementation](https://github.com/guardrails-ai/guardrails/blob/v0.11.0/guardrails/classes/generic/stack.py):
  history extends list; `clear()` is its inherited public list operation.
- Installed `validator_base.py`: these synchronous, nonstreaming validators do
  not assign request metadata to validator state. Our `_validate` methods are
  pure functions of the current value/metadata, and never call with_metadata.

Plan: preserve the existing 315 parity fixtures, add lifecycle privacy and
parallel regression tests first, then reuse only within the same thread and
validator kind. Clear raw history in `finally` on success or failure, discard
an exception-tainted Guard, and exercise the unchanged genuine validate wrapper.
No request result cache, shared Guard/validator, altered policy, skipped check,
Hub calls, model calls, new dependency, or performance threshold change.

FastAPI synchronous routes execute on AnyIO worker threads; the thread-local
cache has at most three Guards per live thread (rules input, Jev input, output).
Thread teardown releases the cache. Metadata always enters a new synchronous
validate invocation; no concurrent request can use the same Guard. Public
history is empty between calls; objects retained by the cache contain only
fixed validator/configuration state, never the raw text/metadata/result.

## Verified optimized lifecycle (same n=200 benchmark)

| Case | fresh p50/p95 ms | thread-local p50/p95 ms |
|---|---:|---:|
| Input | 22.719 / 31.066 | 0.730 / 0.984 |
| Output | 21.800 / 26.196 | 0.655 / 0.883 |

19 Python tests pass, including original 315 fixtures, four threads independently
running all 315 fixtures twice (2,520 parallel validations), 24 parallel HTTP
request pairs, differing metadata/validator kinds, empty histories, raw
text/utterance/metadata absence from retained state, and discard on exception.
Ruff lint/format and mypy pass. Socket-blocked real-Guard tests still pass.

## Verification

Run the synthetic lifecycle benchmark:

```sh
PYTHONPATH=apps/guardrails .venv-guardrails/bin/python apps/guardrails/benchmark.py
```

It compares fresh and thread-local real Guards under identical checks; emits
only aggregate timings, no payloads. Run the policy, privacy and HTTP tests:

```sh
.venv-guardrails/bin/python -W ignore -m unittest discover -s apps/guardrails/tests -v
```

Full-runtime frozen gate must be rerun separately after deployment. Do not
substitute the lifecycle benchmark for that acceptance result.
