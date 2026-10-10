# Persona Guardrails validation service

A stateless internal Python boundary using **guardrails-ai 0.11.0** `Guard` and
registered custom validators. This does not replace the NestJS API. No Hub
installation, provider inference, output-classifier call or generation/reask is
performed. All dependency versions are pinned in `requirements.txt`.

## Routes and authentication

- `GET /health`: static version/revision only, no credentials or request data.
- `POST /validate/input`: `Authorization: Bearer <GUARDRAILS_API_KEY>` required.
- `POST /validate/output`: the same authorization is required.

`GUARDRAILS_API_KEY` must contain at least 16 characters; startup fails if absent.
Production should generate an independent random secret and use an internal
network/TLS. Do not reuse a provider credential. The container is non-root and
listens on internal port `8000`. API docs/OpenAPI and access logging are disabled.
Unknown fields are rejected. Error responses do not echo rejected input.

Input payload:

```json
{"text":"synthetic input","metadata":{"probabilities":{"self_harm":0.8},"thresholds":{"prompt_injection":0.5,"sexual":0.5,"violence_gore":0.5,"self_harm":0.2,"hate_harassment":0.5,"illegal_dangerous":0.6,"private_info":0.5},"categories":["self_harm"]}}
```

The seven thresholds are required; `categories` must exactly match supplied
probability keys (supports the existing self-harm-only deterministic rule path).
Optional `metadata.intent` carries existing Jev `{label,confidence,probabilities}`
for `timeline`/`small_talk`. The result is `{revision,action,category?,fired,intent?}`.
Self-harm support takes priority over refusal categories, which take priority over
prompt-injection deflection. Refusal ties use the original category order.
Missing/incomplete Jev assessment is an error, never a successful safe verdict.
When the TS Jev filter is explicitly off, `classification: "rules-only"` is
required with an empty `probabilities` object. A separate genuine Guard validator
executes the frozen existing `isSensitive` rule patterns (private details/current
whereabouts); it does not manufacture zero Jev scores or claim comprehensive
semantic safety coverage. Omitted classification defaults to `"jev"` for strict
existing assessment contracts. Supplied probabilities in rules-only mode are
rejected. Deterministic client intent/routing remains in TypeScript.

Output payload:

```json
{"text":"I am a real person.","metadata":{"utterance":"Are you human?","realPerson":true,"language":"en","level":"polite"}}
```

The result is `{revision,content,reason?,edited?}`. A passed reply has no reason.
`edited: true` means only meta-gap sentences were removed; other reply/evidence
status should remain unchanged. Other reasons replace the reply with the pinned
language/register-specific persona text. Internal reason codes are not user text.

## Domain policy migration and explicit limits

`reply_policy.json`, `voice_texts.json`, and `policy.py` transfer revision
`reply-guard-v7`: human impersonation, missing AI disclosure, real-person private
life, background denial, and meta-gap sentence edits; including artwork/origin
exceptions, precedence, and localized casual/polite fallbacks. Tests pin **315
unique synthetic existing v7 examples**, not real-person/source posts.

The service validates **metadata produced by the existing TS Jev caller**. Window
coverage, partial assessment errors, classifier deadlines, recent-turn filtering,
intent/rule routing, and input refusal/support text remain in TypeScript. There
is no duplicate Jev call. Output-specific Jev is **not enabled or inferred from
input probabilities**: introducing it requires a separate classifier prompt,
explicit output contract, external-transfer/cost authorization and evaluation.
Citation/source/person isolation and full RAG evidence binding also remain in TS.
The narrow DTO deliberately has no field for full private RAG sources or secrets.

`Guard.validate(..., num_reasks=0)` is used with `noop` (input decision) and `fix`
(deterministic output edits/replacements), never `reask`. Each synchronous request
exclusively uses its worker thread's Guard; history is cleared before reuse. A public service-only `guardrails_home/.guardrailsrc` disables
metrics and remote inference; the service process points HOME there so it never
loads the operator's Hub token/config. OTel SDK is disabled before import.
Service logs must not be enabled to capture request/response bodies.

## Runtime failure contract

`GuardrailsClient` in `packages/core/src/guardrails.ts` projects DTOs explicitly,
performs one HTTP request without retry, rejects redirects and malformed/oversize
responses, and enforces one deadline across transport plus response parsing.
Cancellation is propagated even when a mocked transport ignores its signal.
Errors are sanitized `GUARDRAILS_UNAVAILABLE` with `timeout`, `aborted`,
`transport`, `http`, or `invalid_response` reasons. The chat runtime must use a
fixed in-voice fail-closed reply, not serve unchecked generated text. Classifier
failure should preserve existing category/rule fallback semantics.

## Synthetic validation

```bash
# From repository root; this installs only public packages.
python -m venv .venv-guardrails
.venv-guardrails/bin/pip install -r apps/guardrails/requirements.txt 'httpx==0.28.1'
.venv-guardrails/bin/python -W ignore -m unittest discover -s apps/guardrails/tests -v
pnpm exec jest --runInBand packages/core/tests/guardrails.test.ts
```

For local standalone start, set an independent test token in the process and run
`uvicorn service:create_app --factory --app-dir apps/guardrails --host 127.0.0.1
--port <unused-port> --no-access-log`. No private files/DB/GPU are needed.

Official references: [custom validators](https://guardrailsai.com/guardrails/docs/how-to-guides/custom_validators),
[Guard API source](https://github.com/guardrails-ai/guardrails/blob/main/guardrails/guard.py),
[release/version metadata](https://pypi.org/project/guardrails-ai/0.11.0/).

## Guard lifecycle and privacy

Synchronous validation uses lazy, thread-local genuine Guards (one per validator
kind), never a process-shared Guard or result cache. Every call still runs
`Guard.validate(..., num_reasks=0)`; raw execution history is cleared in `finally`,
and a Guard that raises is discarded. Request metadata is never assigned to
persistent validator state. See [performance evidence and privacy tests](PERFORMANCE.md).
The local lifecycle benchmark does not replace the frozen full-runtime gate.
