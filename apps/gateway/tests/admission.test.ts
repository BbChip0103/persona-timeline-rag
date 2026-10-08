import { CentralQueue, chooseUpstream, estimateRequest, fitsCredit, queueRetryAfterSeconds, type CreditState, type QueuedRequest } from '../src/admission';

const policy='P'.repeat(5029), persona='p'.repeat(858);
const messages=(user:string,history:{role:string;content:string}[]=[])=>[{role:'system',content:policy},{role:'system',content:persona},...history,{role:'user',content:user}];

describe('request estimate (§3.1, §4.1)',()=>{
  test('T̂ = ceil(content bytes / 3.9); M = max_tokens or 512; the policy block (msg0) and policy+persona key are taken',()=>{
    const estimate=estimateRequest({messages:messages('안녕')},3.9);
    const bytes=5029+858+Buffer.byteLength('안녕');
    expect(estimate).toMatchObject({tokens:Math.ceil(bytes/3.9),maxTokens:512,prefixTokens:Math.ceil(5029/3.9)});
    expect(estimate.prefixKey).toMatch(/^[0-9a-f]{64}$/);
    expect(estimate.affinityKey).toMatch(/^[0-9a-f]{64}$/);
    expect(estimateRequest({messages:messages('다른 질문')},3.9).affinityKey).toBe(estimate.affinityKey); // same policy + persona
    expect(estimateRequest({messages:messages('x'),max_tokens:100},3.9).maxTokens).toBe(100);
    expect(estimateRequest({messages:[{role:'user',content:'only'}]},3.9).prefixTokens).toBe(0); // no system block
  });
});

const state=(extra:Partial<CreditState>={}):CreditState=>({inFlight:0,limit:12,kvReserved:0,prefill:0,kvCapacity:null,prefillPerSec:null,weight:1,...extra});
describe('credit admission fits_u(r) (§3.1)',()=>{
  const r={tokens:2900,maxTokens:512,prefixTokens:1100};
  test('sequences: N + 1 ≤ S_eff',()=>{
    expect(fitsCredit(state({inFlight:11}),r,{kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000})).toBe(true);
    expect(fitsCredit(state({inFlight:12}),r,{kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000})).toBe(false);
  });
  test('a request that does not share the policy block gets no cached share; G is capped at half the KV budget',()=>{
    const options={kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000};
    expect(fitsCredit(state({limit:64,inFlight:1,kvReserved:35000,kvCapacity:43000}),{...r,cachedPrefix:0},options)).toBe(false); // 35000 + 3412 > 37600
    expect(fitsCredit(state({limit:64,inFlight:1,kvReserved:35000,kvCapacity:43000}),r,options)).toBe(true); // 35000 + 2312 ≤ 37600
    // A wrongly learned huge G (e.g. from a probe request) cannot shrink the budget below κ·K/2.
    expect(fitsCredit(state({limit:64,inFlight:1,kvReserved:1000,kvCapacity:43000}),{tokens:2000,maxTokens:512,cachedPrefix:0},{...options,globalPrefix:60000})).toBe(true);
  });
  test('KV: Kres + (1 − h)·T̂ + M ≤ κ·K − G with h = G/T̂ (the global policy block is cached once per server); skipped when K is unknown',()=>{
    // 26B check from the design: (2900 − 1100) + 512 = 2312 per request; budget 0.9 × 43000 − 1100 = 37600 → 16 fit.
    const options={kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000};
    expect(fitsCredit(state({limit:64,inFlight:15,kvReserved:15*2312,kvCapacity:43000}),r,options)).toBe(true);
    expect(fitsCredit(state({limit:64,inFlight:16,kvReserved:16*2312,kvCapacity:43000}),r,options)).toBe(false);
    expect(fitsCredit(state({limit:64,inFlight:16,kvReserved:16*2312,kvCapacity:null}),r,options)).toBe(true);
    // A request larger than the whole budget still runs on an idle server (it would otherwise never run).
    expect(fitsCredit(state({kvCapacity:2000}),r,options)).toBe(true);
  });
  test('prefill gate only with a calibrated R_u: U = 0 or U + uncached ≤ R_u · T_max',()=>{
    const options={kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000};
    expect(fitsCredit(state({prefill:9000}),r,options)).toBe(true); // uncalibrated: no gate
    expect(fitsCredit(state({prefill:9000,prefillPerSec:10000}),r,options)).toBe(false); // 9000 + 1800 > 10000
    expect(fitsCredit(state({prefill:8000,prefillPerSec:10000}),r,options)).toBe(true);
    expect(fitsCredit(state({prefill:0,prefillPerSec:100}),r,options)).toBe(true); // empty: always admitted
  });
});

describe('selection (§4.3, affinity off)',()=>{
  const r={tokens:2900,maxTokens:512,prefixTokens:1100,affinityKey:'k'};
  const options={kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000};
  test('scored: cost = (U + (1 − h)·T̂) / (R_u · T_max) + (N + 1) / S_eff, R_u = weight × 10000 uncalibrated; the cheapest wins',()=>{
    const fast={id:'fast',...state({inFlight:4,weight:1})}, slow={id:'slow',...state({inFlight:2,weight:0.5})};
    // fast: 1800/10000 + 5/12 = 0.597; slow: 1800/5000 + 3/12 = 0.61
    expect(chooseUpstream('scored',[fast,slow],r,options,0)?.id).toBe('fast');
    expect(chooseUpstream('least_inflight',[fast,slow],r,options,0)?.id).toBe('slow');
  });
  test('scored ties go to the rendezvous-hash order of the policy+persona key (stable, 1/N moves when members change)',()=>{
    const members=['a','b','c'].map(id=>({id,...state()}));
    const first=chooseUpstream('scored',members,r,options,0)!.id;
    expect(chooseUpstream('scored',[...members].reverse(),r,options,7)!.id).toBe(first);
    expect(chooseUpstream('scored',members,{...r,affinityKey:'other key'},options,0)).toBeDefined();
  });
  test('round_robin rotates over the fitting members; least_inflight breaks ties by rotation',()=>{
    const members=['a','b','c'].map(id=>({id,...state()}));
    expect([0,1,2,3].map(turn=>chooseUpstream('round_robin',members,r,options,turn)!.id)).toEqual(['a','b','c','a']);
    expect(chooseUpstream('least_inflight',[{id:'a',...state({inFlight:1})},{id:'b',...state()}],r,options,0)!.id).toBe('b');
    expect(chooseUpstream('round_robin',[],r,options,0)).toBeUndefined();
  });
});

describe('central queue (§3.2–3.3)',()=>{
  let id=0;
  const item=(band:1|0|-1,extra:Partial<QueuedRequest>={}):QueuedRequest=>({id:++id,band,flow:'f',cost:100,enqueuedAt:0,...extra});
  test('bands are strictly ordered; FIFO within a band; LOOKAHEAD lets later requests pass a head that does not fit',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:2000,fairness:'fifo'});
    const a=item(0),b=item(0),c=item(1),d=item(-1);
    for(const x of [a,b,c,d]) q.push(x);
    expect(q.plan(1000,()=>true).map(x=>x.id)).toEqual([c.id,a.id,b.id,d.id]);
    const q2=new CentralQueue({lookahead:8,starvationMs:2000,fairness:'fifo'});
    const big=item(0,{cost:9000}),small=item(0);for(const x of [big,small]) q2.push(x);
    expect(q2.plan(1000,x=>x.cost<1000).map(x=>x.id)).toEqual([small.id]); // big waits, small passes it
    expect(q2.size).toBe(1);
  });
  test('aging: a head waiting longer than 2 s that does not fit stops its band (no more overtaking)',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:2000,fairness:'fifo'});
    const big=item(0,{cost:9000,enqueuedAt:0}),small=item(0,{enqueuedAt:100});for(const x of [big,small]) q.push(x);
    expect(q.plan(2500,x=>x.cost<1000)).toEqual([]);
  });
  test('a waiting band-1 request holds back lower bands; LOOKAHEAD bounds how many non-fitting requests are examined',()=>{
    const q=new CentralQueue({lookahead:2,starvationMs:2000,fairness:'fifo'});
    const stuck=item(1,{cost:9000}),low=item(0);q.push(stuck);q.push(low);
    expect(q.plan(100,x=>x.cost<1000)).toEqual([]);
    const q2=new CentralQueue({lookahead:2,starvationMs:60000,fairness:'fifo'});
    const xs=[item(0,{cost:9000}),item(0,{cost:9000}),item(0)];for(const x of xs) q2.push(x);
    expect(q2.plan(100,x=>x.cost<1000)).toEqual([]); // the fitting third is beyond LOOKAHEAD 2
  });
  test('drr (flag): flows share a band by deficit round robin instead of arrival order',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:2000,fairness:'drr',quantum:100});
    const heavy=[1,2,3].map(()=>item(0,{flow:'heavy'})),light=item(0,{flow:'light'});
    for(const x of [...heavy,light]) q.push(x);
    expect(q.plan(100,()=>true).map(x=>x.flow)).toEqual(['heavy','light','heavy','heavy']);
  });
  test('drr under saturation: a small flow is not starved by a large one (persistent rotation, no quantum while blocked)',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:60000,fairness:'drr',quantum:100});
    const heavy=Array.from({length:6},()=>item(0,{flow:'heavy'})),light=item(0,{flow:'light'});
    for(const x of [...heavy,light]) q.push(x);
    // Saturated: each pass has exactly one free slot.
    const served:string[]=[];
    for(let pass=0;pass<4;pass++) {let slots=1;served.push(...q.plan(100,()=>slots-->0).map(x=>x.flow));}
    expect(served.slice(0,2).sort()).toEqual(['heavy','light']);
  });
  test('drr: a head larger than one quantum is served within the same pass once its flow has accumulated enough',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:60000,fairness:'drr',quantum:100});
    const big=item(0,{flow:'a',cost:450});q.push(big);
    expect(q.plan(100,()=>true)).toEqual([big]);
  });
  test('drr: a non-fitting head does not block the rest of its own flow within LOOKAHEAD',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:60000,fairness:'drr',quantum:10000});
    const big=item(0,{flow:'',cost:9000}),small=item(0,{flow:''});q.push(big);q.push(small);
    expect(q.plan(100,x=>x.cost<1000)).toEqual([small]);
  });
  test('drr deficits of flows that left are forgotten',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:60000,fairness:'drr',quantum:100});
    const gone=item(0,{flow:'gone',cost:5000});q.push(gone);q.plan(100,()=>false);q.remove(gone);
    expect(q.flows()).toBe(0);
  });
  test('queued tokens; remove (abort/timeout)',()=>{
    const q=new CentralQueue({lookahead:8,starvationMs:2000,fairness:'fifo'});
    const a=item(0,{cost:300}),b=item(1,{cost:200});q.push(a);q.push(b);
    expect(q.queuedTokens).toBe(500);expect(q.counts()).toEqual({'1':1,'0':1,'-1':0});
    q.remove(a);expect(q.queuedTokens).toBe(200);expect(q.size).toBe(1);
  });
});

describe('Retry-After from queued tokens (§3.4)',()=>{
  test('clamp(ceil(queued tokens / processed tokens per second), 1, 5); 1 before any rate is known',()=>{
    expect(queueRetryAfterSeconds(50000,null)).toBe(1);
    expect(queueRetryAfterSeconds(50000,20000)).toBe(3);
    expect(queueRetryAfterSeconds(500000,20000)).toBe(5);
    expect(queueRetryAfterSeconds(10,20000)).toBe(1);
  });
});
