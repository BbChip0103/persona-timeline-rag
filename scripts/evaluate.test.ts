import type { ChatReply, Persona, SourcePost } from '@ptr/contracts';
import { EvaluationSchema, extractionBaseline, parseOptions, scoreReply, sourceRecall, validateAssets, validateExtractionCandidate, type Assets } from './evaluate';

function syntheticAssets():Assets {
  const persona:Persona={id:'synthetic-persona',personId:'synthetic-person',revision:'fixture-v1',label:'Fictional fixture',language:'en',reviewStatus:'synthetic',identity:'Synthetic only',concept:'test',style:[],boundaries:[],sourceRefs:[],greeting:'hello'};
  const source:SourcePost={id:'synthetic-source',personId:persona.personId,caption:'Synthetic event: 2024년 1월 2일.',postedAt:'2024-01-03T00:00:00Z',eventDate:null,sourceUrl:'https://example.com/synthetic',snapshot:'synthetic-snapshot',hash:'synthetic-hash',unsafe:false};
  const categories=['caption_supported','event_date_unknown','absent','clarification'] as const;
  const counts=[32,8,6,4];
  const cases=categories.flatMap((category,index)=>Array.from({length:counts[index]},(_,number)=>({id:`${category}-${number}`,text:'Synthetic question',personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,
    timezone:'UTC',category,split:'test' as const,splitProxy:'person_posted_day' as const,goldSourceIds:category==='caption_supported'?[source.id]:[]})));
  const extraction=Array.from({length:50},(_,index)=>({id:`extraction-${index}`,sourceId:source.id,split:'test' as const,silverExpectedEventDate:null}));
  const scenarios=Array.from({length:12},(_,index)=>({id:`scenario-${index}`,personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,timezone:'UTC',fixedHistory:[{role:'user' as const,content:'Frozen synthetic context'}],
    turns:Array.from({length:5},(_,turn)=>({id:`scenario-${index}-${turn}`,text:'Synthetic hello'}))}));
  return {personas:[persona],sources:[source],evaluation:EvaluationSchema.parse({version:'goal1-eval-v1',labelStatus:'silver_nonhuman',revision:'synthetic-eval-v1',methodology:{bias:'synthetic source-derived'},cases,extraction,scenarios})};
}

describe('private evaluation contracts and honest metrics',()=>{
  it('accepts exact balanced silver fixtures and rejects category/count drift',()=>{
    const assets=syntheticAssets();expect(()=>validateAssets(assets)).not.toThrow();
    expect(()=>EvaluationSchema.parse({...assets.evaluation,cases:assets.evaluation.cases.slice(1)})).toThrow();
    expect(()=>EvaluationSchema.parse({...assets.evaluation,labelStatus:'human_reviewed'})).toThrow();
    expect(()=>EvaluationSchema.parse({...assets.evaluation,cases:assets.evaluation.cases.map((item,index)=>index===0?{...item,category:'absent'}:item)})).toThrow();
  });
  it('fixes gold before retrieval and rejects wrong-person or unsafe gold',()=>{
    const assets=syntheticAssets();
    expect(()=>validateAssets({...assets,sources:[{...assets.sources[0],personId:'different-synthetic-person'}]})).toThrow();
    expect(()=>validateAssets({...assets,sources:[{...assets.sources[0],unsafe:true}]})).toThrow();
    expect(()=>validateAssets({...assets,personas:[{...assets.personas[0],personId:'other'}]})).toThrow();
  });
  it('uses top-five recall with distinct gold and null empty denominator',()=>{
    expect(sourceRecall([],['a'])).toBeNull();expect(sourceRecall(['a','a','b'],['a','wrong'])).toBe(0.5);
    expect(sourceRecall(['gold'],['a','b','c','d','e','gold'])).toBe(0);
  });
  it('validates exact source quotes without declaring factual correctness',()=>{
    const assets=syntheticAssets();const source=assets.sources[0];
    const reply:ChatReply={sessionId:'synthetic-session',turnId:'synthetic-turn',messageId:'synthetic-message',personId:source.personId,personaRevision:'fixture-v1',responseKind:'timeline',status:'answered',content:'Synthetic quote',
      claims:[{text:'Synthetic claim',evidenceRefs:[{sourceId:source.id,quote:source.caption,start:0,end:source.caption.length}]}],evidence:[],limitations:[]};
    expect(scoreReply(reply,source.personId,assets.sources)).toEqual({validQuotes:1,totalQuotes:1,crossPersonEvidence:0});
    expect(scoreReply(reply,'wrong-person',assets.sources)).toEqual({validQuotes:0,totalQuotes:1,crossPersonEvidence:1});
    expect(scoreReply(undefined,source.personId,assets.sources)).toEqual({validQuotes:0,totalQuotes:0,crossPersonEvidence:0});
  });
  it('never upgrades environment-enabled default fake into live',()=>{
    expect(parseOptions([], {GOAL1_LIVE_ENABLED:'true'}).live).toBe(false);
    expect(()=>parseOptions(['--live'],{})).toThrow('LIVE_DISABLED');
    expect(parseOptions(['--live','--modes=off,lexical','--limit=10','--skip-multi'],{GOAL1_LIVE_ENABLED:'true'})).toMatchObject({live:true,modes:['off','lexical'],limit:10,skipMulti:true});
    expect(()=>parseOptions(['--modes=off,off'],{})).toThrow();expect(()=>parseOptions(['--limit=0'],{})).toThrow();
  });
  it('reports nullable-date baseline as fifty nonhuman cases, not model extraction',()=>{
    const records=extractionBaseline(syntheticAssets());expect(records).toHaveLength(50);
    expect(records[0]).toMatchObject({conservativeEventDate:null,rawUnknownEventDate:null,labelStatus:'silver_nonhuman'});
    expect(String(records[0].claim)).toContain('not extraction accuracy');
  });
  it('accepts only exact-quote unambiguous full-date surface candidates',()=>{
    const caption='Synthetic event: 2024년 1월 2일.';
    expect(validateExtractionCandidate(JSON.stringify({eventDate:'2024-01-02',timeExpression:'2024년 1월 2일',quote:caption}),caption)).toMatchObject({schemaValid:true,exactQuote:true,explicitDateSurfaceValid:true,conservativeEventDate:'2024-01-02'});
    expect(validateExtractionCandidate(JSON.stringify({eventDate:'2024-01-02',timeExpression:'1월 2일',quote:'1월 2일'}),caption)).toMatchObject({conservativeEventDate:null});
    expect(validateExtractionCandidate(JSON.stringify({eventDate:'2024-01-02',timeExpression:'2024년 1월 2일',quote:'invented 2024년 1월 2일'}),caption)).toMatchObject({exactQuote:false,conservativeEventDate:null});
    const ambiguous='2024-01-02 or 2024-02-02';
    expect(validateExtractionCandidate(JSON.stringify({eventDate:'2024-01-02',timeExpression:'2024-01-02',quote:ambiguous}),ambiguous)).toMatchObject({conservativeEventDate:null});
    expect(validateExtractionCandidate('invalid JSON',caption)).toMatchObject({schemaValid:false,conservativeEventDate:null});
  });
});
