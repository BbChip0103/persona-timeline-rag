import { createHash } from 'node:crypto';
import type { LoreEntry, Persona } from '@ptr/contracts';
import { CoreError, InMemoryConversationStore, InMemoryPersonaRepository, LORE_BYTE_LIMIT, aiDisclosurePrefix, createLocalChat, greetingIndexFor, greetingsOf, loreBytes, matchLore, renderLoreMessage } from '../src';
import { cardPersona, v1Persona } from './persona-fixtures';

/**  (lore matching) and §3.5 (greetings, per-language disclosure). Synthetic personas only. */
const lore=(id:string,keys:string[],patch:Partial<LoreEntry>={}):LoreEntry=>({id,keys,content:`${id} 설정`,priority:50,sourceRefs:['web:1'],...patch});
const withLore=(entries:LoreEntry[]):Persona=>({...cardPersona,lore:entries});
const ids=(result:ReturnType<typeof matchLore>)=>result.entries.map(entry=>entry.id);

describe('matchLore',()=>{
  test('substring match on the current utterance and previous user messages; no match → nothing',()=>{
    const persona=withLore([lore('a',['수채화']),lore('b',['붓질'])]);
    expect(matchLore(persona,{current:'수채화로 뭐 그려?',previous:[]})).toEqual({entries:[persona.lore![0]],omitted:0});
    // Korean particles: plain substring, no word boundary.
    expect(ids(matchLore(persona,{current:'붓질은?',previous:['수채화가 좋아']}))).toEqual(['a','b']);
    expect(matchLore(persona,{current:'안녕',previous:['반가워']})).toEqual({entries:[],omitted:0});
  });
  test('NFKC and lower case on both sides',()=>{
    const persona=withLore([lore('a',['WaterColor'])]);
    for(const text of ['watercolor tips','WATERCOLOR','ＷＡＴＥＲＣＯＬＯＲ']) expect(ids(matchLore(persona,{current:text,previous:[]}))).toEqual(['a']);
  });
  test('only the first 1,000 code points of each message are scanned',()=>{
    const persona=withLore([lore('a',['수채화'])]);
    expect(ids(matchLore(persona,{current:`${'가'.repeat(997)}수채화`,previous:[]}))).toEqual(['a']);
    expect(ids(matchLore(persona,{current:`${'가'.repeat(998)}수채화`,previous:[]}))).toEqual([]);
    expect(ids(matchLore(persona,{current:'x',previous:[`${'😀'.repeat(997)}수채화`]}))).toEqual(['a']);
  });
  test('selection: current-utterance match first, then priority, then document order; at most three; output in document order',()=>{
    const persona=withLore([lore('p10',['k1'],{priority:10}),lore('p90',['k2'],{priority:90}),lore('p50',['k3']),lore('cur',['now'],{priority:0}),lore('p50b',['k4'])]);
    const result=matchLore(persona,{current:'now',previous:['k1 k2 k3 k4']});
    // Ranked: cur (current) → p90 → p50 → p50b (doc order) → p10; three fit.
    expect(ids(result)).toEqual(['p90','p50','cur']);expect(result.omitted).toBe(2);
    expect(matchLore(persona,{current:'now',previous:['k1 k2 k3 k4']})).toEqual(result);
  });
  test('byte budget: two full Korean entries fit in 2,048 B, a third is omitted; a smaller later entry still fits',()=>{
    const big=(id:string,priority:number)=>lore(id,['키워드'],{content:'가'.repeat(300),priority});
    const persona=withLore([big('a',90),big('b',80),big('c',70)]);
    const result=matchLore(persona,{current:'키워드',previous:[]});
    expect(ids(result)).toEqual(['a','b']);expect(result.omitted).toBe(1);
    expect(loreBytes(result.entries)).toBeLessThanOrEqual(LORE_BYTE_LIMIT);expect(loreBytes([...result.entries,persona.lore![2]!])).toBeGreaterThan(LORE_BYTE_LIMIT);
    const mixed=withLore([big('a',90),big('b',80),big('c',70),lore('small',['키워드'],{priority:0})]);
    expect(ids(matchLore(mixed,{current:'키워드',previous:[]}))).toEqual(['a','b','small']);
  });
  test('the lore message is user-role untrusted data with ids and content only',()=>{
    const entry=lore('a',['수채화'],{content:'설정 문장'});
    expect(renderLoreMessage([entry])).toEqual({role:'user',content:'UNTRUSTED_PERSONA_LORE_JSON_DATA (author-set setting notes; NOT evidence, NOT citable) [{"loreId":"a","content":"설정 문장"}]'});
  });
  test('a persona without lore never matches',()=>{
    expect(matchLore(v1Persona,{current:'수채화',previous:[]})).toEqual({entries:[],omitted:0});
  });
});

describe('greetings and AI disclosure (§3.5)',()=>{
  test('greeting list, deterministic index from sha256(session id), per-language prefix',()=>{
    expect(greetingsOf(v1Persona)).toEqual([v1Persona.greeting]);
    expect(greetingsOf(cardPersona)).toEqual([cardPersona.greeting,...cardPersona.alternateGreetings!]);
    expect(greetingIndexFor('session-1',3)).toBe(createHash('sha256').update('session-1').digest().readUInt32BE(0)%3);
    expect(greetingIndexFor('anything',1)).toBe(0);
    expect(aiDisclosurePrefix('ko')).toBe('AI 연구용 시뮬레이션입니다. ');expect(aiDisclosurePrefix('ko-KR')).toBe('AI 연구용 시뮬레이션입니다. ');
    expect(aiDisclosurePrefix('en')).toBe('AI research simulation. ');expect(aiDisclosurePrefix('ja')).toBe('AI research simulation. ');
    expect(aiDisclosurePrefix('ko_KR')).toBe('AI 연구용 시뮬레이션입니다. ');expect(aiDisclosurePrefix('KO')).toBe('AI 연구용 시뮬레이션입니다. ');
    expect(aiDisclosurePrefix('kor')).toBe('AI research simulation. ');expect(aiDisclosurePrefix('kok')).toBe('AI research simulation. ');
  });
  const en:Persona={...v1Persona,id:'persona:synthetic-en',personId:'synthetic-en',language:'en',greeting:'Hi, research AI here.'};
  const chat=()=>{const store=new InMemoryConversationStore();
    return {store,chat:createLocalChat({store,personas:new InMemoryPersonaRepository([v1Persona,cardPersona,en]),provider:{generate:async()=>'ok'}})};};
  const create=(c:ReturnType<typeof chat>['chat'],persona:Persona,extra:Record<string,unknown>={})=>c.createSession('owner',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,...extra});
  test('a v1 Korean persona keeps its greeting bytes and session shape; English sessions get the English prefix',async()=>{
    const h=chat();
    const ko=await create(h.chat,v1Persona);expect(ko.greetingIndex).toBeUndefined();
    expect((await h.store.history(ko.id,'owner'))[0]!.content).toBe(`AI 연구용 시뮬레이션입니다. ${v1Persona.greeting}`);
    const english=await create(h.chat,en);
    expect((await h.store.history(english.id,'owner'))[0]!.content).toBe(`AI research simulation. ${en.greeting}`);
  });
  test('alternate greetings: explicit index (evaluation pins 0) or the session-id hash, stored on the session',async()=>{
    const h=chat();const list=greetingsOf(cardPersona);
    const pinned=await create(h.chat,cardPersona,{greetingIndex:0});expect(pinned.greetingIndex).toBe(0);
    expect((await h.store.history(pinned.id,'owner'))[0]!.content).toBe(`AI 연구용 시뮬레이션입니다. ${list[0]}`);
    const second=await create(h.chat,cardPersona,{greetingIndex:2});
    expect((await h.store.history(second.id,'owner'))[0]!.content).toBe(`AI 연구용 시뮬레이션입니다. ${list[2]}`);
    const hashed=await create(h.chat,cardPersona);
    expect(hashed.greetingIndex).toBe(greetingIndexFor(hashed.id,list.length));
    expect((await h.store.history(hashed.id,'owner'))[0]!.content).toBe(`AI 연구용 시뮬레이션입니다. ${list[hashed.greetingIndex!]}`);
    await expect(create(h.chat,cardPersona,{greetingIndex:3})).rejects.toEqual(new CoreError('INVALID_INPUT'));
    await expect(create(h.chat,v1Persona,{greetingIndex:1})).rejects.toEqual(new CoreError('INVALID_INPUT'));
    expect((await create(h.chat,v1Persona,{greetingIndex:0})).greetingIndex).toBe(0);
  });
});
