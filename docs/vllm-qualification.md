# Bounded real-vLLM qualification

> Historical reference only. The retired vLLM load harness is removed with the L4
> LiteLLM cleanup because it depended on deleted proxy callbacks.
> These commands are not runnable from the current checkout.

The retired vLLM load harness compares archived original (`ee9f55c`), archived
TypeScript migration (`3dc6ff8`), and a fresh Python-split snapshot. This is a
synthetic, small-sample qualification, not a production capacity benchmark or a
replacement for the earlier 32-turn fixed-delay gate.

## Execution contract

- One approved, isolated, actual vLLM endpoint with cached Qwen3-8B weights.
  Its authenticated loopback guard enforces a combined admission ceiling of 160
  and effective generation settings of 64 tokens, temperature 0, thinking off.
  The harness requires private native-engine and metrics-contract proof files;
  it does not provision a GPU, buy model calls, or download model weights.
- Four matched triplets: O-C-P, P-C-O, O-P-C, C-P-O. Each leg uses two warm-up
  turns followed by eight measured turns: 120 admissions in total. RAG,
  classifiers and safety calls are off; client concurrency is eight, worker
  concurrency four, and each turn has a new session.
- Before each leg, reset only the owned native prefix cache and the owned
  proxy's exact routing-credit namespace, after verifying no active leases.
  Prometheus cumulative counters are compared using before/after deltas.
- The same owned PostgreSQL 15 cluster supplies three new, role-isolated
  databases with identical fixtures. Native saver bootstrap and six role
  denials are checked. Private copies adapt only exact test-loopback port
  literals and record before/after hashes; production source guards and shared
  test/research data are not changed.
- A common loopback auth-only bridge supports the original archive's lack of
  upstream authentication. It does not rewrite prompts, queue requests or retry.
  Original transport streams; current and split transports do not. This
  difference is recorded, not hidden.

All measured turns must finish with nonempty, nonfallback answers, exactly one
assistant message, an empty outbox and eight actual successful model admissions.
The split additionally requires durable ACKs. Effective messages, schema, model
and generation digests must match; only JSON object key order is normalized.
String and array order are preserved. Text-output equality is not required.

Each triplet independently requires split throughput at least 60% of original
and 85% of current, and p95 at most original ×1.75 +250 ms and current ×1.25
+100 ms. All four must pass. Keep failed/invalid evidence; do not change these
thresholds after seeing a result.

## Running

Run from the source root, with explicit approved private provider artifacts:

```sh
umask 077
pnpm exec tsx <archived-vllm-load-harness> \
  --serving-env=/tmp/ptr-owned-provider/serving.env \
  --provider-metadata=/tmp/ptr-owned-provider \
  --output=/tmp/ptr-vllm-load-owned-run
```

The approved synthetic fixture environment paths must already exist. The CLI
accepts `--env-file`, `--baseline-env-file`, and `--roles-env`, but existing
exact-path/identity guards still apply: these options do not authorize arbitrary
database targets. The recorded roles fixture is
`/tmp/ptr-python-split-1791653132/roles.env`.
`--capture-only=true` uses a local fake provider to check transport and fixture
parity. A successful capture is **not** real GPU performance acceptance.

Private outputs contain provenance, exact finite latency samples, per-leg
provider and database metadata, metrics, progress and `summary.json`. Runtime
snapshots, proxy and database instances are owned and cleaned up by the harness.
The separately provisioned GPU engine/guard/tunnel require their owner's cleanup.
Do not copy private artifacts, credentials, prompts or review rows into public
documentation.

## Evidence limits

Whole-path latency includes the common 100 ms terminal poll. Guard durations
include the upstream transport and model call, not exclusively GPU kernels.
Nonstreaming guard TTFT and common per-turn queue wait are unavailable; disk/WAL
I/O is not sampled. Native streaming qualification can measure meaningful-content
TTFT separately. One engine demonstrates cache reuse and concurrent execution,
not the benefit of multi-engine cache/state-aware routing or production QPS.

The first live attempt found a decoder bug: actual guard rows use
`transport_error: false` on success. Regression tests now accept false/null/
missing as no error and reject true/nonempty error strings. The failed run is
preserved; an offline decoder replay is not retroactive performance acceptance.

## Observed qualification — 2026-10-11 KST

The fresh real run completed all 120 planned admissions and all four triplets
passed the predeclared gates, including effective-input equivalence and split
durable ACKs. Source and frozen-runtime hashes stayed unchanged during the run.
The split runtime snapshot was based on source HEAD `b629569`, hash
`074931ef0c81deeaadb0453f38138f747ab99731ca84d5fde43473ce1a329250`.

| Matched triplet | Split/original throughput | Split/current throughput | Split/original p95 | Split/current p95 |
|---|---:|---:|---:|---:|
| O-C-P | 1.028 | 1.053 | 0.973 | 0.949 |
| P-C-O | 0.973 | 0.947 | 1.028 | 1.056 |
| O-P-C | 1.081 | 1.059 | 0.925 | 0.944 |
| C-P-O | 0.898 | 0.899 | 1.113 | 1.112 |

Median paired throughput ratios were 1.0003 and 1.0002; median whole-path p95
ratios were 1.0004 and 1.0026. Median completed batch throughput was about 2.12
turns/s and median per-leg p95 about 3.78 s for each topology. The finite batch
does not establish a statistically significant speed advantage or production
capacity; the split was roughly equivalent in this workload, with variation
between rounds.

Combined admissions were 138/160: 12 separate native-engine qualifications,
six warm-up calls in the preserved failed decoder attempt, and 120 in the fresh
main run. All 138 were successful HTTP 200 responses with no transport errors,
paid API calls or embedding calls. Separate native streaming measured 744 ms
meaningful-content TTFT for a three-output-token response; it is not the batch
p95. Actual native metrics also showed prefix reuse and peak eight concurrent
requests. These results use synthetic inputs only.
