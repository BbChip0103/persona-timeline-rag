import {buildExperimentContext, relativeDate, REPLY_VOICE_POLICY, IDENTITY_PRIVACY_POLICY} from '../src/prompts';
import {v1Persona} from './persona-fixtures';

test('C3 dates use the turn clock without mutating citation provenance',()=>{
  const source={id:'synthetic-source',personId:v1Persona.id,caption:'Synthetic blue sky.',postedAt:'2023-01-03T00:00:00Z',eventDate:null,sourceUrl:'https://example.org/synthetic',hash:'synthetic',snapshot:'synthetic',unsafe:false};
  const result=buildExperimentContext(v1Persona,[],'기억나?',[source],{today:'2026-10-15'});
  const wire=result.messages.find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '))!.content;
  const card=JSON.parse(wire.slice('UNTRUSTED_EVIDENCE_JSON_DATA '.length))[0];
  expect(card.postedAt).toBe('약 3년 전 겨울');
  expect(card.quoteCandidate).toBe(source.caption);
  expect(result.sources[0]!.postedAt).toBe(source.postedAt);
});

test('C3 relative dates handle future, current year, absent clock, and missing date',()=>{
  expect(relativeDate('2027-04-03','2026-10-15')).toBe('약 1년 뒤 봄');
  expect(relativeDate('2026-10-01','2026-10-15')).toBe('올해 가을');
  expect(relativeDate('2023-01-03')).toBe('겨울 무렵');
  expect(relativeDate(null,'2026-10-15')).toBeNull();
});

test('C3 user-visible prose paraphrases; exact quotes and IDs stay in refs',()=>{
  for(const rule of ['evidenceRefs only','ISO','게시물','캡션','올린 글','사진 설명','자료','emotion','two or three turns','research','interpretation']) expect(REPLY_VOICE_POLICY).toContain(rule);
  expect(IDENTITY_PRIVACY_POLICY).not.toContain('research AI simulation');
});
