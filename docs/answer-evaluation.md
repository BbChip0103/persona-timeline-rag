# Offline answer regrading

Forward character-chat comparison fixes `agent_loop` and varies only `off`,
`caption`, and `caption_image`. Archived answers can be regraded without making
new chatbot, embedding, or external judge API requests.

## Reference and review boundary

Prepare source-first references from original captions and original images,
not from generated image descriptions or chatbot answers. A Codex-reviewed
reference is **silver, human review pending**, even if original photos were
viewed. Freeze the reference before grading; preserve its content hash. Grading
previously seen answers is a post-hoc development regression, not a blinded
holdout or measured human-gold accuracy.

Keep reference, original-data inspection, exact offered-evidence packets,
claim-level review, and summaries under ignored `reports/answer-regrading/`
with private permissions. Public tests use only synthetic fixtures.

`regrade-character-answers.ts` validates supplied review coverage, reference and
archived-report hashes, immutable answer/question/person binding, required fact
IDs, and rubric consistency. **It is an aggregator, not a semantic judge**:
passing validation does not prove that AI reference or claim judgements are
correct. Review disagreements need adjudication, not automatic rewriting of the
reference to favor an answer.

## Separate outcomes

- Factual questions: core verdict, required fact coverage, and clean answers
  without materially unsupported extra claims. Same question denominator for
  every condition; abstaining on an answerable question is not a correct answer.
- Material claims: original-source/reference support versus the evidence
  actually offered to the chatbot. An original-image fact can be true but absent
  from the offered caption/annotation. Grounding and correctness differ.
- No-RAG: offered-context faithfulness is N/A, not zero or a perfect score.
  No-claim answers also have no claim fraction; abstentions are tracked separately.
- Interpretive and creative questions: distinct rubrics, not factual truth
  scores. General atmosphere or fictional preferences are not actual intentions
  or real events. Multi-turn continuity and naturalness remain separate.
- Operational fallback/failure: no factual success, no invented accepted claims;
  remains in the planned denominator. Never silently remove poor observations.

## Explicit local execution

After producing private reference/review artifacts matching the exported schemas:

```sh
node -r tsx/cjs scripts/regrade-character-answers.ts --offline \
  reports/answer-regrading/reference.private.json \
  reports/answer-regrading/review.private.json \
  reports/agent-reevaluation/<archived-run>/report.json
```

The command reads local files and writes `summary.private.json`; it never imports
or opens a provider client, `.env`, or database connection. Codex assessment
usage still consumes coding-agent tokens and must be recorded separately from
chatbot/provider invoice cost. Human verification and unseen three-condition
experiments remain separate steps.
