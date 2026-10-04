import type { SourcePost } from '@ptr/contracts';
import { validateExperimentReply, validateSourceBoundReply } from '../src';
const source:SourcePost={id:'synthetic-post',personId:'synthetic-person',caption:'😀 숲에서\r\n  그림을\t그렸어요.',postedAt:'2024-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/post',hash:'synthetic',snapshot:'v1',unsafe:false};
const selection=(quote:string,patch:object={})=>({sourceId:source.id,quote,...patch});
const raw=(ref:object)=>JSON.stringify({status:'answered',answer:'아 그때 숲에서 그림 그렸지ㅋㅋ',evidenceRefs:[ref]});
const validate=(ref:object,item=source)=>validateExperimentReply(raw(ref),[item],source.personId,'caption_image');

test('offsetless whitespace-only variation binds original bytes and UTF16 offsets, without rewriting answer',()=>{
  const result=validate(selection('😀 숲에서 그림을 그렸어요.'));
  expect(result.status).toBe('answered');expect(result.content).toBe('아 그때 숲에서 그림 그렸지ㅋㅋ');
  expect(result.evidence[0].quote).toBe(source.caption);
  expect(result.claims[0].evidenceRefs[0]).toEqual({...selection(source.caption),start:0,end:source.caption.length});
  expect(result.limitations).toContain('QUOTE_WHITESPACE_CANONICALIZED');
});
test('annotation-only whitespace canonicalization preserves exact parent and derivation provenance',()=>{
  const text='선명한\n  숲과\t길이 보인다.';
  const item={...source,imageAnnotations:[{id:'synthetic-image',imageHash:'ih',annotationHash:'ah',revision:'v1',model:'synthetic',humanReviewed:false as const,text}]};
  const result=validate(selection('선명한 숲과 길이 보인다.',{annotationId:'synthetic-image'}),item);
  expect(result.evidence[0]).toMatchObject({quote:text,annotationId:'synthetic-image',origin:'ai_image_annotation',imageHash:'ih',annotationHash:'ah'});
  expect(result.claims[0].evidenceRefs[0]).toMatchObject({start:0,end:text.length,quote:text});
  expect(validateExperimentReply(raw(selection('선명한 숲과 길이 보인다.',{annotationId:'synthetic-image'})),[item],source.personId,'caption').limitations).toContain('INVALID_MODEL_EVIDENCE');
});
test.each(['숲에서 다른 그림을 그렸어요.','숲에서그림을그렸어요.','😀 숲에서 그림을 그렸어요!','\n  \t'])('reject changed words/punctuation, removed word boundaries or empty quote %s',quote=>{
  expect(validate(selection(quote)).limitations).toContain('INVALID_MODEL_EVIDENCE');
});
test('normalized duplicate substrings and overlapping occurrences fail closed',()=>{
  for(const caption of ['숲\n 그림 / 숲\t그림','a a a']) {
    const quote=caption.startsWith('숲')?'숲 그림':'a\na';
    expect(validate(selection(quote),{...source,caption}).limitations).toContain('INVALID_MODEL_EVIDENCE');
  }
});
test('explicit selectors and legacy renderer stay exact-only; invalid provenance is not repaired',()=>{
  const normalized='😀 숲에서 그림을 그렸어요.';
  expect(validate(selection(normalized,{start:0,end:source.caption.length})).limitations).toContain('INVALID_MODEL_EVIDENCE');
  expect(validateSourceBoundReply(raw(selection(normalized)),[source],source.personId).status).toBe('insufficient_evidence');
  for(const patch of [{personId:'other-person'},{unsafe:true}])expect(validate(selection(normalized),{...source,...patch}).limitations).toContain('INVALID_MODEL_EVIDENCE');
  expect(validate(selection(normalized,{sourceId:'other-post'})).limitations).toContain('INVALID_MODEL_EVIDENCE');
});
test('exact substring stays unchanged and does not report canonicalization',()=>{
  const result=validate(selection(source.caption));expect(result.evidence[0].quote).toBe(source.caption);
  expect(result.limitations).not.toContain('QUOTE_WHITESPACE_CANONICALIZED');
});
