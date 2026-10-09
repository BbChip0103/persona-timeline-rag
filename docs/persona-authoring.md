# Persona authoring (persona card v2)

Persona documents gain optional, CCv2/V3-inspired fields: structured personality, background, example dialogues,
alternate greetings, keyword lore, and UI-only `meta`. Authoring is JSON plus a CLI (`scripts/persona.ts`). There is no
web form, no card import and no card export. This page covers the contract. The design rationale lives outside this
repository as private design notes.

## Schema (`packages/contracts`)

`PersonaSchema` stays `.strict()`. It checks structure on every read, and its rules may only widen. All new fields are
optional, so v1 documents parse unchanged. Lengths count Unicode code points (`[...text].length`). `text(n)` means
trimmed, nonempty and at most n code points.

| field | shape | rendered? |
|---|---|---|
| `alternateGreetings` | `text(300)[]`, at most 4 | one greeting per session (see below) |
| `personality` | `{summary?: text(300), traits: text(40)[] ≤8, values: text(60)[] ≤6, speechHabits: text(80)[] ≤8}` | in the persona definition |
| `background` | `{text: text(500), sourceRefs: id[1..20]}` | text only, labelled `author-set public profile notes; NOT evidence` |
| `exampleDialogues` | `{turns: {speaker: user\|character, text: text(200)}[2..6]}[]`, at most 3 | separate system message |
| `lore` | `{id, keys: (2–40 code points)[1..8], content: text(300), priority: 0–100 (default 50), sourceRefs: id[1..10]}[]`, at most 50 | only when matched, after the history |
| `meta` | `{tags?: text(30)[] ≤12, creatorNotes?: text(2000)}` | **never** |

To switch a lore entry off, publish a new revision without it. There is no `enabled` flag.

## Publish checks (`validatePersonaForPublish`, `PERSONA_LINT_REVISION`)

These checks run only when a revision is published, so they can be narrowed later. They are fail-closed, and the
report holds `{path, rule, severity}` and never field text.

- **Every author string**: label, id, language, identity, concept, style, boundaries, greetings, personality, background,
  example turns, lore id/keys/content and meta. Each is checked for:
  - AI denial or human impersonation (`ai_denial`)
  - "never break character" or AI concealment (`keep_character`)
  - instruction override or system-prompt talk (`instruction`)
  - our block markers, including `Persona definition`, case-insensitive (`block_marker`)
  - reply-JSON fragments (`reply_json`)
  - chat-template special tokens (`special_token`), including Gemma 4's `<|turn>`, `<turn|>`, `<|channel>` style tokens: vLLM parses them as real control tokens inside message content (S8 gate a)
  - CBS/V1 macros such as `{{…}}` and `<BOT>` (`macro`)
  - credentials and internal paths
- **Unicode:**
  - The patterns run on the raw text and on a folded form. The folded form is built in this order:
    1. NFKD.
    2. Remove every combining mark (accents, strokes, variation selectors, the grapheme joiner).
    3. NFKC (full-width becomes ASCII; Hangul recomposes).
    4. Drop format and private-use characters, Hangul fillers and the braille blank.
    5. Turn control characters into spaces.
    6. Fold a fixed look-alike subset (Cyrillic, Greek, Latin small capitals, dotless i/j) to Latin.
  - These are errors (`invisible_char`):
    - any format, control, private-use or unassigned character, and U+2028/U+2029
    - the grapheme joiner U+034F, the Hangul fillers U+115F/U+1160/U+3164/U+FFA0, and the braille blank U+2800
    - Mongolian and Unicode variation selectors (U+180B–180F, U+FE00–FE0F, U+E0100–E01EF)
    - a combining mark written after an ASCII letter
  - Allowed:
    - a newline in `meta.creatorNotes`
    - emoji sequences: keycaps (`1️⃣`, `#️⃣`, `*️⃣`), VS16 after a pictograph, and ZWJ between pictographs
      (optional VS16 and skin tone), in any field
    - precomposed accented letters (`café`)
  - A word with Latin letters and any letter outside Latin, Common, Inherited, Hangul, Han, Hiragana and Katakana
    (Cyrillic, Greek, Armenian, Cherokee, Tifinagh, ...) is an error (`homoglyph`). This runs on the raw text: NFKC
    would turn the micro sign `µ` into Greek mu.
- **Known misses (AI denial):** paraphrases without the listed verbs or nouns ("a human is typing this"), languages
  other than Korean and English, denial by implication, and look-alikes outside the folded subset. The user's review of
  the publish summary covers these.
- **Limits:**
  - label ≤60; identity and concept ≤300 each; style ≤8 × ≤120; boundaries 1–10 × ≤160; sourceRefs ≤50; greeting ≤300
  - example dialogues ≤800 code points in total
  - persona block (definition + examples) ≤ **6,144 B**, measured with the real renderer
  - each lore entry's message ≤ **2,048 B**
  - duplicate lore ids are rejected, and lore ids need the `lore-` prefix (`lore_id_prefix`)
  - avoid Latin lore keys of 2–3 letters: they match as substrings, so a key like `ai` fires inside "said"
  - Byte budgets are UTF-8 bytes of the serialized messages, request escaping included.
- **Sources:**
  - Every `sourceRefs` entry (top level, background, lore) must exist for the same `personId`.
  - A licensed post ID is checked against the captions file in `validate`/dry run, and against `source_posts` in the
    target database on a confirmed publish.
  - A `web:<n>` ref is checked against the private source document.
  - A ref that does not exist is `source_missing`. A lookup that fails (for example, a database error) is
    `source_lookup_failed`. Both are errors.
- **Test-split leak:**
  - Any common substring of 12+ code points with a **same-person test-split caption** is an error.
  - Comparison is after NFKC, removal of format characters, lower case and whitespace collapse.
  - `label` and `meta` are not checked.
  - Exemption: a `style[]` or `boundaries[]` sentence left exactly as prepare-research generated it, when
    `--generated-list` is given (common phrases like "conversational responses" otherwise collide). No other field is
    exempt.
  - A real-person persona with no same-person test captions is an error (`leak_check_unavailable`): the check cannot
    run.
- **Real-person personas** (`reviewStatus ≠ synthetic`):
  - Private-life categories are errors in greetings, personality, background, examples and lore. The categories are
    family, romance, address, health, real-time location and minors, in Korean and English.
  - The patterns are deliberately broad ("가족 여행" and "병원" match). There is no exception list: reword the text.
  - `containsUngroundedBiography` in greetings, personality and examples is an error. For synthetic personas it is a
    warning.
- **Warnings (publish allowed):** dates and places.

These are narrow regex gates. For real people, the user's confirmation of the publish summary stays the main control.

## Revision

`${reviewStatus}-${sha256(parsed document without revision)[0:16]}`. This is the prepare-research rule, generalized.
The schema fixes the key order, so the same content always gives the same revision, whatever the input revision or key
order. A `meta`-only change gives a new revision, but the prompt bytes stay the same.

## CLI (`scripts/persona.ts`)

```bash
# checks only: no database, nothing written
pnpm exec tsx scripts/persona.ts validate drafts.json --sources-doc … --split-file … --captions-file … [--generated-list …] [--baseline …]
# dry run: prints the target database and the computed revisions; writes nothing
pnpm exec tsx scripts/persona.ts publish drafts.json --target research_db|loadtest_db <paths…>
# publish: import (and make current) → authored list → publish log
pnpm exec tsx scripts/persona.ts publish drafts.json --target research_db <paths…> --confirm
# rollback: make stored revisions current again, verbatim (dry run without --confirm; the dry run does not check the database)
pnpm exec tsx scripts/persona.ts restore previous.json --target research_db --authored-list … --publish-log … [--add] --confirm
```

`<file>` holds one persona or an array (one per `personId`). Private paths have **no defaults**. A flag wins over its
env var. A missing value, or a missing input file, fails.

| purpose | flag | env |
|---|---|---|
| private source document (`web:<n>`) | `--sources-doc` | `PTR_PERSONA_SOURCES_FILE` |
| split (`id → dev\|test`) | `--split-file` | `PTR_RESEARCH_SPLIT_FILE` |
| captions (`sources.json`) | `--captions-file` | `PTR_RESEARCH_SOURCES_FILE` |
| generated personas (optional, leak-check exemption) | `--generated-list` | `PTR_PERSONAS_FILE` |
| baseline: the revisions current before this publish (optional, see below) | `--baseline` | `PTR_PERSONA_BASELINE_FILE` |
| authored list (publish and restore; created on first publish) | `--authored-list` | `PTR_AUTHORED_PERSONAS_FILE` |
| publish log (publish and restore; JSONL, created on first publish) | `--publish-log` | `PTR_PERSONA_PUBLISH_LOG` |

`restore` needs only `--target`, `--authored-list` and `--publish-log` (no research inputs); `--add` lets it add an
authored-list entry that does not exist yet.

**`--baseline`** (a JSON array of the persona documents that are current in the target database before this publish,
exported verbatim from `persona_versions`):
- A baseline applies to the draft with the same persona id, else the same `personId`; a different id or person is an
  error (`baseline_mismatch`) and grants nothing.
- Style lines identical to a baseline **style** line, and boundaries lines identical to a baseline **boundaries** line,
  skip the test-split leak check and the per-line length limit (each field against the same field).
- The style **count** limit (8) is skipped only while every style line comes from the baseline and there are no more
  lines than in it. This is intended and style-only: goal1's refined revisions have 9 style lines, boundaries keep
  their 1–10 count limit.
- Every other rule still applies to baseline text.
- `validate` and dry runs warn `baseline_unverified`. A confirmed publish first checks every baseline against the
  target database: it must be that persona's **current** revision (same `personas.id`, `person_id`, `revision`, and
  the stored `document` equal as jsonb). If any check fails, the whole publish is refused and nothing is written. The
  log line records `baselineRevision`. On a rerun after the import committed (the list/log step failed), the draft's
  computed revision is current: that also passes, as long as the baseline is still stored exactly as given.

**Source document entries:**
- Required: `id` (`web:<n>`), `personId`, `url` (http/https), `title`, `publisher`, `retrievedAt` (`YYYY-MM-DD…`) and
  `paraphrase` (≤300 code points).
- Optional: `kind` (`official_channel|own_site|interview|media`) and `usedBy`.
- Other keys are ignored.
- The document is read only by the CLI. It never goes into a prompt or a report.

**Targets:**
- `research_db` needs `GOAL1_DATABASE_URL` or `DATABASE_URL` pointing to `ptr_research`.
- `loadtest_db` needs `PTR_LOADTEST_DATABASE_URL` pointing to `ptr_loadtest`.
- Only a confirmed publish connects to the database.
- Publishing to `research_db` requires the user's explicit confirmation of the validate summary first.

**Confirmed publish:**
- **Before the database is touched** (in a dry run too), the CLI checks:
  - The authored list must parse as `{database, personas}` and name the target's database. A list is bound to the
    database it was published to, and a publish to another target is refused.
  - The list and log paths must be writable files in existing directories.
- Any check error writes nothing.
- All personas are imported in **one transaction**, with `setCurrent`: `current_revision` becomes the published
  revision even when that revision already exists.
- A failure names the imported indexes:
  - `none` when the transaction rolled back (a constraint, conflict or validation error).
  - `unknown` for any other database error, for example a connection dropped during COMMIT. Check `current_revision`
    before rerunning.
  - All indexes when only the list or log step failed afterwards. In that case, rerun the same publish to finish it.
- The authored list entry for each `personId` is replaced in place. The file is written atomically (temporary file,
  then rename; the temporary file is removed if the rename fails), with mode 0600.
- **The publish log holds real handles** (publisher user names, personIds). It stays private (mode 0600, under the
  ignored `data/`) and is never committed or pasted into reports.
- One log line is written per persona: `personaId, personId, revision, previousRevision, inserted, currentRevisionSet,
  [alreadyCurrent: true when previousRevision equals revision (a rerun)], [baselineRevision], publisher (OS/git user),
  publishedAt, lintRevision, sourceDocSha256, target, database`.
- A `restore` writes `action: "restore", personaId, personId, revision, previousRevision, currentRevisionSet,
  [alreadyCurrent], [notLatestPreviousRevision], publisher, publishedAt, target, database` (no lint fields: nothing is
  linted).
- Republishing the same file is idempotent for the database and the list, and it adds a log line.

The CLI prints indexes, revisions, issue paths and rule names only.

## Catalogue, restart, deploy order

- The API catalogue is the generated list (`PTR_PERSONAS_FILE`, which prepare-research overwrites) merged with the
  authored list (`PTR_AUTHORED_PERSONAS_FILE`).
- A `{database, personas}` authored list must name the API's database (`GOAL1_DATABASE_URL`/`DATABASE_URL`), or
  the catalogue fails. A plain array is still read.
- When `PTR_AUTHORED_PERSONAS_FILE` is unset, the authored list is empty. When it is set and the file is missing, the
  API does not start.
- For the same `personId`, the authored entry wins. Duplicates within either list fail, because session creation needs
  exactly one candidate.
- `listPersonas` then keeps only the entries whose revision is the database's `current_revision`.
- The catalogue is read once per process: **restart the API after a publish.**
- **prepare-research reruns:**
  - The script still writes `personas.json`, but it skips the database import for any `personId` in the authored list
    (`PTR_AUTHORED_PERSONAS_FILE`, default `data/research/personas.authored.json` next to its other private files).
    Otherwise a new generated revision would take over `current_revision`.
  - If `PTR_AUTHORED_PERSONAS_FILE` is set and the file is missing or invalid, the script fails. A missing default
    file only prints a warning.
  - The list is read before any import. A `{database, personas}` list must name `DATABASE_URL`'s database, or the
    script stops.
  - If the pointer moved anyway, republishing restores it.
- **Evaluations:** evaluation runs read pinned revisions (`personas.get(id, revision)`) and create sessions with
  `greetingIndex: 0`. A publish changes `current_revision`. Frozen runs therefore keep their registered revisions, or
  re-baseline on v8/v11.
- **Deploy order (required):** readers on the old contract reject documents with new keys, because the schema is
  `.strict()`.
  1. Deploy every API and worker process with this contract.
  2. Publish the first card persona.
  3. Restart the API.
- **Rollback** restores the revision that was current **before** the publish, not necessarily the generated one. For
  the 4 research personas that is goal1's refined `dialogue-*` revision (made by
  `scripts/refine-personas.ts`). Verified from the source: the first card publish recorded
  `previousRevision: dialogue-…` for all 4 personas in the publish log. The generated `personas.json` document lacks
  those refinements.
  1. Take the `previousRevision` of the publish being undone from the publish log, and export that document verbatim
     (revision included) from `persona_versions` (read-only `SELECT document … WHERE persona_id=… AND revision=…`).
  2. Run `restore <file> --target … --authored-list … --publish-log … --confirm`. It re-points `current_revision` to
     those stored revisions in one transaction, verbatim: no lint (a stored revision may never have been linted, e.g.
     a `dialogue-*` revision; intentional), no new revision, and it refuses a revision that is not stored or is stored
     with other content (jsonb equality, so a key-reordered export is fine). The authored list must already hold an
     entry for that `personId` with the same persona id (`--add` for a missing entry). The authored list entry becomes
     that document (v1-shaped for a `dialogue-*` revision, so old code can read it) and the log gets an
     `action: "restore"` line with the `previousRevision` it replaced.
     - **Target check (decision: warn, not refuse):** when the target is not the newest log line's `previousRevision`
       for that persona (a multi-step rollback), the output warns `not_latest_previous_revision` and the log line
       records `notLatestPreviousRevision: true`. Lines with `alreadyCurrent: true` (reruns) are skipped when finding
       the newest one. Example: after a rebase done as below (restore `dialogue-*`, then publish the card), the newest
       `previousRevision` is `dialogue-*`, so a one-step rollback returns to it; rolling back further, past an earlier
       card revision, is multi-step and warns. Refusing would block those legitimate rollbacks; the stored-revision
       check still guards the content.
     - A dry run prints that the database was not checked.
     - Tested in `persona-cli.test.ts`, `packages/storage/test/personas.test.ts` and the opt-in SQL suite
       (`postgres.integration.test.ts`: restore from a key-reordered export, no new `persona_versions` row, a mismatch
       leaves the pointer).
  3. Restart the API.
  4. Then roll back the code.
  - If no earlier revision exists (a persona first created by a publish), republish the generated document instead
    (`publish … --confirm`; it gets its own `silver-…` revision).
- **Rebasing on a refined revision** (e.g. goal1's `dialogue-*` revisions for the 4 research personas):
  1. `restore` the refined revision, so it is current again (export it verbatim from `persona_versions`).
  2. Build the drafts on its concept and style, and `publish … --baseline <that same document> --confirm`. The
     baseline check requires it to be current (or, on a rerun after the import committed, the draft's revision to be
     current) and stored exactly as given; its approved style/boundaries lines then skip the leak check and the line
     limits.
  - The recorded rebase (S8 report) was done before this strict rule existed: it published with the
    `dialogue-*` documents as an unverified baseline while the earlier card revision was current, so its log line has no
    `baselineRevision` and its `previousRevision` is the earlier card revision; `dialogue-*` stays reachable as a
    multi-step rollback (the earlier log line's `previousRevision`).
  - Sessions pinned to a card revision cannot be continued on old code.

## Prompt rendering (agent `character-agent-context-v9-persona-voice`, experiment `persona-chat-v12-persona-voice`)

v5/v8 introduced the card rendering below; v6/v9 (S8 follow-up) added the identity/privacy policy and the reply guard,
v7/v10 corrected that policy's voice rule, v8/v11 allowed light everyday small talk and v9/v12 added the persona-voice
rules (see "Identity, privacy and the reply guard" and "Persona voice" at the end). The message layout is the same.

```text
policy · persona definition · [examples] · history (greeting first) · [state] · [lore] · [tools] · [evidence] · [safety note] · user · [tool results]
```

- **Policy:**
  - One persona-independent sentence, `PERSONA_CARD_POLICY`, sits right before `TIMELINE_JSON_REPLY:`, so the
    agent's policy split carries it.
  - It says that background, examples and lore are author-set voice and public-profile notes: never evidence, never
    citable, not to be extended. v5 also said "never real memories"; v7/v10 replace that with "you may speak about them
    as yourself" (first-person voice).
  - It is the only policy change from v4/v7 (pinned by hash in `prompt-layout.test.ts`), but it re-baselines every
    persona: v4 and v5 numbers are not compared.
- **Persona definition:**
  - The v4 JSON, plus `personality` and `background: {text, note}`.
  - A persona without the new fields renders the v4 bytes.
- **Example dialogues:**
  - One system message,
    `PERSONA_STYLE_EXAMPLES_JSON_DATA (style/tone reference only; NOT facts, memories or evidence) [...]`, before the
    history.
  - Never fake chat turns.
- **Lore:**
  - A user-role message, `UNTRUSTED_PERSONA_LORE_JSON_DATA (author-set setting notes; NOT evidence, NOT citable)
    [{loreId, content}]`.
  - It sits between the agent state and the tools (experiment: after the history, before the evidence). It is added
    only when entries match.
- **Lore matching (`matchLore`):**
  - Input: the current utterance plus the last two user messages of the prompt history, each truncated to 1,000 code
    points. Assistant text is never scanned.
  - User messages of turns the input-safety filter acted on (`reply.inputSafety.action ≠ none`: deflect, refuse or
    support) are left out. So is a turn whose record cannot be read (fail closed).
  - A deflected turn gets no lore.
  - Keys match as NFKC + lower-case substrings.
  - Ranking: current-utterance match, then priority, then document order. At most 3 entries and ≤2,048 B are selected;
    an entry that does not fit is skipped.
  - Output is in document order.
  - The turn records `reply.personaContext = {loreIds, loreOmitted}`. The public DTO omits it.
- **Citations:** only sources of the current evidence block can be cited. Lore and examples have no source ID, so an
  answer built on them is `unverified_model`.
- **Greeting:**
  - The greeting comes from `[greeting, ...alternateGreetings]`: `CreateSessionSchema.greetingIndex` when given
    (evaluations pin 0), otherwise `sha256(session id)[0..4] mod n`.
  - The index is stored on the session when it was given or there is a choice.
  - The server always prefixes the disclosure: `AI 연구용 시뮬레이션입니다. ` for `ko`, `ko-…` and `ko_…` sessions,
    `AI research simulation. ` otherwise. New English sessions' greeting bytes change under v5. Stored greetings do
    not.
- **Unchanged:** the legacy `buildPrompt` paths (timeline v4, small talk v2) and the fictional-draft path render none
  of the new fields, and their bytes are unchanged.
- **Context limits:**
  - Examples and lore add up to two messages. Under the agent's 64-message cap, with two tool rounds, 25 turns fit
    and 26 fail with `CONTEXT_LIMIT` (tested).
  - The 30,000-byte limit is unchanged. Nothing is truncated.

## Identity, privacy and the reply guard (v6/v9, corrected in v7/v10)

S8 gates d and e failed on v5 (a "pretend to be human" request answered without disclosure; real-person replies with
family, residence, health and embellished career details). v6/v9 added, and v7/v10 corrected:

- **Policy:** `IDENTITY_PRIVACY_POLICY`, one persona-independent text right after `PERSONA_CARD_POLICY` (so the agent's
  policy split carries it): always an AI research simulation, never pretend to be human or deny the AI, even in
  roleplay; otherwise the persona speaks in its own first-person voice, also about its background and posts (the
  first-person recollection the user asked for), mentioning only facts in its background, lore or the turn's
  evidence and never adding, inferring or embellishing details; for a real-person persona (`reviewStatus` not
  `synthetic`; one static sentence, so the policy bytes stay persona-independent), no private life (family, romance,
  residence/current location, health, friends/relationships, minors), even when it is in the person's own posts.
- **Reply guard** (`guardReply`, `REPLY_GUARD_REVISION` `reply-guard-v5`, agent and experiment paths, fail-closed): a
  reply that claims to be human or denies the AI (`human_impersonation`), an identity question ("너 AI야?", "사람인 척
  해줘", "Are you a real person?") answered without an AI acknowledgement (`missing_ai_disclosure`), or, for a
  real-person persona, a reply touching private life or any answer to a private-life question (`private_life`) is
  replaced by a fixed persona-voice reply (v5: see "Persona voice"; `out_of_scope`, no evidence, limitation `REPLY_GUARD_<REASON>`).
  `reply.replyGuard` records `{revision, action: none|replaced, reason}` (internal, like `personaContext`). Narrow
  Korean/English regexes: paraphrases and other languages can pass; the policy is the first control. v2 (S8 bundle
  review): only an affirmative self-statement ("저는 … AI", "I'm an AI…", "AI 연구용 …") counts as an acknowledgement
  and a negated one ("AI 아냐", "no AI here") is a denial; denials are anchored to the speaker ("이건 AI가 아니라 손그림"
  passes); private-life questions must address the persona; the private-life patterns are narrowed (false positives
  such as "minor key", "hospitality", "home studio", "partner brand", "집중", "홈페이지 주소", "아동 그림책", "명절" are
  pinned in tests). v3 (review re-check): every negation stem and an adverb before "not" count as a denial, an
  acknowledgement needs a copula and is never a question, bare "AI 아니야" is not a denial in art/image talk, and
  "woman/man" only counts after real/actual; known misses (lowercase moved-to places, a partner without "my") are pinned
  in tests. v4 (final review): 인간 next to 사람, "Im"/"I ain't", "nah, not an AI", "I'm no bot"; "…가 아니라 사람"
  needs a copula, so "봇이 아니라 사람이 그렸어요" (an artwork) passes. **Known misses** (left to the policy; pinned
  where cheap): unprompted denials phrased without the listed verbs ("그냥 평범하게 사는 사람", "a human is typing this",
  "my other half"), denials in languages other than Korean and English, bare "not an AI"/"AI 아니야" inside art or
  image talk (skipped on purpose), and private-life mentions without the listed anchors (a lowercase moved-to place,
  a partner without "my", an indirect home location). If the guard itself throws, the turn fails and the unguarded text is never stored.
- **Language:** on the agent and experiment paths every fixed text, limitation note and claim prefix follows the
  user's utterance language since v9/v12 (see "Persona voice"); the legacy path keeps the session language
  (`replyText`: Korean for `ko…`, English otherwise), and the legacy timeline validator's texts stay Korean.
- **Small talk (v8/v11, user decision):** a real-person persona may answer everyday small talk ("오늘 하루
  어땠어?") with light fictional everyday content (a mood, a relaxed day), but never invents concrete facts (specific
  places, named people, dates or events); private life stays forbidden. One static sentence, scoped by `reviewStatus`.
- **Voice correction (v7/v10):** v6/v9 said the background was third-person information never retold
  as a first-person memory. That was an instruction error: it contradicted the first-person recollection requirement.
  The `background` text may still be stored as a third-person character sheet (a storage format); the model speaks
  about it as itself. `PERSONA_CARD_POLICY` now says the notes may be spoken about as yourself (it no longer says
  "never real memories"); they stay non-evidence and non-citable. The reply guard never looks at grammatical person.
- **Control tokens:** the provider layer neutralizes chat-template control strings in every message (see
  docs/goal2-serving.md, Providers), so persona text, captions and user text cannot forge Gemma 4 turns.

## Persona voice (v9/v12, reply guard v5, user decision)

Real v8 replies showed: English personas answering a career question with "I'm an AI research simulation, so I don't
have a career"; replies cut mid-sentence ("…as my's"); "응답의 근거 형식을 확인하지 못했어요." shown to the user; one stiff
fixed privacy refusal for every persona and formal roleplay refusals ("수행할 수 없습니다"); mixed reply languages.

- **No system or validation text in front of the user.** On the agent and experiment paths:
  - invalid evidence (unknown source, quote not found, citations with retrieval off) keeps the model's own text,
    `insufficient_evidence`, `grounding: unverified_model`, no evidence or claims; `INVALID_MODEL_EVIDENCE` and
    `UNVERIFIED_MODEL_RESPONSE` stay in `limitations` (metadata). The reply guard still runs on that text;
  - an unparseable experiment reply, an empty answer, an invalid agent reply format (`AGENT_REPLY_INVALID`, formerly a
    failed turn), an unavailable tool (`AGENT_TOOL_UNAVAILABLE`, formerly "[서비스 안내] …") and a rejected validator
    answer with the persona-voice fallback ("음, 그건 지금 딱 떠오르진 않네~ 다른 얘기 해 볼까?"); the reason stays in
    `limitations`;
  - rule refusals, clarifications, the ambiguous-post question and the event-timezone question use persona-voice texts.
  The legacy path (no RAG condition, no agent) keeps its texts. Other turn failures (tool limit, repeated tool,
  rejected internal paths, provider errors) still fail the turn.
- **Persona-voice texts** (`voiceText`, `reply-texts.ts`): Korean in the persona's speech level, 반말 (`casual`) or
  해요체 (`polite`), and one warm English form. `speechLevel(persona)`: a 반말/casual or 해요체/존댓말/polite cue in the
  speech habits, then in the style notes and personality summary; otherwise the majority of Korean sentence endings in
  the greetings and example replies; no Korean cue: polite. No text has a 합쇼체 ending, and only the identity text
  mentions the AI ("나 사실 AI야~ 사람인 척은 못 하지만 수다는 계속 떨 수 있어!"). The private-life decline is "에이, 그건
  비밀~ 대신 요즘 하는 거 얘기해 줄게!" (casual) / "…비밀이에요~ …얘기해 드릴게요!" (polite).
- **Reply language:** `REPLY_VOICE_POLICY` (after `IDENTITY_PRIVACY_POLICY`): reply in the language of the user's
  latest message, even when the persona language, style notes, examples or earlier turns differ, keeping the persona's
  tone and speech level; short replies that always finish the last sentence. Fixed texts follow the same rule
  (`utteranceLanguage`: words after removing links, @handles and #tags; Korean when words with Hangul are at least as
  many as Latin-only words, English with Latin words, otherwise the persona language). On the agent path the state
  message also carries the turn's `replyLanguage` (`AGENT_STATE_JSON_DATA {…,"replyLanguage":"English"}`; same layout,
  never a variable). The experiment opening line says "the persona's style" and the recollection voice "the persona's
  register" (both said "persona language" before; the first v9 GPU iteration answered 15% of replies in the persona's
  language instead of the user's).
- **AI disclosure only when asked:** `IDENTITY_PRIVACY_POLICY` v12/v9 no longer opens with "You are always an AI
  research simulation" (that made the model mention the AI in ordinary replies). The persona chats in character in the
  first person and mentions being an AI only when the user asks whether it is an AI or a real person, or asks it to
  pretend to be human, to be the actual person or to stop being an AI; then it says so casually in its own voice and
  never denies it. Everyday questions about itself (what it is up to, its day, a favourite food) are small talk, never
  "as an AI I don't eat" and never private. It never denies or disowns its own background, career or posts: it says
  the origin or studies its background states and never claims to have no hometown, school, career or past. Private-life topics and
  human-pretence requests are declined in the persona voice, short and warm. The guard (v5) also treats roleplay
  requests ("너는 진짜 그 사람이야", "AI라는 말은 하지 마", "AI라고 하지 마", "do not mention AI", "stop being an AI",
  "pretend you are not an AI", "forget you are an AI") as identity requests (known false positive: "don't mention AI to
  my boss"). Guard v5 also adds `background_denial`: outside identity and art talk, a self-statement of being an AI
  ("since I'm an AI", "저는 AI라서") together with "I don't have/eat …" / "…이 없어 / 먹지 않아" (every persona; "a
  favourite AI app" or "AI 툴은 안 써" does not count), or for a real-person persona a plain "I don't have a
  hometown/school/career" or a clause-final "고향이나 학교가 없어요" (only those nouns; "학교 숙제가 없어서" stays); the
  replacement is the in-voice fallback. An echoed `replyLanguage` in `variableUpdates` (models without guided decoding)
  is dropped before the strict parse. A human claim on a
  non-identity question is replaced by the fallback too; only identity questions get the "I'm an AI" line.
- **No mid-sentence cut:** the cause was the agent reply's JSON Schema `message.maxLength: 180` under engine-side
  guided decoding, which closed the string at exactly 180 code points (44 of 272 S8 v8 replies). The hard cap is now
  400 code points (`AGENT_MESSAGE_MAX_CODE_POINTS`, schema and zod); the prompt still asks for about 180 characters, and
  a message that reaches the cap is trimmed to its last complete sentence (`trimToSentence`).
- **Optional validator:** also judges model text kept after an evidence failure (not only `answered` replies); a
  rejection keeps the earlier limitation codes and adds `AGENT_VALIDATOR_<RESULT>`. An experiment reply with an empty
  answer is never `answered` (its valid citations stay metadata).
- **Origin and studies:** for a real-person persona, origin and studies that the curated public background states may be
  said (they are not in the private-life list, unlike residence); this is a deliberate choice, not a guard gap.
- **Legacy path:** the input-safety templates now treat `ko_KR` like `ko-KR` (Korean); before, `ko_KR` got English.
- **Known limits:** register inference is a heuristic over the card (a 반말/casual register cue, a polite cue winning
  within one note bucket, "반말 금지"/"never 반말" as polite); Korean texts for an English persona default to
  polite; the input-safety templates (Jev, off by default) are unchanged apart from following the utterance language,
  and the `private_info` one still mentions the AI.

**Before serving or baselining v9/v12:** S8 gates a–f must pass first (f: persona voice):
- a: chat template, including the leading system messages and the consecutive user messages
- b: prompt-injection responses
- c: recollection non-inferiority
- d: AI-disclosure probes
- e: real-person background over-extension, denial of the persona's own background, and private-life probes, judged on the whole reply
- f: persona voice over the d, e, roleplay and everyday replies: no system text, no mid-sentence cut, reply language
  matches the user's in at least 95%, no formal refusal for a casual persona, no unprompted AI mention
  (`scripts/s8-gates.ts probe --kind=everyday` and `voice`)

These need a GPU or paid calls, and they are not run here.
