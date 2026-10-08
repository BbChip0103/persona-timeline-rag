import { CentralQueue, chooseUpstream, estimateRequest, fitsCredit, queueRetryAfterSeconds, type CreditState, type QueuedRequest } from '../src/admission';
import { chainHashes } from '../src/prefix';

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
  test('the request carries its message-boundary chain H_1..H_{m−1} for the prefix tables (S5)',()=>{
    const history=[{role:'user',content:'first'},{role:'assistant',content:'answer'}];
    const estimate=estimateRequest({messages:messages('now',history)},3.9);
    expect(estimate.chain).toEqual(chainHashes(messages('now',history),3.9));
    expect(estimate.chain).toHaveLength(4);expect(estimate.chain[0]!.tokens).toBe(estimate.prefixTokens); // H_1 = the policy block = G's unit
  });
});

const state=(extra:Partial<CreditState>={}):CreditState=>({inFlight:0,limit:12,kvReserved:0,prefill:0,kvCapacity:null,prefillPerSec:null,weight:1,...extra});
describe('credit admission fits_u(r) (§3.1)',()=>{
  const r={tokens:2900,maxTokens:512,prefixTokens:1100};
  test('engine telemetry (condition 5): a blocked upstream does not fit',()=>{
    const options={kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000};
    expect(fitsCredit(state({engineBlocked:true}),r,options)).toBe(false);
    expect(fitsCredit(state({engineBlocked:false,inFlight:1}),r,options)).toBe(true);
  });
  test('selection: non-blocked members first; an idle blocked member takes one request only when no other member fits',()=>{
    const options={kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000}, req={...r,affinityKey:'k'};
    for(const policy of ['round_robin','least_inflight','scored'] as const) {
      const members=[{...state({engineBlocked:true}),id:'idle-blocked'},{...state({inFlight:5}),id:'busy-ok'}];
      expect(chooseUpstream(policy,members,req,options,0)?.member.id).toBe('busy-ok');
      const full=[{...state({engineBlocked:true}),id:'idle-blocked'},{...state({inFlight:12}),id:'full'}];
      expect(chooseUpstream(policy,full,req,options,0)?.member.id).toBe('idle-blocked');
      expect(chooseUpstream(policy,[{...state({engineBlocked:true,inFlight:1}),id:'blocked'}],req,options,0)).toBeUndefined();
    }
  });
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
  test('a prefix-table match lowers only the prefill credit, never the KV reservation (history is not held by a running request)',()=>{
    const options={kappa:0.9,globalPrefix:1100,ttftPenaltyMs:1000};
    // KV = Kres + (T̂ − G) + M: 35000 + (3300 − 1100) + 512 = 37712 > 37600, with or without a 2000-token match.
    const big={tokens:3300,maxTokens:512};
    expect(fitsCredit(state({limit:64,inFlight:1,kvReserved:35000,kvCapacity:43000}),big,options)).toBe(false);
    expect(fitsCredit(state({limit:64,inFlight:1,kvReserved:35000,kvCapacity:43000,matched:2000}),big,options)).toBe(false);
    // Prefill: U + (T̂ − max(G, matched)) ≤ R_u · T_max.
    expect(fitsCredit(state({prefill:8500,prefillPerSec:10000}),r,options)).toBe(false); // 8500 + 1800 > 10000
    expect(fitsCredit(state({prefill:8500,prefillPerSec:10000,matched:2500}),r,options)).toBe(true); // 8500 + 400
    expect(fitsCredit(state({prefill:8500,prefillPerSec:10000,matched:500}),r,options)).toBe(false); // a shorter match: the G share
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
    expect(chooseUpstream('scored',[fast,slow],r,options,0)?.member.id).toBe('fast');
    expect(chooseUpstream('least_inflight',[fast,slow],r,options,0)?.member.id).toBe('slow');
  });
  test('scored ties go to the rendezvous-hash order of the policy+persona key (stable, 1/N moves when members change)',()=>{
    const members=['a','b','c'].map(id=>({id,...state()}));
    const first=chooseUpstream('scored',members,r,options,0)!.member.id;
    expect(chooseUpstream('scored',[...members].reverse(),r,options,7)!.member.id).toBe(first);
    expect(chooseUpstream('scored',members,{...r,affinityKey:'other key'},options,0)).toBeDefined();
  });
  test('round_robin rotates over the fitting members; least_inflight breaks ties by rotation',()=>{
    const members=['a','b','c'].map(id=>({id,...state()}));
    expect([0,1,2,3].map(turn=>chooseUpstream('round_robin',members,r,options,turn)!.member.id)).toEqual(['a','b','c','a']);
    expect(chooseUpstream('least_inflight',[{id:'a',...state({inFlight:1})},{id:'b',...state()}],r,options,0)!.member.id).toBe('b');
    expect(chooseUpstream('round_robin',[],r,options,0)).toBeUndefined();
  });
});

describe('cache affinity (§4.3, S5): sticky until the slack is used up, else the configured policy',()=>{
  const G=1100, r={tokens:3000,maxTokens:512,prefixTokens:G,affinityKey:'persona-7'};
  const affinity={minTokens:256,slack:0.5};
  const on={kappa:0.9,globalPrefix:G,ttftPenaltyMs:1000,affinity}, off={kappa:0.9,globalPrefix:G,ttftPenaltyMs:1000};
  const m=(id:string,extra:Partial<CreditState>={})=>({id,...state(extra)});
  test('g = matched − G ≥ 256 within the slack: the warm member is picked although least_inflight would pick another',()=>{
    // warm: 2000 matched (g = 900), 3 in flight; cold: policy block only (g = 0), idle.
    const members=[m('warm',{inFlight:3,matched:2000}),m('cold',{matched:G})];
    expect(chooseUpstream('least_inflight',members,r,on,0)).toMatchObject({member:{id:'warm'},reason:'affinity',affinity:'picked'});
    expect(chooseUpstream('least_inflight',members,r,off,0)).toMatchObject({member:{id:'cold'},reason:'load',affinity:null});
    expect(chooseUpstream('scored',members,r,on,0)).toMatchObject({member:{id:'warm'},reason:'affinity'});
    expect(chooseUpstream('round_robin',members,r,on,1)).toMatchObject({member:{id:'warm'},reason:'affinity'});
  });
  test('slack: cost_a ≤ min cost + 0.5, cost = (U + uncached_u) / (R_u · T_max) + (N + 1) / S_eff; beyond it the policy decides (brokenBySlack)',()=>{
    // warm: (0 + 1000) / 10000 + 9/12 = 0.85; cold: (0 + 1900) / 10000 + 1/12 = 0.273 → 0.85 − 0.273 = 0.577 > 0.5
    const members=[m('warm',{inFlight:8,matched:2000}),m('cold',{matched:G})];
    expect(chooseUpstream('least_inflight',members,r,on,0)).toMatchObject({member:{id:'cold'},reason:'load',affinity:'brokenBySlack'});
    // one fewer in flight: 0.767 − 0.273 = 0.494 ≤ 0.5 → sticky
    expect(chooseUpstream('least_inflight',[m('warm',{inFlight:7,matched:2000}),m('cold',{matched:G})],r,on,0))
      .toMatchObject({member:{id:'warm'},affinity:'picked'});
  });
  test('only the policy block and persona in common (g < 256, the design\'s intended case) is no affinity: the policy picks (none)',()=>{
    const members=[m('a',{inFlight:2,matched:G+220}),m('b',{matched:G})];
    expect(chooseUpstream('least_inflight',members,r,on,0)).toMatchObject({member:{id:'b'},affinity:'none'});
    // Nothing cached anywhere (cold start, or the table was cleared): none.
    expect(chooseUpstream('least_inflight',[m('a',{inFlight:1}),m('b')],r,on,0)).toMatchObject({member:{id:'b'},affinity:'none'});
  });
  test('with affinity on, least_inflight ties go to the rendezvous order of hash(policy ‖ persona) instead of rotating (cold start gathers a persona)',()=>{
    const members=['a','b','c'].map(id=>m(id));
    const picks=[0,1,2,3,4].map(turn=>chooseUpstream('least_inflight',members,r,on,turn)!);
    expect(new Set(picks.map(p=>p.member.id)).size).toBe(1);expect(picks[0]!.reason).toBe('tie');
    expect(chooseUpstream('least_inflight',[...members].reverse(),r,on,9)!.member.id).toBe(picks[0]!.member.id);
    // off: rotation as before
    expect(new Set([0,1,2].map(turn=>chooseUpstream('least_inflight',members,r,off,turn)!.member.id)).size).toBe(3);
  });
  test('several members with the best g: the cheapest of them; members that do not fit are never picked by affinity',()=>{
    const members=[m('x',{inFlight:4,matched:2000}),m('y',{inFlight:2,matched:2000}),m('z')];
    expect(chooseUpstream('least_inflight',members,r,on,0)).toMatchObject({member:{id:'y'},reason:'affinity'});
    const full=[m('warm',{inFlight:12,matched:2500}),m('cold',{matched:G})];
    expect(chooseUpstream('least_inflight',full,r,on,0)).toMatchObject({member:{id:'cold'},affinity:'none'});
  });
  test('the decision reports h_u (cached share) and cost_u of every candidate for the routing log',()=>{
    const decision=chooseUpstream('least_inflight',[m('a',{inFlight:3,matched:2000}),m('b',{matched:G})],r,on,0)!;
    expect(decision.scores).toEqual([{id:'a',h:0.667,cost:0.433},{id:'b',h:0.367,cost:0.273}]);
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
