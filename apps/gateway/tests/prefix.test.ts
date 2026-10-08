import { createHash } from 'node:crypto';
import { PrefixTable, chainHashes } from '../src/prefix';

const m=(role:string,content:string)=>({role,content});
const convo=[m('system','P'.repeat(390)),m('system','persona'.padEnd(78,'x')),m('user','hello'),m('assistant','hi there'),m('user','new question')];

describe('message-boundary chain hashes ',()=>{
  test('H_k over all but the last message, with cumulative token estimates ceil(bytes / bytes-per-token)',()=>{
    const chain=chainHashes(convo,3.9);
    expect(chain).toHaveLength(4); // the last message (the new user turn) is never a cacheable prefix
    expect(chain.map(c=>c.tokens)).toEqual([100,120,122,124]); // 390 / 3.9, 468 / 3.9, 473 / 3.9 → 122 (ceil), 481 / 3.9 → 124 (ceil)
    expect(chain.every(c=>/^[0-9a-f]{32}$/.test(c.hash))).toBe(true);
    expect(chainHashes([m('user','only')],3.9)).toEqual([]);
  });
  test('a shared prefix gives the same hashes; any change (content, role, message boundary) changes it and everything after',()=>{
    const a=chainHashes(convo,3.9), b=chainHashes([...convo.slice(0,4),m('user','other'),m('user','x')],3.9);
    expect(b.slice(0,4)).toEqual(a);
    const role=chainHashes([m('user','P'.repeat(390)),...convo.slice(1)],3.9);
    expect(role[0]!.hash).not.toBe(a[0]!.hash);expect(role[3]!.hash).not.toBe(a[3]!.hash);
    expect(chainHashes([m('system','ab'),m('system','c'),m('user','q')],3.9)[1]!.hash).not.toBe(chainHashes([m('system','a'),m('system','bc'),m('user','q')],3.9)[1]!.hash);
    // Content holding what looks like a boundary cannot fake one (length-prefixed messages).
    expect(chainHashes([m('system','a\u0000system\u0000b'),m('user','q')],3.9)[0]!.hash).not.toBe(chainHashes([m('system','a'),m('system','b'),m('user','q')],3.9)[1]!.hash);
    // Salted per process: not a plain sha256 of the content.
    expect(chainHashes([m('system','x'),m('user','q')],3.9)[0]!.hash).not.toBe(createHash('sha256').update('6:system1:x').digest('hex').slice(0,32));
  });
});

describe('approximate prefix table per upstream',()=>{
  function table(options:{ttlMs?:number;capacityTokens?:()=>number|null;maxEntries?:number}={}) {
    let now=1000;
    const t=new PrefixTable({ttlMs:options.ttlMs??120000,capacityTokens:options.capacityTokens??(()=>null),maxEntries:options.maxEntries??4096,now:()=>now});
    return {t,advance:(ms:number)=>{now+=ms;}};
  }
  test('match = the cumulative tokens of the longest recorded H_k (0 when nothing matches)',()=>{
    const {t}=table();
    const chain=chainHashes(convo,3.9);
    expect(t.match(chain)).toBe(0);
    t.record(chain.slice(0,2));
    expect(t.match(chain)).toBe(120);
    t.record(chain);
    expect(t.match(chain)).toBe(124);
    expect(t.match(chainHashes([m('system','other'),m('user','q')],3.9))).toBe(0);
  });
  test('entries expire after the TTL (120 s) unless seen again',()=>{
    const {t,advance}=table();
    const chain=chainHashes(convo,3.9);
    t.record(chain);advance(60000);t.record(chain.slice(0,1));advance(60001);
    expect(t.match(chain)).toBe(100); // H_1 was seen 60 s ago, the longer ones 120.001 s ago
    advance(60000);expect(t.match(chain)).toBe(0);
    t.record([]);expect(t.metrics().entries).toBe(0); // expired entries are pruned
  });
  test('bounded like the engine KV: own tokens of the resident entries ≤ capacity, least recently seen evicted first; and an entry cap',()=>{
    const {t}=table({capacityTokens:()=>150});
    const a=chainHashes([m('system','A'.repeat(390)),m('user','q')],3.9), b=chainHashes([m('system','B'.repeat(390)),m('user','q')],3.9);
    t.record(a);t.record(b); // 100 + 100 > 150: a goes
    expect(t.match(a)).toBe(0);expect(t.match(b)).toBe(100);
    expect(t.metrics()).toMatchObject({entries:1,tokens:100});
    const shared=chainHashes(convo,3.9);
    t.record(shared); // own tokens 100, 20, 2, 2 = 124: b (100) is evicted
    expect(t.match(b)).toBe(0);expect(t.match(shared)).toBe(124);
    const capped=table({maxEntries:2});
    capped.t.record(shared);
    // A request's chain is recorded tail first, so its longest prefixes are the least recent and go first (vLLM evicts a
    // sequence's tail blocks first): what stays is a usable shorter prefix, not a dangling tail.
    expect(capped.t.metrics().entries).toBe(2);expect(capped.t.match(shared)).toBe(120);
  });
  test('recording again refreshes an entry (it moves to most recently seen)',()=>{
    const {t}=table({capacityTokens:()=>250});
    const a=chainHashes([m('system','A'.repeat(390)),m('user','q')],3.9), b=chainHashes([m('system','B'.repeat(390)),m('user','q')],3.9),
      c=chainHashes([m('system','C'.repeat(390)),m('user','q')],3.9);
    t.record(a);t.record(b);t.record(a);t.record(c); // b is the least recently seen
    expect(t.match(a)).toBe(100);expect(t.match(b)).toBe(0);expect(t.match(c)).toBe(100);
  });
  test('clear() empties the table and is counted (breaker open, engine restart)',()=>{
    const {t}=table();
    t.record(chainHashes(convo,3.9));t.clear();
    expect(t.match(chainHashes(convo,3.9))).toBe(0);
    expect(t.metrics()).toEqual({entries:0,tokens:0,cleared:1});
  });
});
