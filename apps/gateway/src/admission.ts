import { createHash } from 'node:crypto';
import { chainHashes, type ChainHash } from './prefix';

/**
 * Credit admission and the per-pool central queue (routing –§4, stage S3). Pure parts: request estimate,
 * the per-upstream credit check fits_u(r), the selection policies, and the band/LOOKAHEAD/aging queue. The pool owns
 * the ledger and the dispatch loop (late binding: a request is bound to an upstream only when one has credit).
 */
export type Band=1|0|-1;
export type RoutingPolicy='round_robin'|'least_inflight'|'scored';
export const ROUTING_POLICIES:readonly RoutingPolicy[]=['round_robin','least_inflight','scored'];

export interface RequestEstimate {
  /** T̂ = ceil(content bytes / bytes-per-token): conservative for ~90% of requests at 3.9 (the measured workload p10). */
  tokens:number;
  /** M = max_tokens (else 512): the output the KV reservation must hold. */
  maxTokens:number;
  /** Tokens of msg0 (the policy system message) and its hash: the pool learns G from the most common one. */
  prefixTokens:number; prefixKey:string;
  /** H_2 = sha256(policy ‖ persona): ties go to its rendezvous-hash order, so a persona's requests gather. */
  affinityKey:string;
  /** Message-boundary chain H_1..H_{m−1} with cumulative tokens (§4.2): looked up in each upstream's prefix table. */
  chain:ChainHash[];
}
const bytes=(text:string)=>Buffer.byteLength(text,'utf8');
export function estimateRequest(request:{messages:{role:string;content:string}[];max_tokens?:unknown},bytesPerToken:number):RequestEstimate {
  const total=request.messages.reduce((sum,message)=>sum+bytes(message.content),0);
  const first=request.messages[0];
  const maxTokens=typeof request.max_tokens==='number'&&Number.isInteger(request.max_tokens)&&request.max_tokens>0?request.max_tokens:512;
  const key=createHash('sha256');
  for(const message of request.messages.slice(0,2)) key.update(`${message.role}\u0000${message.content}\u0000`);
  const system=first?.role==='system';
  return {tokens:Math.ceil(total/bytesPerToken),maxTokens,prefixTokens:system?Math.ceil(bytes(first.content)/bytesPerToken):0,
    prefixKey:system?createHash('sha256').update(first.content).digest('hex'):'',affinityKey:key.digest('hex'),chain:chainHashes(request.messages,bytesPerToken)};
}

/** The gateway's ledger of one upstream plus what it is configured with. */
export interface CreditState {
  /** N_u, and S_u^eff (maxSeqs ramped by slow start; Infinity = uncapped). */
  inFlight:number; limit:number;
  /** Kres_u: reserved KV tokens; U_u: uncached prompt tokens still in prefill (no first chunk yet). */
  kvReserved:number; prefill:number;
  /** K_u (null = unknown: no KV check); R_u prefill tok/s (null = uncalibrated: no prefill gate). */
  kvCapacity:number|null; prefillPerSec:number|null;
  weight:number;
  /** Fresh engine telemetry over the filter limits (§3.1 item 5, S4): no new request while it lasts (see chooseUpstream). */
  engineBlocked?:boolean;
  /** Tokens of this request's prefix found in this upstream's prefix table (S5; the longest fresh H_k, 0 = none); prefill only. */
  matched?:number;
}
export interface CreditOptions {
  /** κ (PTR_GATEWAY_KV_OVERCOMMIT, 0.9). */
  kappa:number;
  /** G: global prefix tokens (the policy block), resident once per server and cached everywhere warm. */
  globalPrefix:number;
  /** T_max (PTR_GATEWAY_TTFT_PENALTY_MS, 1000). */
  ttftPenaltyMs:number;
  /** Cache affinity (PTR_GATEWAY_AFFINITY=on, §4.3); absent = off. */
  affinity?:AffinityOptions;
}
export interface AffinityOptions {
  /** PTR_GATEWAY_AFFINITY_MIN_TOKENS (256): the extra cached tokens g = matched − G that make a member sticky. */
  minTokens:number;
  /** PTR_GATEWAY_AFFINITY_SLACK (0.5): how much higher (in cost units) the sticky member's cost may be than the cheapest. */
  slack:number;
}
/**
 * `cachedPrefix`: the tokens of this request already cached on every warm server: G when its msg0 is the pool's policy
 * block, else 0 (S3: the global block only; the per-server prefix table is S5). Defaults to G.
 */
export interface CreditRequest { tokens:number; maxTokens:number; cachedPrefix?:number }
/** Uncached prompt tokens (1 − h)·T̂ = T̂ − cached prefix. */
export const uncachedTokens=(r:CreditRequest,globalPrefix:number)=>Math.max(0,r.tokens-(r.cachedPrefix??globalPrefix));
/** The KV this request reserves until it ends: (1 − h)·T̂ + M. */
export const kvReservation=(r:CreditRequest,globalPrefix:number)=>uncachedTokens(r,globalPrefix)+r.maxTokens;
/**
 * h_u·T̂ on one upstream for PREFILL (U, the τ gate, the cost): its prefix-table match where longer than the
 * policy-block share (S5), else that share. Never for KV: a cached prefix saves KV only while a running request holds it.
 */
export const cachedOn=(state:{matched?:number},r:CreditRequest,globalPrefix:number)=>Math.max(r.cachedPrefix??globalPrefix,state.matched??0);
/** The request as seen by one upstream (its cached prefix applied). */
const onMember=(state:{matched?:number},r:CreditRequest,globalPrefix:number):CreditRequest=>({...r,cachedPrefix:cachedOn(state,r,globalPrefix)});

/** fits_u(r), §3.1 conditions 2–5 (the member state, condition 1, is checked by the caller). */
export function fitsCredit(state:CreditState,r:CreditRequest,options:CreditOptions):boolean {
  if(state.engineBlocked) return false;
  if(state.inFlight+1>state.limit) return false;
  // An idle server always takes one request, however large, so nothing waits forever. G (resident once per server) is
  // capped at half the budget so a wrongly learned block cannot starve a server.
  const budget=state.kvCapacity===null?Infinity:options.kappa*state.kvCapacity-Math.min(options.globalPrefix,options.kappa*state.kvCapacity/2);
  if(state.inFlight>0&&state.kvReserved+kvReservation(r,options.globalPrefix)>budget) return false;
  // The prefix-table match saves prefill only (KV above: only the policy block is shared with running requests).
  if(state.prefillPerSec!==null&&state.prefill>0
    &&state.prefill+uncachedTokens(onMember(state,r,options.globalPrefix),options.globalPrefix)>state.prefillPerSec*options.ttftPenaltyMs/1000) return false;
  return true;
}
const rendezvous=(key:string,id:string)=>createHash('sha256').update(`${key}\n${id}`).digest('hex');
/** Why a member was picked: cache affinity, the policy's load rule, or the policy's tie-break among equals. */
export type RouteReason='affinity'|'load'|'tie';
/** Affinity outcome (null when affinity is off): sticky pick, a candidate over the slack, or no candidate (g < min). */
export type AffinityOutcome='picked'|'brokenBySlack'|'none';
export interface RouteDecision<T> {
  member:T; reason:RouteReason; affinity:AffinityOutcome|null;
  /** Every candidate (fitting member): h_u = cached share of T̂ and cost_u, rounded (for the routing log). */
  scores:{id:string;h:number;cost:number}[];
}
/**
 * Picks among the members whose credit fits (§4.3). cost_u = (U + (1 − h_u)·T̂) / (R_u·T_max) + (N + 1) / S_eff with
 * R_u = weight × 10000 until calibrated and h_u from the upstream's prefix table (S5). With affinity on, the member
 * with the largest g_u = matched_u − G (the cheapest of those) is picked when g ≥ minTokens and its cost is within
 * `slack` of the cheapest candidate; otherwise the configured policy decides: `scored` = least cost, ties by the
 * rendezvous hash of the policy+persona key; `least_inflight` = fewest in flight, ties rotate (affinity on: rendezvous,
 * so a persona's cold-start requests gather); `round_robin` = rotate. `turn` drives the rotation. Undefined when
 * nothing fits.
 */
export function chooseUpstream<T extends CreditState&{id:string}>(policy:RoutingPolicy,members:T[],r:CreditRequest&{affinityKey:string},
  options:CreditOptions,turn:number):RouteDecision<T>|undefined {
  let fitting=members.filter(member=>fitsCredit(member,r,options));
  // Only when no member fits: a telemetry-blocked member with nothing of this gateway's in flight takes one request
  // (like the KV rule's idle exception). A misread or stuck engine metric (names and semantics unverified on the
  // deployed vLLM) then degrades that server to one call at a time instead of removing it, and another gateway's load
  // cannot starve this gateway completely. One per gateway: with k gateways an engine may get k such calls.
  if(!fitting.length) fitting=members.filter(member=>member.engineBlocked&&member.inFlight===0&&fitsCredit({...member,engineBlocked:false},r,options));
  if(!fitting.length) return undefined;
  const G=options.globalPrefix;
  const cost=(member:T)=>(member.prefill+uncachedTokens(onMember(member,r,G),G))/((member.prefillPerSec??member.weight*10000)*options.ttftPenaltyMs/1000)
    +(Number.isFinite(member.limit)?(member.inFlight+1)/member.limit:0);
  const costs=fitting.map(cost), cheapest=Math.min(...costs);
  const round=(x:number)=>Math.round(x*1000)/1000;
  const scores=fitting.map((member,index)=>({id:member.id,h:round(r.tokens>0?cachedOn(member,r,G)/r.tokens:0),cost:round(costs[index]!)}));
  const ranked=(list:T[])=>list.reduce((top,member)=>rendezvous(r.affinityKey,member.id)>rendezvous(r.affinityKey,top.id)?member:top);
  const cheapestOf=(list:T[])=>{const best=Math.min(...list.map(member=>costs[fitting.indexOf(member)]!));
    return list.filter(member=>costs[fitting.indexOf(member)]!-best<1e-9);};
  let affinity:AffinityOutcome|null=null;
  const decide=(member:T,reason:RouteReason):RouteDecision<T>=>({member,reason,affinity,scores});
  if(options.affinity) {
    const gains=fitting.map(member=>(member.matched??0)-G), best=Math.max(...gains);
    if(best>=options.affinity.minTokens) {
      const sticky=ranked(cheapestOf(fitting.filter((_,index)=>gains[index]===best)));
      if(costs[fitting.indexOf(sticky)]!<=cheapest+options.affinity.slack+1e-9) {affinity='picked';return decide(sticky,'affinity');}
      affinity='brokenBySlack';
    } else affinity='none';
  }
  if(policy==='round_robin') return decide(fitting[turn%fitting.length]!,'load');
  if(policy==='least_inflight') {
    const least=Math.min(...fitting.map(member=>member.inFlight));
    const tied=fitting.filter(member=>member.inFlight===least);
    if(tied.length===1) return decide(tied[0]!,'load');
    return decide(options.affinity?ranked(tied):tied[turn%tied.length]!,'tie');
  }
  const tied=cheapestOf(fitting);
  return decide(ranked(tied),tied.length>1?'tie':'load');
}

/** Retry-After for a marked rejection: the queued uncached tokens over the pool's recent prefill rate, 1–5 s. */
export function queueRetryAfterSeconds(queuedTokens:number,tokensPerSecond:number|null):number {
  if(!tokensPerSecond||tokensPerSecond<=0) return 1;
  return Math.min(5,Math.max(1,Math.ceil(queuedTokens/tokensPerSecond)));
}

export interface QueuedRequest { id:number; band:Band; flow:string; /** uncached tokens (DRR cost, queued-token total) */ cost:number; enqueuedAt:number }
export interface QueueOptions { lookahead:number; starvationMs:number; fairness:'fifo'|'drr'; /** DRR quantum in uncached tokens (4096). */ quantum?:number }
const BANDS:Band[]=[1,0,-1];
/**
 * One queue per pool. Bands are strict (1: follow-up calls of a running turn, 0: first calls, −1: batch); a band with
 * waiting requests holds back the lower bands. Within a band: FIFO (default) or deficit round robin per flow. Up to
 * LOOKAHEAD requests that do not fit are skipped so later ones can pass a large head; a skipped request older than
 * the starvation age stops its band instead, so it cannot be overtaken forever.
 */
export class CentralQueue<T extends QueuedRequest> {
  private readonly bands=new Map<Band,T[]>(BANDS.map(band=>[band,[]]));
  private readonly deficits=new Map<string,number>();
  /** DRR rotation per band: flows in turn order, and whose turn it is (that flow already got its quantum). */
  private readonly rotation=new Map<Band,{order:string[];turn:string|undefined}>(BANDS.map(band=>[band,{order:[],turn:undefined}]));
  private tokens=0;
  constructor(private readonly options:QueueOptions) {}
  get size():number {return BANDS.reduce<number>((sum,band)=>sum+this.bands.get(band)!.length,0);}
  get queuedTokens():number {return this.tokens;}
  counts():Record<'1'|'0'|'-1',number> {return {'1':this.bands.get(1)!.length,'0':this.bands.get(0)!.length,'-1':this.bands.get(-1)!.length};}
  /** Waiting requests ahead of and including the newest of `band` (for Retry-After). */
  tokensAhead(band:Band):number {return BANDS.filter(b=>b>=band).reduce<number>((sum,b)=>sum+this.bands.get(b)!.reduce<number>((s,x)=>s+x.cost,0),0);}
  push(item:T):void {this.bands.get(item.band)!.push(item);this.tokens+=item.cost;}
  /** The newest request of the lowest band below `band` (what a full queue gives up for a higher band), if any. */
  newestBelow(band:Band):T|undefined {
    for(const lower of [...BANDS].reverse()) {if(lower>=band) break;const list=this.bands.get(lower)!;if(list.length) return list[list.length-1];}
    return undefined;
  }
  /** A retry after a connection failure keeps its place at the front of its band. */
  unshift(item:T):void {this.bands.get(item.band)!.unshift(item);this.tokens+=item.cost;}
  remove(item:T):boolean {
    const list=this.bands.get(item.band)!, index=list.indexOf(item);
    if(index<0) return false;
    list.splice(index,1);this.tokens-=item.cost;
    if(!BANDS.some(band=>this.bands.get(band)!.some(other=>other.flow===item.flow))) {
      this.deficits.delete(item.flow);
      for(const band of BANDS) {const state=this.rotation.get(band)!;state.order=state.order.filter(flow=>flow!==item.flow);if(state.turn===item.flow) state.turn=undefined;}
    }
    return true;
  }
  /**
   * One dispatch pass. `tryDispatch` binds an item to an upstream (reserving its credit) and returns true, or false when
   * nothing fits; dispatched items leave the queue and are returned in dispatch order.
   */
  plan(now:number,tryDispatch:(item:T)=>boolean):T[] {
    const out:T[]=[];
    const take=(list:T[],item:T)=>{list.splice(list.indexOf(item),1);this.tokens-=item.cost;out.push(item);};
    for(const band of BANDS) {
      const list=this.bands.get(band)!;
      if(this.options.fairness==='fifo') {
        let examined=0;
        for(let i=0;i<list.length&&examined<this.options.lookahead;) {
          const item=list[i]!;
          if(tryDispatch(item)) {take(list,item);continue;}
          if(now-item.enqueuedAt>this.options.starvationMs) break;
          examined++;i++;
        }
      } else this.drr(band,list,now,tryDispatch,take);
      if(list.length) break; // strict priority
    }
    return out;
  }
  /** Flows with a DRR deficit or a place in a rotation (for tests and metrics). */
  flows():number {return new Set([...this.deficits.keys(),...BANDS.flatMap(band=>this.rotation.get(band)!.order)]).size;}
  /**
   * Deficit round robin over the band's flows. The rotation persists across passes, a flow gets its quantum once per
   * turn (not again while it is blocked for lack of credit), and its deficit is capped at quantum + its head's cost, so a
   * saturated pool still alternates between flows. Within a flow up to LOOKAHEAD requests that do not fit are skipped;
   * one older than the starvation age stops the band. Flows that empty are forgotten.
   */
  private drr(band:Band,list:T[],now:number,tryDispatch:(item:T)=>boolean,take:(list:T[],item:T)=>void):void {
    const quantum=this.options.quantum??4096, state=this.rotation.get(band)!;
    const present=new Set(list.map(item=>item.flow));
    state.order=state.order.filter(flow=>present.has(flow));
    for(const flow of present) if(!state.order.includes(flow)) state.order.push(flow);
    for(const flow of [...this.deficits.keys()]) if(!BANDS.some(b=>this.bands.get(b)!.some(item=>item.flow===flow))) this.deficits.delete(flow);
    let examined=0, idle=0;
    while(state.order.length&&idle<state.order.length) {
      const flow=state.order[0]!;
      const items=list.filter(item=>item.flow===flow);
      if(state.turn!==flow) {state.turn=flow;this.deficits.set(flow,Math.min((this.deficits.get(flow)??0)+quantum,quantum+Math.max(1,items[0]?.cost??0)));}
      let deficit=this.deficits.get(flow)!, progressed=false, blocked=false, short=false;
      for(const item of items) {
        const cost=Math.max(1,item.cost);
        if(deficit<cost) {short=true;break;}
        if(tryDispatch(item)) {take(list,item);deficit-=cost;progressed=true;continue;}
        examined++;blocked=true;
        if(now-item.enqueuedAt>this.options.starvationMs) {this.deficits.set(flow,deficit);return;}
        if(examined>=this.options.lookahead) break;
      }
      if(!list.some(item=>item.flow===flow)) {this.deficits.delete(flow);state.order.shift();state.turn=undefined;idle=0;continue;}
      this.deficits.set(flow,deficit);
      if(examined>=this.options.lookahead) return;
      // End of this flow's turn: next flow. A flow short only of deficit is not idle (it gains a quantum next turn).
      state.order.push(state.order.shift()!);state.turn=undefined;
      idle=progressed||(short&&!blocked)?0:idle+1;
    }
  }
}
