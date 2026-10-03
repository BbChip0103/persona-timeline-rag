import type { Persona, SourcePost } from '@ptr/contracts';
import type { AnnotationPlan } from '../import-image-annotations';
import type { EvaluationInput, TurnTrace } from '../evaluate';
import { CONDITIONS, annotationContentHashes, experimentRevision, validateCorpus, type CorpusRow, ExperimentSchema, prepareExperiment, summarizeRows, validateExperimentGold, type ExperimentRow } from '../evaluate-image-rag';

function fixture() {
  const personas: Persona[] = []; const sources: SourcePost[] = []; const records: unknown[] = [];
  const split: Record<string, string> = {}; const seedCases: EvaluationInput['cases'] = [];
  const plan: AnnotationPlan = { annotations: [], inputs: [], skippedUnsafe: 0, skippedOversize: 0 };
  for (let person = 0; person < 4; person++) {
    const id = `synthetic-person-${person}`;
    const persona: Persona = { id: `synthetic-persona-${person}`, personId: id, label: 'Synthetic', language: person < 2 ? 'ko' : 'en', revision: 'fixture-v1', reviewStatus: 'synthetic',
      identity: 'Synthetic research fixture', concept: 'Creative fixture', style: [], boundaries: [], sourceRefs: [], greeting: 'Hello fixture' };
    personas.push(persona);
    for (let index = 0; index < 5; index++) {
      const source: SourcePost = { id: `${id}-post-${index}`, personId: id, caption: 'Synthetic caption only.', postedAt: `2018-01-0${index + 1}T12:00:00Z`, eventDate: null,
        sourceUrl: 'https://example.invalid/synthetic', hash: 'f'.repeat(64), snapshot: 'synthetic-v1', unsafe: false };
      sources.push(source); split[source.id] = 'test'; const imageHash = String(index + 1).repeat(64);
      records.push({ visual: { description_ko: '합성 관찰 설명이다.', observed_emphasis: { main_subjects: ['합성 소품'] } }, source: { sha256: imageHash, associations: [{ source_id: source.id }] } });
      plan.annotations.push({ id: `${source.id}-annotation`, sourceId: source.id, personId: id, sourceHash: source.hash, imagePosition: 0, imageHash,
        annotationHash: 'a'.repeat(64), revision: 'synthetic-style-v1', text: 'Synthetic visible object.', model: 'synthetic/model', humanReviewed: false });
      plan.inputs.push({sourceId:source.id,revision:'synthetic-style-v1',text:source.caption+' Synthetic visible object.'});
      if (index < 2) seedCases.push({ id: `${source.id}-case`, personId: id, personaId: persona.id, personaRevision: persona.revision, timezone: 'UTC', text: 'Synthetic caption question?',
        timeline: { query: 'Synthetic', dateBasis: 'posted', limit: 5 }, category: 'caption_supported', split: 'test', splitProxy: 'person_posted_day', goldSourceIds: [source.id] });
    }
  }
  const seed = { cases: seedCases } as EvaluationInput;
  return { personas, sources, records, split, seed, plan };
}
describe('three-condition controlled image experiment', () => {
  it('freezes 24 silver cases and same-person evolving scenarios before responses', () => {
    const f = fixture(); const input = prepareExperiment(f.personas, f.sources, f.split, f.seed, f.records, f.plan, 'source-file-hash', 'image-file-hash');
    validateExperimentGold(input, f.sources, f.plan);
    expect(input.cases).toHaveLength(24); expect(input.scenarios).toHaveLength(4); expect(CONDITIONS).toEqual(['off', 'caption', 'caption_image']);
    expect(input.cases.filter(item => item.category === 'image')).toHaveLength(8);
    expect(input.cases.filter(item => item.category === 'image' && item.timeline.start)).toHaveLength(4);
    expect(input.cases.filter(item => item.category === 'negative').every(item => item.goldSourceIds.length === 0 && item.timeline.start === '2099-01-01')).toBe(true);
    expect(input.cases.filter(item => item.category === 'image' || item.category === 'both').every(item => item.goldAnnotationIds.length === 1)).toBe(true);
    const repeat = prepareExperiment(f.personas, f.sources, f.split, f.seed, f.records, f.plan, 'source-file-hash', 'image-file-hash');
    expect(repeat.revision).toBe(input.revision);
  });
  it('rejects unsafe, cross-person, wrong-parent and empty image gold', () => {
    const f = fixture(); const input = prepareExperiment(f.personas, f.sources, f.split, f.seed, f.records, f.plan, 's', 'i');
    const image = input.cases.find(item => item.category === 'image')!;
    const parent = f.sources.find(item => item.id === image.goldSourceIds[0])!;
    parent.unsafe = true; expect(() => validateExperimentGold(input, f.sources, f.plan)).toThrow(); parent.unsafe = false;
    parent.personId = 'wrong-person'; expect(() => validateExperimentGold(input, f.sources, f.plan)).toThrow(); parent.personId = image.personId;
    image.goldAnnotationIds = [f.plan.annotations.find(item => item.personId !== image.personId)!.id]; expect(() => validateExperimentGold(input, f.sources, f.plan)).toThrow();
    image.goldAnnotationIds = []; expect(() => validateExperimentGold(input, f.sources, f.plan)).toThrow();
  });
  it('rejects duplicated cases or cross-person history even with valid category counts', () => {
    const f = fixture(); const input = prepareExperiment(f.personas, f.sources, f.split, f.seed, f.records, f.plan, 's', 'i');
    const copy = structuredClone(input); copy.cases[1]!.id = copy.cases[0]!.id; expect(ExperimentSchema.safeParse(copy).success).toBe(false);
    const history = structuredClone(input); history.scenarios[0]!.caseIds[0] = input.cases.find(item => item.personId !== history.scenarios[0]!.personId)!.id;
    expect(ExperimentSchema.safeParse(history).success).toBe(false);
  });
  it('does not report absent off retrieval as 0% recall or unverified answers as grounded', () => {
    const trace = { state: 'completed', errors: [], textCalls: 1, embeddingCalls: 0, retrievalCalls: 0, sourceRecallAt5: null, requests: [], latencyMs: 5 } as unknown as TurnTrace;
    const rows: ExperimentRow[] = [{ caseId: 'synthetic-case', personId: 'synthetic-person', condition: 'off', history: 'single', category: 'image', trace, annotationGoldHit: false,
      reply: { status: 'answered', grounding: 'unverified_model', evidence: [], limitations: [] } as unknown as ExperimentRow['reply'] }];
    const summary = summarizeRows(rows) as Record<string, Record<string, unknown>>;
    expect(summary.off?.recallAt5).toBeNull(); expect(summary.off?.unverifiedAnswers).toBe(1); expect(summary.off?.groundedQuoteAnswers).toBe(0);
    expect(summary.off?.embeddingCalls).toBe(0); expect(summary.off?.retrievalCalls).toBe(0);
  });
  it('counts malformed model evidence separately from transport failures and reports negatives',()=>{
    const trace={state:'completed',errors:[],textCalls:1,embeddingCalls:1,retrievalCalls:1,sourceRecallAt5:null,requests:[],latencyMs:5} as unknown as TurnTrace;
    const rows:ExperimentRow[]=[{caseId:'synthetic-invalid',personId:'synthetic-person',condition:'caption',history:'single',category:'negative',trace,annotationGoldHit:false,
      reply:{status:'insufficient_evidence',grounding:'unverified_model',evidence:[],limitations:['INVALID_MODEL_EVIDENCE']} as unknown as ExperimentRow['reply']}];
    const summary=summarizeRows(rows) as Record<string,Record<string,unknown>>;
    expect(summary.caption?.errors).toBe(0);expect(summary.caption?.invalidModelEvidence).toBe(1);
    expect((summary.caption?.byCategory as Record<string,Record<string,unknown>>).negative?.invalidModelEvidence).toBe(1);
  });
});

test('frozen revision ignores object key order but rejects edited questions and scenarios',()=>{
  const f=fixture();const input=prepareExperiment(f.personas,f.sources,f.split,f.seed,f.records,f.plan,'s','i');
  const reorder={...input,cases:input.cases.map(item=>Object.fromEntries(Object.entries(item).reverse()))} as typeof input;
  expect(experimentRevision({...input,cases:input.cases.map(item=>({...item,text:item.text}))})).toBe(input.revision);
  expect(experimentRevision(reorder)).toBe(input.revision);
  input.cases[0]!.text+=' changed';expect(()=>validateExperimentGold(input,f.sources,f.plan)).toThrow('revision changed');
  input.revision=experimentRevision(input);validateExperimentGold(input,f.sources,f.plan);
  input.scenarios[0]!.caseIds.reverse();expect(()=>validateExperimentGold(input,f.sources,f.plan)).toThrow('revision changed');
});
test('DB corpus requires exact parent scope, complete vectors and exact annotation content',()=>{
  const f=fixture();const hashes=annotationContentHashes(f.plan);
  const rows:CorpusRow[]=f.sources.map(source=>({id:source.id,person_id:source.personId,source_hash:source.hash,content_hash:'synthetic-content-hash',unsafe:false,
    caption_vector_hash:'caption-vector',annotation_revision:'synthetic-style-v1',annotation_content_hash:hashes.get(source.id)!,image_vector_hash:'image-vector'}));
  expect(()=>validateCorpus(rows,f.sources,f.plan)).not.toThrow();
  for(const patch of [{person_id:'wrong'},{source_hash:'wrong'},{unsafe:true},{caption_vector_hash:null},{annotation_revision:'stale'},{annotation_content_hash:'wrong'},{image_vector_hash:null}]){
    const changed=structuredClone(rows);Object.assign(changed[0]!,patch);expect(()=>validateCorpus(changed,f.sources,f.plan)).toThrow();
  }
  expect(()=>validateCorpus(rows.slice(1),f.sources,f.plan)).toThrow();
  expect(()=>validateCorpus([...rows,rows[0]!],f.sources,f.plan)).toThrow();
});
test('prompt exposure is not reported as an actual image citation',()=>{
  const trace={state:'completed',errors:[],textCalls:1,embeddingCalls:1,retrievalCalls:1,sourceRecallAt5:1,requests:[],latencyMs:5} as unknown as TurnTrace;
  const rows:ExperimentRow[]=[{caseId:'synthetic-exposed',personId:'synthetic-person',condition:'caption_image',history:'single',category:'image',trace,annotationGoldHit:false,annotationGoldExposed:true,
    reply:{status:'answered',grounding:'unverified_model',evidence:[],limitations:[],promptEvidence:{sourceIds:['s'],annotationIds:['a'],omittedAnnotations:2,promptBytes:29900}} as unknown as ExperimentRow['reply']}];
  const summary=summarizeRows(rows) as Record<string,Record<string,unknown>>;
  expect(summary.caption_image?.annotationGoldExposureHit).toBe(1);expect(summary.caption_image?.annotationGoldCitationHit).toBe(0);
  expect(summary.caption_image?.annotationsOmitted).toBe(2);expect(summary.caption_image?.maxPromptBytes).toBe(29900);
});
