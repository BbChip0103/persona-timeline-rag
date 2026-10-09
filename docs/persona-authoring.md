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
pnpm exec tsx scripts/persona.ts validate drafts.json --sources-doc … --split-file … --captions-file … [--generated-list …]
# dry run: prints the target database and the computed revisions; writes nothing
pnpm exec tsx scripts/persona.ts publish drafts.json --target research_db|loadtest_db <paths…>
# publish: import (and make current) → authored list → publish log
pnpm exec tsx scripts/persona.ts publish drafts.json --target research_db <paths…> --confirm
```

`<file>` holds one persona or an array (one per `personId`). Private paths have **no defaults**. A flag wins over its
env var. A missing value, or a missing input file, fails.

| purpose | flag | env |
|---|---|---|
| private source document (`web:<n>`) | `--sources-doc` | `PTR_PERSONA_SOURCES_FILE` |
| split (`id → dev\|test`) | `--split-file` | `PTR_RESEARCH_SPLIT_FILE` |
| captions (`sources.json`) | `--captions-file` | `PTR_RESEARCH_SOURCES_FILE` |
| generated personas (optional, leak-check exemption) | `--generated-list` | `PTR_PERSONAS_FILE` |
| authored list (publish; created on first publish) | `--authored-list` | `PTR_AUTHORED_PERSONAS_FILE` |
| publish log (publish; JSONL, created on first publish) | `--publish-log` | `PTR_PERSONA_PUBLISH_LOG` |

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
  publisher (OS/git user), publishedAt, lintRevision, sourceDocSha256, target, database`.
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
- **Rollback:**
  1. Restore the generated revision as current by republishing the generated document. That is the entry for this
     `personId` in `personas.json`, run through `publish … --confirm` to the same target. The revision rule is the same,
     so it republishes as its own `silver-…` revision with `setCurrent`. The authored list entry becomes that v1-shaped
     document, which old code can read. This is tested in `persona-cli.test.ts`.
  2. Restart the API.
  3. Then roll back the code.
  - Sessions pinned to a card revision cannot be continued on old code.

## Prompt rendering (agent `character-agent-context-v8-small-talk`, experiment `persona-chat-v11-small-talk`)

v5/v8 introduced the card rendering below; v6/v9 (S8 follow-up) added the identity/privacy policy and the reply guard,
v7/v10 corrected that policy's voice rule and v8/v11 allowed light everyday small talk (see "Identity, privacy and the reply guard" at the end). The message
layout is the same.

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
- **Reply guard** (`guardReply`, `REPLY_GUARD_REVISION` `reply-guard-v4`, agent and experiment paths, fail-closed): a
  reply that claims to be human or denies the AI (`human_impersonation`), an identity question ("너 AI야?", "사람인 척
  해줘", "Are you a real person?") answered without an AI acknowledgement (`missing_ai_disclosure`), or, for a
  real-person persona, a reply touching private life or any answer to a private-life question (`private_life`) is
  replaced by a fixed reply in the session language (`out_of_scope`, no evidence, limitation `REPLY_GUARD_<REASON>`).
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
- **Language:** deterministic texts (rule refusal, clarifications, retrieval off, validator, tool notice, invalid
  evidence, and the experiment validator's limitation notes and claim prefixes) follow the session language (`replyText`: Korean for `ko…`, English otherwise). The legacy timeline
  validator's texts stay Korean.
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

**Before serving or baselining v8/v11:** S8 gates a–e must pass first:
- a: chat template, including the leading system messages and the consecutive user messages
- b: prompt-injection responses
- c: recollection non-inferiority
- d: AI-disclosure probes
- e: real-person background over-extension and private-life probes, judged on the whole reply

These need a GPU or paid calls, and they are not run here.
