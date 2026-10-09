import { createHash } from 'node:crypto';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import { UpstreamHealth, type BreakerMetrics, type BreakerOptions, type BreakerState } from './health';
import { CentralQueue, cachedOn, chooseUpstream, estimateRequest, kvReservation, queueRetryAfterSeconds, uncachedTokens, type AffinityOptions,
  type AffinityOutcome, type Band, type QueuedRequest, type RequestEstimate, type RouteDecision, type RoutingPolicy } from './admission';
import { HASH_SALT, PrefixTable } from './prefix';
import { GatewayRejection } from './limiter';
import type { SourceMetrics, UpstreamSource } from './sources';
import { EngineTelemetry, type TelemetryMetrics, type TelemetryOptions } from './telemetry';
import { DEADLINE_MARGIN_MS, OpenAICompatibleUpstream, SECONDARY_MIN_REMAINING_MS, UpstreamConnectError, type ChatCompletionRequest, type RequestContext, type Upstream, type UpstreamResult } from './upstreams';

export interface FailoverOptions extends BreakerOptions {
  /**
   * The primary must send response headers within this time (default 10000; 0 = off); the stream after that is not
   * limited. A timeout counts toward the breaker. So does a caller that gives up after waiting at least this long
   * without headers (the worker's own deadline), when it is on.
   */
  headersTimeoutMs:number;
  /**
   * Treat a primary connection closed before any response byte like a connection failure (another primary, then the
   * secondary). True for a non-billed self-hosted primary (a duplicate generation there costs nothing and the caller
   * never got an answer); false keeps the strict rule.
   */
  failOverOnClose:boolean;
  /** Secondary calls started per rolling minute (protects the shared ledger's call cap during an outage). */
  maxPerMinute:number;
}
export const DEFAULT_FAILOVER:FailoverOptions={failureThreshold:3,timeoutThreshold:3,cooldownMs:30000,probeTimeoutMs:2000,
  headersTimeoutMs:10000,failOverOnClose:true,maxPerMinute:120};
export interface FailoverMetrics {
  secondary:string;
  /** Primary breaker; with several primaries: closed if any is closed, counts summed, streaks the largest. */
  breaker:BreakerMetrics;
  /** Requests answered (any HTTP status) by the primaries and by the secondary. */
  answered:{primary:number;secondary:number};
  /** Requests sent to the secondary, by reason: a primary connection failure, the open breakers, or no registered primary. */
  failovers:Record<string,number>;
  /** Closed-before-response primary failures surfaced as errors (failOverOnClose off). */
  closedNotFailedOver:number;
  /** Requests refused because the secondary's per-minute ceiling was reached. */
  rateLimited:number; secondaryErrors:number;
  /** The ceiling in force: PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE / k with k active gateways in the gateway registry (1 without it). */
  perMinuteCap:number;
}
/** A primary: an upstream with an engine `/health` check and, optionally, its Prometheus `/metrics` text (OpenAICompatibleUpstream). */
export type Primary=Upstream&{health(signal:AbortSignal):Promise<boolean>;metrics?(signal:AbortSignal):Promise<string|null>};
/** Why an upstream's limit is ramping: newly added, its breaker closed again, or its engine restarted (S4). */
export type RampReason='added'|'breaker_closed'|'restarted';
export interface UpstreamMemberMetrics {
  id:string; epoch:string; state:'active'|'draining'|'gone';
  /** N_u, and the current limit S_u^eff: maxSeqs ramped during slow start (null = unlimited). */
  inFlight:number;
  limit:number|null; maxSeqs:number|null; weight:number; slowStart:boolean; rampReason:RampReason|null; breaker:BreakerState;
  /** Kres_u (reserved KV tokens) and U_u (uncached prompt tokens before the first chunk); K_u, R_u as configured. */
  reservedKvTokens:number; prefillTokens:number; kvCapacityTokens:number|null; prefillTokensPerSec:number|null;
  /** N/S_eff and Kres/(κ·K − G) (null when unknown). */
  seqUtil:number|null; kvUtil:number|null;
  dispatched:number; answered:number; connectFailures:number;
  /** Engine telemetry (S4; null when off or the client has no /metrics). */
  telemetry:TelemetryMetrics|null;
  /** 2xx calls: dispatch → first body chunk (the engine's TTFT as the gateway sees it) and dispatch → end, ms. */
  ttftMs:Quantiles; e2eMs:Quantiles;
  /** T̂ / usage.prompt_tokens of 2xx calls whose stream or body reported usage (n = how many did). */
  estOverActualTokens:Quantiles&{n:number};
  /** Prefix table (S5): entries, their own tokens, clears (breaker open, restart), dispatches with a match longer than G. */
  prefix:{entries:number;tokens:number;cleared:number;extraHits:number};
}
export interface Quantiles {p50:number|null;p95:number|null}
export interface PoolQueueMetrics {
  routing:RoutingPolicy; fairness:'fifo'|'drr';
  queued:Record<'1'|'0'|'-1',number>; queuedTokens:number;
  waitMs:{p50:number|null;p95:number|null};
  /** `deadline`: refused because the caller's X-PTR-Deadline left too little time to send (nothing was sent). */
  rejected:{queue_full:number;saturated:number;queue_timeout:number;draining:number;deadline:number};
  /** G: the global prefix (policy block) learned from the first request's msg0, in tokens. */
  globalPrefixTokens:number;
  /** Recent uncached prompt tokens per second reaching a first chunk (Retry-After estimate); null before any. */
  prefillTokensPerSec:number|null;
}
export interface PoolMetrics {
  pool:string;
  /** Members by state; `ramping` ⊂ active (slow start), `gone` = left the source but still finishing calls. */
  members:{active:number;ramping:number;draining:number;gone:number;breakerOpen:number;
    /** Members the engine telemetry filter currently excludes, and members whose telemetry is stale (filter ignored). */
    telemetryBlocked:number;telemetryStale:number};
  /** Requests waiting in the pool's queue for credit on an upstream (bounded by the queue timeout). */
  waiting:number;
  /** Requests resent to another primary after a connection failure (nothing reached the first one). */
  retriedOnOtherPrimary:number;
  /** Requests that got the marked 503 GATEWAY_QUEUE_TIMEOUT from the pool queue (a subset of the gateway's rejected.queueTimeout). */
  queueTimeouts:number;
  /** `restarted`: an engine restart seen in telemetry (process_start_time_seconds) cleared a member's state. */
  events:{added:number;removed:number;replaced:number;invalid:number;restarted:number};
  /** The telemetry filter settings (null = off). */
  telemetry:{intervalMs:number;kvHigh:number;waitingMax:number;timeoutMs:number}|null;
  queue:PoolQueueMetrics;
  /** 2xx calls: arrival at the pool (queue wait included) → first body chunk / → end, ms. */
  latency:{ttftMs:Quantiles;e2eMs:Quantiles};
  /** Cache affinity (§4.3): settings and outcomes (counted only when on). */
  affinity:{mode:'on'|'off';minTokens:number;slack:number}&Record<AffinityOutcome,number>;
  /** PTR_GATEWAY_PREFIX_TTL_MS. */
  prefixTtlMs:number;
  upstreams:UpstreamMemberMetrics[];
  registry?:SourceMetrics;
}
export interface PoolOptions {
  /** Pool name = the model name sent to every engine in it. */
  model:string;
  source:UpstreamSource;
  /** Builds the client of one record (default: OpenAICompatibleUpstream on its baseUrl). */
  create?:(record:UpstreamRecord)=>Primary;
  /** Used only when every primary is unavailable (breaker open, draining, none registered) or failed to connect. */
  secondary?:Upstream;
  failover?:Partial<FailoverOptions>;
  /** Primaries tried per request on connection failures (design §5, PTR_GATEWAY_PRIMARY_ATTEMPTS). Default 2. */
  primaryAttempts?:number;
  /** Linear ramp of a newly added upstream's limit (PTR_GATEWAY_SLOW_START_MS). Default 30000; 0 = off. */
  slowStartMs?:number;
  /**
   * Longest wait in the pool queue before a marked 503 GATEWAY_QUEUE_TIMEOUT. Default 10000. A request with a deadline
   * (RequestContext.deadlineAt) waits at most until DEADLINE_MARGIN_MS before it, then gets GATEWAY_DEADLINE.
   */
  queueTimeoutMs?:number;
  /**
   * The pool owns admission (S3): the gateway's own limiter is bypassed, requests wait in this pool's band queue, and
   * a full queue is a marked 429. File / registry pools; the env-only failover wrapper keeps the gateway limiter.
   */
  admission?:boolean;
  /** PTR_GATEWAY_MAX_QUEUE when the pool owns admission (256); unbounded otherwise (the gateway limiter bounds it). */
  maxQueue?:number;
  /** PTR_GATEWAY_ROUTING (class default least_inflight, the S2 rule). */
  routing?:RoutingPolicy;
  /** κ (0.9), bytes per token (3.9), T_max (1000 ms), LOOKAHEAD (8), starvation age (2000 ms), fifo|drr, DRR quantum (4096). */
  kappa?:number; bytesPerToken?:number; ttftPenaltyMs?:number; lookahead?:number; starvationMs?:number;
  fairness?:'fifo'|'drr'; drrQuantum?:number;
  /** Refuse at once (429 `saturated`) when the estimated wait exceeds the queue timeout. Default off. */
  rejectSaturated?:boolean;
  /**
   * Engine telemetry filter (S4, §4.4): poll each member's /metrics every `intervalMs` (PTR_GATEWAY_METRICS_INTERVAL_MS);
   * while fresh, KV usage ≥ `kvHigh` or waiting > `waitingMax` takes the member out of selection. Off when absent.
   */
  telemetry?:Pick<TelemetryOptions,'intervalMs'|'kvHigh'|'waitingMax'|'timeoutMs'>;
  /** Cache affinity (PTR_GATEWAY_AFFINITY=on, §4.3: sticky until the slack is used up); absent = off. */
  affinity?:AffinityOptions;
  /** Prefix-table entry lifetime (PTR_GATEWAY_PREFIX_TTL_MS). Default 120000. */
  prefixTtlMs?:number;
  /** Share of routing decisions written as a `route …` log line without text (PTR_GATEWAY_ROUTE_LOG_SAMPLE). Default 0.01. */
  routeLogSample?:number;
  /** Random source of the log sampling (tests). */
  random?:()=>number;
  /**
   * k = active gateways (gateway registry, S6): each gateway counts its own failover calls, so the per-minute ceiling
   * becomes floor(maxPerMinute / k) (at least 1) and the gateways together stay within it while k is steady. Infinity =
   * k unknown (registry not read yet): 1 per minute. Default 1.
   */
  replicas?:()=>number;
  /** Clock for slow start (tests). */
  now?:()=>number;
  /** Operator warnings (default stderr); never contains URLs or request content. */
  log?:(line:string)=>void;
}

const isTimeout=(reason:unknown)=>(reason as {name?:unknown})?.name==='TimeoutError';
// The early `saturated` refusal trusts the observed prefill rate only with this many recent answers behind it.
const TICK_MS=250, SAMPLE=2000, RATE_WINDOW_MS=10000, MIN_RATE_SAMPLES=20;
const PREFIX_HALF_LIFE=256, PREFIX_DECAY=Math.pow(0.5,1/PREFIX_HALF_LIFE);
/** Prefix-table entries per upstream, always (a known KV capacity bounds the table's tokens as well, see PrefixTable). */
const PREFIX_MAX_ENTRIES=4096;
/** Last chunks of a stream kept to read its usage (vLLM sends it in the last event before [DONE]). */
const USAGE_CHUNKS=4;
const DEFAULT_AFFINITY:AffinityOptions={minTokens:256,slack:0.5};
class Member {
  inFlight=0;dispatched=0;answered=0;connectFailures=0;gone=false;kvReserved=0;prefill=0;extraHits=0;
  health!:UpstreamHealth;telemetry:EngineTelemetry|undefined;prefix!:PrefixTable;
  readonly ttfts:number[]=[];readonly e2es:number[]=[];
  /** T̂ / prompt_tokens × 1000 (integers for the percentile helper). */
  readonly ratios:number[]=[];
  /** Start of the current slow-start ramp (−∞ = full capacity) and its cause. */
  constructor(public record:UpstreamRecord,readonly upstream:Primary,public rampFrom:number,public rampReason:RampReason) {}
}
interface Reservation {
  kv:number; prefill:number; firstChunk:boolean; released:boolean;
  /** For the latency metrics and the prefix table: when it was dispatched and arrived, T̂, its chain; ok = a 2xx answer. */
  dispatchedAt:number; arrivedAt:number; estimate:RequestEstimate; ok:boolean;
}
interface Pending extends QueuedRequest {
  estimate:RequestEstimate&{cachedPrefix:number}; exclude:Set<Member>;
  /** For the routing log: the caller's request key (hashed there), a retry on another primary, arrival at the pool. */
  requestKey:string|undefined; retry:boolean; arrivedAt:number;
  /** Latest send time (X-PTR-Deadline − DEADLINE_MARGIN_MS; Infinity without a deadline). */
  sendBy:number;
  settle:(result:{member:Member;reservation:Reservation}|{none:string|undefined})=>void; reject:(error:unknown)=>void;
}
/**
 * Relays the body; passes each chunk on (the first marks prefill done) and releases the slot when it ends (completed =
 * true), fails, is closed, or the call is aborted.
 */
function relaying(body:AsyncIterable<Uint8Array>,chunk:(data:Uint8Array)=>void,release:(completed:boolean)=>void,signal:AbortSignal):AsyncIterable<Uint8Array> {
  const onAbort=()=>release(false);
  const done=(completed:boolean)=>{signal.removeEventListener('abort',onAbort);release(completed);};
  if(signal.aborted) release(false);else signal.addEventListener('abort',onAbort,{once:true});
  return {[Symbol.asyncIterator]() {
    const iterator=body[Symbol.asyncIterator]();
    return {
      async next() {
        try {const result=await iterator.next();if(result.done) done(true);else chunk(result.value);return result;} catch(error) {done(false);throw error;}
      },
      async return(value?:unknown) {done(false);await iterator.return?.(value);return {done:true as const,value:undefined};},
    };
  }};
}
/** usage.prompt_tokens in the end of an answer (the last occurrence: vLLM's usage event follows the content). */
function promptTokens(tail:string):number|null {
  const found=[...tail.matchAll(/"prompt_tokens"\s*:\s*(\d+)/g)].at(-1);
  const value=found?Number(found[1]):NaN;
  return value>0?value:null;
}
const percentile=(values:number[],p:number)=>{
  if(!values.length) return null;const sorted=[...values].sort((a,b)=>a-b);
  return Math.round(sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]!);
};
/** p50/p95 of a sample; `scale` divides integer-stored values (ratios × 1000). */
const quantiles=(values:number[],scale=1):Quantiles=>{
  const at=(p:number)=>{const value=percentile(values,p);return value===null?null:value/scale;};
  return {p50:at(0.5),p95:at(0.95)};
};

/**
 * One model's upstreams (routing –§5, §13). The member set follows an UpstreamSource (static list, file or
 * Redis registry); each member has its own breaker (UpstreamHealth) and credit: sequences (maxSeqs, ramped by slow
 * start), KV tokens (when its capacity is known) and prefill tokens (when its prefill rate is calibrated). A request
 * waits in the pool's central queue (bands from X-PTR-Priority, FIFO or DRR, LOOKAHEAD, aging) and is bound to an
 * upstream only when one has credit (late binding), by PTR_GATEWAY_ROUTING: round_robin, least_inflight or scored
 * (§4.3 least cost, affinity comes in S5). There is no spillover. Draining or departed members take no new calls and
 * finish the ones they have. Connection failures (nothing reached the engine; with `failOverOnClose` also a close
 * before any response byte) are retried on another member, then on the optional secondary; timeouts, HTTP errors and
 * streams cut mid-response are surfaced as before. With one uncapped member this is exactly the single-upstream (and
 * FailoverUpstream) behaviour: an open breaker with no other member and no secondary still sends to it.
 */
export class UpstreamPool implements Upstream {
  readonly model:string;
  readonly failoverMetrics?:()=>FailoverMetrics;
  /** Present when the pool owns admission: the gateway skips its own limiter and reports this instead. */
  readonly admission?:()=>{inFlight:number;queued:number;maxConcurrent:number;maxQueue:number};
  readonly admits:boolean;
  private readonly options:FailoverOptions;
  private readonly members=new Map<string,Member>();
  private readonly retiring=new Set<Member>();
  private readonly queue:CentralQueue<Pending>;
  private readonly now:()=>number;
  private readonly create:(record:UpstreamRecord)=>Primary;
  private readonly stopSource:()=>void;
  private readonly routing:RoutingPolicy;
  private readonly maxQueue:number;
  private startingUp=true;private rr=0;private nextId=0;private globalPrefix=0;private prefixKey='';
  /** msg0 blocks seen (bounded, decayed counts): G is the most common one, so one odd first request cannot set it for good. */
  private readonly prefixSeen=new Map<string,{tokens:number;count:number}>();
  private dispatching=false;private again=false;private ticker:NodeJS.Timeout|undefined;
  private readonly started:number[]=[];
  private readonly waits:number[]=[];
  private readonly processed:{at:number;tokens:number}[]=[];
  private readonly counts={primary:0,secondary:0,closedNotFailedOver:0,rateLimited:0,secondaryErrors:0,retried:0,queueTimeouts:0};
  private readonly rejected={queue_full:0,saturated:0,queue_timeout:0,draining:0,deadline:0};
  private draining=false;
  private readonly affinityCounts:Record<AffinityOutcome,number>={picked:0,brokenBySlack:0,none:0};
  private readonly ttfts:number[]=[];private readonly e2es:number[]=[];
  private readonly failovers:Record<string,number>={};
  private readonly events={added:0,removed:0,replaced:0,invalid:0,restarted:0};
  constructor(private readonly pool:PoolOptions) {
    this.model=pool.model;this.options={...DEFAULT_FAILOVER,...pool.failover};this.now=pool.now??Date.now;
    this.create=pool.create??(record=>new OpenAICompatibleUpstream({baseUrl:record.baseUrl,model:pool.model}));
    this.routing=pool.routing??'least_inflight';this.admits=!!pool.admission;
    this.maxQueue=pool.maxQueue??(pool.admission?256:Infinity);
    this.queue=new CentralQueue<Pending>({lookahead:pool.lookahead??8,starvationMs:pool.starvationMs??2000,fairness:pool.fairness??'fifo',quantum:pool.drrQuantum??4096});
    if(pool.secondary) this.failoverMetrics=()=>this.secondaryMetrics();
    if(pool.admission) this.admission=()=>{
      const caps=[...this.members.values()].filter(member=>member.record.state==='active').map(member=>member.record.maxSeqs);
      return {inFlight:[...this.members.values(),...this.retiring].reduce((sum,member)=>sum+member.inFlight,0),queued:this.queue.size,
        maxConcurrent:caps.reduce((sum,cap)=>sum+(Number.isFinite(cap)?cap:0),0),maxQueue:this.maxQueue};
    };
    this.sync();this.startingUp=false;
    this.stopSource=pool.source.onChange(()=>this.sync());
  }
  /** Loads the source (first registry poll; members found now start at full capacity), then checks the secondary. */
  async ready(signal:AbortSignal):Promise<void> {
    this.startingUp=true;
    try {await this.pool.source.start?.();} finally {this.startingUp=false;}
    await this.pool.secondary?.ready?.(signal);
  }
  async close():Promise<void> {
    this.stopSource();clearInterval(this.ticker);this.ticker=undefined;
    for(const member of [...this.members.values(),...this.retiring]) member.telemetry?.stop();
    await this.pool.source.close?.();
  }

  async complete(request:ChatCompletionRequest,signal:AbortSignal,context?:RequestContext):Promise<UpstreamResult> {
    const arrivedAt=Date.now();
    const estimate=this.learnPrefix(estimateRequest(request,this.pool.bytesPerToken??3.9));
    const tried=new Set<Member>();let reason='breaker_open';let lastError:unknown;
    // : nothing goes to a primary after sendBy, so the queue wait ends there at the latest.
    const sendBy=context?.deadlineAt===undefined?Infinity:context.deadlineAt-DEADLINE_MARGIN_MS;
    const waitUntil=Math.min(arrivedAt+(this.pool.queueTimeoutMs??10000),sendBy), deadline=()=>waitUntil;
    const attempts=Math.max(1,this.pool.primaryAttempts??2);
    for(let attempt=0;attempt<attempts;attempt++) {
      let routed:Awaited<ReturnType<UpstreamPool['route']>>;
      try {routed=await this.route(estimate,context,signal,tried,deadline,attempt>0,arrivedAt);}
      catch(error) {
        // After a failed attempt the request may have reached an engine (closed before response): no other upstream
        // in time must not become a marked "nothing was sent" rejection. Fall through to the secondary or the error.
        if(attempt>0&&error instanceof GatewayRejection) break;
        if(error instanceof GatewayRejection&&error.code==='GATEWAY_QUEUE_TIMEOUT') {this.counts.queueTimeouts++;this.rejected.queue_timeout++;}
        if(error instanceof GatewayRejection&&error.code==='GATEWAY_DEADLINE') this.rejected.deadline++;
        throw error;
      }
      if(!('member' in routed)) {if(routed.none) reason=routed.none;break;}
      const {member,reservation,openGeneration}=routed;
      tried.add(member);if(attempt>0) this.counts.retried++;
      try {return await this.callPrimary(member,reservation,request,signal,openGeneration);}
      catch(error) {
        if(!(error instanceof UpstreamConnectError)) throw error;
        if(!error.certain&&!this.options.failOverOnClose) {this.counts.closedNotFailedOver++;throw error;}
        if(signal.aborted) throw error;
        reason=error.reason;lastError=error;
      }
    }
    const secondary=this.pool.secondary;
    if(!secondary) throw lastError;
    // A caller that already left is neither sent nor counted.
    if(signal.aborted) throw signal.reason;
    // D16: the secondary only with SECONDARY_MIN_REMAINING_MS of the deadline left. Too late with nothing tried is a
    // marked refusal; after a primary attempt (which may have reached an engine) its failure stands.
    if(context?.deadlineAt!==undefined&&context.deadlineAt-Date.now()<SECONDARY_MIN_REMAINING_MS) {
      if(tried.size) throw lastError;
      this.rejected.deadline++;throw new GatewayRejection('GATEWAY_DEADLINE');
    }
    const now=Date.now();
    while(this.started.length&&now-this.started[0]!>=60000) this.started.shift();
    if(this.started.length>=this.perMinuteCap()) {this.counts.rateLimited++;throw new Error('FAILOVER_RATE_LIMITED');}
    this.started.push(now);
    this.failovers[reason]=(this.failovers[reason]??0)+1;
    this.routeLog(context?.requestKey,context?.priority??0,estimate.tokens,[],'secondary','failover',null,now-arrivedAt);
    try {
      const result=await secondary.complete(request,signal,context);
      this.counts.secondary++;
      return {...result,upstream:'secondary'};
    } catch(error) {if(!signal.aborted) this.counts.secondaryErrors++;throw error;}
  }

  /**
   * Decides what can be decided before queueing (no member left after a failed attempt, all breakers open with a
   * secondary: answer at once), probes half-open members, then waits in the central queue for credit.
   */
  /** G = the most common msg0 (the policy block); a request gets the cached share only if its msg0 is that block. */
  private learnPrefix(estimate:RequestEstimate):RequestEstimate&{cachedPrefix:number} {
    if(estimate.prefixKey) {
      // Exponentially decayed counts (half-life PREFIX_HALF_LIFE requests): a policy-prompt deploy re-learns G after
      // about that many requests, while a shorter run of other system messages (a batch, a probe) does not move it.
      for(const entry of this.prefixSeen.values()) entry.count*=PREFIX_DECAY;
      const seen=this.prefixSeen.get(estimate.prefixKey)??{tokens:estimate.prefixTokens,count:0};seen.count++;
      this.prefixSeen.set(estimate.prefixKey,seen);
      if(this.prefixSeen.size>16) {
        const rarest=[...this.prefixSeen.entries()].filter(([key])=>key!==estimate.prefixKey).sort((a,b)=>a[1].count-b[1].count)[0]!;
        this.prefixSeen.delete(rarest[0]);
      }
      const [key,top]=[...this.prefixSeen.entries()].reduce((best,entry)=>entry[1].count>best[1].count?entry:best);
      this.prefixKey=key;this.globalPrefix=top.tokens;
    }
    return {...estimate,cachedPrefix:estimate.prefixKey&&estimate.prefixKey===this.prefixKey?this.globalPrefix:0};
  }
  private async route(estimate:RequestEstimate&{cachedPrefix:number},context:RequestContext|undefined,signal:AbortSignal,tried:Set<Member>,deadline:()=>number,retry:boolean,arrivedAt:number):
    Promise<{member:Member;reservation:Reservation;openGeneration?:number}|{none:string|undefined}> {
    for(;;) {
      const live=this.candidates(tried);
      if(!live.length&&(this.pool.secondary||tried.size)) return {none:tried.size?undefined:'no_upstream'};
      if(live.length) {
        const closed=live.filter(member=>member.health.state()==='closed');
        const halfOpen=live.filter(member=>member.health.state()==='half_open');
        // With a secondary as the alternative, a half-open primary is probed before use (FailoverUpstream behaviour).
        // Otherwise probe in the background: others serve meanwhile, or (no alternative) the request goes out at once.
        if(!closed.length&&this.pool.secondary) {
          const healthy=halfOpen.length?await this.firstHealthy(halfOpen,signal,deadline()):undefined;
          // The membership may have changed during the probe: never dispatch to a member that left or is draining.
          if(healthy&&!(this.members.get(healthy.record.id)===healthy&&healthy.record.state==='active')) continue;
          if(!healthy) return {none:'breaker_open'};
        } else for(const member of halfOpen) void member.health.probeHealth();
      }
      const result=await this.enqueue(estimate,context,signal,tried,deadline(),retry,arrivedAt);
      if('member' in result) return {...result,...(result.member.health.isOpen?{openGeneration:result.member.health.generation}:{})};
      return result;
    }
  }
  /** The secondary's per-minute ceiling for this gateway: maxPerMinute / k active gateways (at least 1). */
  private perMinuteCap():number {
    const k=this.pool.replicas?.()??1;
    if(!Number.isFinite(k)) return 1;
    return Math.max(1,Math.floor(this.options.maxPerMinute/(k>1?k:1)));
  }
  /**
   * Graceful drain (§6.3): every queued first attempt is refused at once with GATEWAY_DRAINING (nothing was sent: the
   * server answers the marked 503, and the worker moves to its next gateway), and so is every later request. A queued
   * retry on another primary (its first attempt failed to connect, possibly after reaching an engine) is not: like an
   * in-flight call it stays and is served (or ends as before: secondary, or the connect error). Dispatched calls finish.
   */
  drain():void {
    this.draining=true;
    for(const pending of this.queue.items()) {
      if(pending.retry) continue;
      this.queue.remove(pending);this.rejected.draining++;
      pending.reject(new GatewayRejection('GATEWAY_DRAINING'));
    }
    this.kick();
  }
  private candidates(exclude:Set<Member>):Member[] {
    return [...this.members.values()].filter(member=>member.record.state==='active'&&!exclude.has(member));
  }
  private enqueue(estimate:RequestEstimate&{cachedPrefix:number},context:RequestContext|undefined,signal:AbortSignal,exclude:Set<Member>,deadlineAt:number,retry:boolean,arrivedAt:number):
    Promise<{member:Member;reservation:Reservation}|{none:string|undefined}> {
    const band:Band=context?.priority??0, cost=uncachedTokens(estimate,this.globalPrefix);
    // Retries continue during a drain (see drain()); only first attempts are refused, and only those are counted.
    if(this.draining&&!retry) {this.rejected.draining++;return Promise.reject(new GatewayRejection('GATEWAY_DRAINING'));}
    if(!retry&&this.pool.rejectSaturated&&this.queue.size) {
      const rate=this.prefillRate(MIN_RATE_SAMPLES);
      if(rate&&(this.queue.tokensAhead(band)+cost)/rate*1000>deadlineAt-Date.now()) {
        this.rejected.saturated++;
        return Promise.reject(new GatewayRejection('GATEWAY_SATURATED',this.retryAfterSeconds(band)));
      }
    }
    const sendBy=context?.deadlineAt===undefined?Infinity:context.deadlineAt-DEADLINE_MARGIN_MS;
    return new Promise((resolve,reject)=>{
      const remaining=deadlineAt-Date.now();
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);};
      let settled=false;
      const pending:Pending={id:++this.nextId,band,flow:context?.flow??'',cost,enqueuedAt:Date.now(),estimate,exclude,requestKey:context?.requestKey,retry,arrivedAt,sendBy,
        settle:result=>{settled=true;cleanup();this.record(this.waits,Date.now()-pending.enqueuedAt);resolve(result);},
        reject:error=>{settled=true;cleanup();reject(error);}};
      // Leaving frees the head of a band: run a pass so the requests behind it do not wait for the next tick.
      const leave=(error:unknown)=>{if(this.queue.remove(pending)) {cleanup();reject(error);this.kick();}};
      const onAbort=()=>leave(signal.reason);
      // A wait bounded by the caller's deadline (not the queue timeout) ends as `deadline`: resending cannot help.
      const expired=deadlineAt>=sendBy?'GATEWAY_DEADLINE':'GATEWAY_QUEUE_TIMEOUT';
      const timer=setTimeout(()=>leave(new GatewayRejection(expired)),Math.max(0,remaining));
      if(retry) this.queue.unshift(pending);else this.queue.push(pending);
      this.kick();
      // Bound checked after a dispatch attempt (a request with credit runs even at PTR_GATEWAY_MAX_QUEUE=0). When full, a
      // higher band takes the place of the newest request of the lowest band below it; else this request is refused.
      if(!settled&&!retry&&this.queue.size>this.maxQueue) {
        const victim=this.queue.newestBelow(band);
        const refused=victim??pending;
        this.queue.remove(refused);this.rejected.queue_full++;
        refused.reject(new GatewayRejection('GATEWAY_QUEUE_FULL',this.retryAfterSeconds(refused.band)));
        if(!victim) return;
      }
      // Credit available now: dispatched even for a caller that already left (as before S3: the call itself sees the
      // aborted signal). Only a request that has to wait is dropped for an aborted caller.
      if(settled) return;
      if(signal.aborted) leave(signal.reason);else signal.addEventListener('abort',onAbort,{once:true});
    });
  }
  /**
   * Runs the dispatch loop now (re-entrant calls from releases during a pass just request another pass). While requests
   * wait, a 250 ms tick covers slow start, breaker cooldowns and aging.
   */
  private kick():void {
    if(this.dispatching) {this.again=true;return;}
    this.dispatching=true;
    try {do {this.again=false;this.dispatch();} while(this.again);} finally {this.dispatching=false;}
    if(this.queue.size&&!this.ticker) {this.ticker=setInterval(()=>this.kick(),TICK_MS);this.ticker.unref();}
    if(!this.queue.size&&this.ticker) {clearInterval(this.ticker);this.ticker=undefined;}
  }
  private dispatch():void {
    const now=this.now();
    this.queue.plan(Date.now(),pending=>{
      // Credit reached it too late to send before its deadline (§4 step 4): refused before any member is picked, so no
      // counter, rotation or reservation moves. complete() marks it on a first attempt only (D17).
      if(Date.now()>pending.sendBy) {pending.reject(new GatewayRejection('GATEWAY_DEADLINE'));return true;}
      const live=this.candidates(pending.exclude);
      if(!live.length) {
        if(this.pool.secondary||pending.exclude.size) {pending.settle({none:pending.exclude.size?undefined:'no_upstream'});return true;}
        return false; // wait for a member to appear
      }
      const closed=live.filter(member=>member.health.state()==='closed');
      for(const member of live) if(member.health.state()==='half_open') void member.health.probeHealth();
      if(!closed.length&&this.pool.secondary) {pending.settle({none:'breaker_open'});return true;}
      // No closed member and no secondary: the open ones are the only alternative (a single upstream has no breaker).
      const usable=closed.length?closed:live;
      // Engine telemetry is a filter only (§4.4): a blocked member is "busy" (the request waits), never "unavailable".
      // matched: this request's prefix in the member's table (S5), for its prefill credit, cost and cache affinity; with
      // affinity off the table is not consulted (S4 behaviour exactly) and only kept for the metrics.
      const states=usable.map(member=>({id:member.record.id,member,inFlight:member.inFlight,limit:this.limit(member,now),kvReserved:member.kvReserved,
        prefill:member.prefill,kvCapacity:member.record.kvCapacityTokens,prefillPerSec:member.record.prefillTokensPerSec??null,weight:member.record.weight,
        engineBlocked:member.telemetry?.blocked()??false,matched:this.pool.affinity?member.prefix.match(pending.estimate.chain):0}));
      const decision=chooseUpstream(this.routing,states,pending.estimate,{kappa:this.pool.kappa??0.9,globalPrefix:this.globalPrefix,
        ttftPenaltyMs:this.pool.ttftPenaltyMs??1000,...(this.pool.affinity?{affinity:this.pool.affinity}:{})},this.rr);
      if(!decision) return false;
      this.rr++;
      const member=decision.member.member, cached=cachedOn(decision.member,pending.estimate,this.globalPrefix);
      const own={...pending.estimate,cachedPrefix:cached};
      // KV: (T̂ − G) + M only. A prefix hit saves prefill, but KV only for blocks a RUNNING request holds; a session's
      // history is held by none (one turn per session at a time), so the engine allocates those blocks again.
      const reservation:Reservation={kv:kvReservation(pending.estimate,this.globalPrefix),prefill:uncachedTokens(own,this.globalPrefix),firstChunk:false,released:false,
        dispatchedAt:Date.now(),arrivedAt:pending.arrivedAt,estimate:pending.estimate,ok:false};
      member.inFlight++;member.dispatched++;member.kvReserved+=reservation.kv;member.prefill+=reservation.prefill;
      if(cached>pending.estimate.cachedPrefix) member.extraHits++;
      if(decision.affinity) this.affinityCounts[decision.affinity]++;
      this.logDecision(pending,decision);
      pending.settle({member,reservation});
      return true;
    });
  }
  /** Probes all half-open members at once (shared probes); the first healthy one wins. Undefined if none by the deadline. */
  private firstHealthy(members:Member[],signal:AbortSignal,deadlineAt:number):Promise<Member|undefined> {
    if(signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Member|undefined>((resolve,reject)=>{
      let pending=members.length, settled=false;
      const finish=(value:Member|undefined,error?:unknown)=>{
        if(settled) return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',onAbort);
        if(error!==undefined) reject(error);else resolve(value);
      };
      const onAbort=()=>finish(undefined,signal.reason);
      const timer=setTimeout(()=>finish(undefined),Math.max(0,deadlineAt-Date.now()));
      signal.addEventListener('abort',onAbort,{once:true});
      for(const member of members) void member.health.probeHealth().then(ok=>{if(ok) finish(member);else if(--pending===0) finish(undefined);});
    });
  }
  private async callPrimary(member:Member,reservation:Reservation,request:ChatCompletionRequest,signal:AbortSignal,openGeneration:number|undefined):Promise<UpstreamResult> {
    const tail:Uint8Array[]=[];
    const release=(completed=false)=>{
      if(completed&&reservation.ok) {
        const actual=promptTokens(Buffer.concat(tail).toString('utf8'));
        if(actual) this.record(member.ratios,reservation.estimate.tokens/actual*1000);
      }
      this.release(member,reservation,completed);
    };
    const first=()=>this.firstChunk(member,reservation);
    const chunk=(data:Uint8Array)=>{first();tail.push(data);if(tail.length>USAGE_CHUNKS) tail.shift();};
    const headers=new AbortController();
    const timer=this.options.headersTimeoutMs?setTimeout(()=>headers.abort(new DOMException('primary headers timeout','TimeoutError')),this.options.headersTimeoutMs):undefined;
    const primarySignal=AbortSignal.any([signal,headers.signal]);
    try {
      // The request key is for billing on the secondary; it is not sent to the engine.
      const result=await member.upstream.complete(request,primarySignal);
      member.health.answered(openGeneration);member.answered++;this.counts.primary++;reservation.ok=result.status>=200&&result.status<300;
      const body=typeof result.body==='string'?(chunk(Buffer.from(result.body)),release(true),result.body):relaying(result.body,chunk,release,signal);
      return {...result,body,...(this.pool.secondary?{upstream:'primary' as const}:{})};
    } catch(error) {
      // The breaker learns of the failure before the slot is handed to a queued request.
      if(!(error instanceof UpstreamConnectError)) {
        // Sent and unanswered in time (the gateway's deadline, the headers timeout, or the HTTP client's own
        // timeout): it may be in the model, so it is never retried elsewhere.
        const timeout=isTimeout(error)?error:primarySignal.aborted&&isTimeout(primarySignal.reason)?primarySignal.reason:undefined;
        // A caller that left after waiting at least the headers timeout without headers saw a hung primary too
        // (e.g. the timer ran late); it is counted for the breaker only, and the caller's own error is kept.
        const gaveUp=!timeout&&signal.aborted&&this.options.headersTimeoutMs>0&&Date.now()-reservation.dispatchedAt>=this.options.headersTimeoutMs;
        if(timeout||gaveUp) member.health.timedOut();
        release();
        throw timeout??error;
      }
      member.connectFailures++;member.health.connectFailed();
      release();
      throw error;
    } finally {clearTimeout(timer);}
  }
  /**
   * Prefill done: U is released. Successful answers only: they count toward the prefill rate (fast errors would inflate
   * it) and the TTFT metrics, and their prefixes are now in the engine's cache (recorded in its table).
   */
  private firstChunk(member:Member,reservation:Reservation):void {
    if(reservation.firstChunk||reservation.released) return;
    reservation.firstChunk=true;member.prefill-=reservation.prefill;
    if(reservation.ok) {
      const now=Date.now();
      this.processed.push({at:now,tokens:reservation.prefill});
      this.record(member.ttfts,now-reservation.dispatchedAt);this.record(this.ttfts,now-reservation.arrivedAt);
      if(!member.gone) member.prefix.record(reservation.estimate.chain);
    }
    while(this.processed.length&&Date.now()-this.processed[0]!.at>RATE_WINDOW_MS) this.processed.shift();
    this.kick();
  }
  private release(member:Member,reservation:Reservation,completed=false):void {
    if(reservation.released) return;reservation.released=true;
    if(reservation.ok&&completed) {const now=Date.now();this.record(member.e2es,now-reservation.dispatchedAt);this.record(this.e2es,now-reservation.arrivedAt);}
    member.inFlight--;member.kvReserved-=reservation.kv;
    if(!reservation.firstChunk) member.prefill-=reservation.prefill;
    if(member.gone&&member.inFlight<=0) this.retiring.delete(member);
    this.kick();
  }
  /** Uncached prompt tokens per second reaching a first chunk over the last 10 s (null before `minSamples`). */
  private prefillRate(minSamples=1):number|null {
    const now=Date.now();
    while(this.processed.length&&now-this.processed[0]!.at>RATE_WINDOW_MS) this.processed.shift();
    if(this.processed.length<Math.max(1,minSamples)) return null;
    const span=Math.max(1000,now-this.processed[0]!.at);
    return this.processed.reduce((sum,entry)=>sum+entry.tokens,0)/(span/1000);
  }
  /** Retry-After for a marked rejection: the tokens queued at this band and above over the recent prefill rate. */
  retryAfterSeconds(band:Band=0):number {return queueRetryAfterSeconds(this.queue.tokensAhead(band),this.prefillRate());}
  private record(list:number[],value:number):void {list.push(value);if(list.length>SAMPLE) list.shift();}
  private log(line:string):void {(this.pool.log??((text:string)=>process.stderr.write(`${text}\n`)))(line);}
  private logDecision(pending:Pending,decision:RouteDecision<{id:string}>):void {
    this.routeLog(pending.requestKey,pending.band,pending.estimate.tokens,decision.scores,decision.member.id,pending.retry?'retry':decision.reason,
      decision.affinity,Date.now()-pending.arrivedAt);
  }
  /**
   * §8 routing decision log, sampled (PTR_GATEWAY_ROUTE_LOG_SAMPLE): no text, the request key only as a per-process salted sha256[:12], member
   * ids (registry ids, never URLs), h_u and cost_u of the candidates. `affinity` (outcome) only when affinity is on.
   */
  private routeLog(requestKey:string|undefined,band:Band,tokens:number,scores:{id:string;h:number;cost:number}[],pick:string,reason:string,
    affinity:AffinityOutcome|null,waitMs:number):void {
    const sample=this.pool.routeLogSample??0.01;
    if(!(sample>0&&(this.pool.random??Math.random)()<sample)) return;
    const rk=requestKey?createHash('sha256').update(HASH_SALT).update(requestKey).digest('hex').slice(0,12):'-';
    const map=(key:'h'|'cost')=>`{${scores.map(score=>`${score.id}:${score[key]}`).join(',')}}`;
    this.log(`route rk=${rk} pool=${this.model} band=${band} est=${tokens} h=${map('h')} cost=${map('cost')} pick=${pick} reason=${reason}`
      +`${affinity?` affinity=${affinity}`:''} wait=${Math.max(0,Math.round(waitMs))}ms`);
  }
  private limit(member:Member,now:number):number {
    const max=member.record.maxSeqs, ramp=this.pool.slowStartMs??30000;
    if(!Number.isFinite(max)||ramp<=0) return max;
    return Math.max(1,Math.floor(max*Math.min(1,(now-member.rampFrom)/ramp)));
  }
  private ramping(member:Member,now:number):boolean {return now-member.rampFrom<(this.pool.slowStartMs??30000);}
  /** A fresh breaker for the member; when it closes again the member's limit ramps from 1 (slow start, §5). */
  private newHealth(member:Member,breaker:BreakerOptions):UpstreamHealth {
    const health:UpstreamHealth=new UpstreamHealth(probe=>member.upstream.health(probe),breaker,()=>{
      // Called on open and on close: closed now means it just closed (a cold engine must not get the whole queue).
      // Not when a call sent while open closed it: that upstream was the only alternative and is already serving.
      if(!health.isOpen&&!health.closedByAnswer&&member.health===health) {member.rampFrom=this.now();member.rampReason='breaker_closed';}
      // Open: the engine is unreachable and may come back empty (restarted), so what the table says is no longer known.
      if(health.isOpen&&member.health===health) member.prefix.clear();
      this.kick();
    });
    return health;
  }
  /** Engine restart seen in telemetry (file/env sources keep their epoch; a registry epoch override may too): start over. */
  private restarted(member:Member,breaker:BreakerOptions):void {
    if(member.gone) return;
    member.health=this.newHealth(member,breaker);member.rampFrom=this.now();member.rampReason='restarted';this.events.restarted++;member.prefix.clear();
  }
  /** Applies the source's snapshot: add (slow start unless loading at startup), update, drain, retire. */
  private sync():void {
    const now=this.now(), seen=new Set<string>();
    const breaker={failureThreshold:this.options.failureThreshold,timeoutThreshold:this.options.timeoutThreshold,
      cooldownMs:this.options.cooldownMs,probeTimeoutMs:this.options.probeTimeoutMs};
    for(const record of this.pool.source.snapshot()) {
      seen.add(record.id);
      let member=this.members.get(record.id);
      // A new epoch (engine restarted) or another address is a new upstream: fresh breaker, slow start again.
      if(member&&(member.record.epoch!==record.epoch||member.record.baseUrl!==record.baseUrl)) {this.retire(member);this.events.replaced++;member=undefined;}
      if(member) {member.record=record;continue;}
      if(record.state!=='active') continue;
      let upstream:Primary;
      try {upstream=this.create(record);} catch {this.events.invalid++;continue;}
      const added=new Member(record,upstream,this.startingUp?-Infinity:now,'added');
      added.health=this.newHealth(added,breaker);
      // A new member (or a new epoch / address of one) starts with an empty table: nothing of ours is cached there yet.
      added.prefix=new PrefixTable({ttlMs:this.pool.prefixTtlMs??120000,capacityTokens:()=>added.record.kvCapacityTokens,maxEntries:PREFIX_MAX_ENTRIES,now:this.now});
      const telemetry=this.pool.telemetry, metrics=upstream.metrics?.bind(upstream);
      if(telemetry&&metrics) {
        added.telemetry=new EngineTelemetry(metrics,{...telemetry,now:this.now,maxSeqs:()=>added.record.maxSeqs,
          warn:line=>this.log(`WARNING gateway upstream ${added.record.id}: ${line}`)},event=>{
          if(event.restarted) this.restarted(added,breaker);
          // Several processes answer on the port: one of them may be a restarted (empty) engine the table knows nothing about.
          // Re-armed on another process than before: what the table recorded may have been served by a process now gone.
          if(event.detectionOff||event.baselineChanged) added.prefix.clear();
          this.kick();});
        added.telemetry.start();
      }
      this.members.set(record.id,added);
      if(!this.startingUp) this.events.added++;
    }
    for(const member of [...this.members.values()]) if(!seen.has(member.record.id)) {this.retire(member);this.events.removed++;}
    if(!this.startingUp) this.kick();
  }
  private retire(member:Member):void {
    this.members.delete(member.record.id);member.gone=true;member.telemetry?.stop();
    if(member.inFlight>0) this.retiring.add(member);
  }
  poolMetrics():PoolMetrics {
    const now=this.now(), kappa=this.pool.kappa??0.9;
    const upstreams=[...this.members.values(),...this.retiring].map((member):UpstreamMemberMetrics=>{
      const limit=this.limit(member,now), capacity=member.record.kvCapacityTokens;
      const budget=capacity===null?null:kappa*capacity-this.globalPrefix;
      return {id:member.record.id,epoch:member.record.epoch,state:member.gone?'gone':member.record.state,inFlight:member.inFlight,
        limit:Number.isFinite(limit)?limit:null,maxSeqs:Number.isFinite(member.record.maxSeqs)?member.record.maxSeqs:null,weight:member.record.weight,
        slowStart:!member.gone&&this.ramping(member,now),rampReason:!member.gone&&this.ramping(member,now)?member.rampReason:null,breaker:member.health.state(),
        reservedKvTokens:member.kvReserved,prefillTokens:member.prefill,kvCapacityTokens:capacity,prefillTokensPerSec:member.record.prefillTokensPerSec??null,
        seqUtil:Number.isFinite(limit)?Math.round(member.inFlight/limit*1000)/1000:null,kvUtil:budget&&budget>0?Math.round(member.kvReserved/budget*1000)/1000:null,
        dispatched:member.dispatched,answered:member.answered,connectFailures:member.connectFailures,
        telemetry:member.telemetry&&!member.gone?member.telemetry.metrics():null,
        ttftMs:quantiles(member.ttfts),e2eMs:quantiles(member.e2es),
        estOverActualTokens:{...quantiles(member.ratios,1000),n:member.ratios.length},prefix:{...member.prefix.metrics(),extraHits:member.extraHits}};
    });
    const count=(check:(u:UpstreamMemberMetrics)=>boolean)=>upstreams.filter(check).length;
    const rate=this.prefillRate();
    return {pool:this.model,
      members:{active:count(u=>u.state==='active'),ramping:count(u=>u.state==='active'&&u.slowStart),draining:count(u=>u.state==='draining'),
        gone:count(u=>u.state==='gone'),breakerOpen:count(u=>u.state!=='gone'&&u.breaker!=='closed'),
        telemetryBlocked:count(u=>!!u.telemetry?.blocked),telemetryStale:count(u=>!!u.telemetry?.stale)},
      waiting:this.queue.size,retriedOnOtherPrimary:this.counts.retried,queueTimeouts:this.counts.queueTimeouts,events:{...this.events},
      queue:{routing:this.routing,fairness:this.pool.fairness??'fifo',queued:this.queue.counts(),queuedTokens:this.queue.queuedTokens,
        waitMs:{p50:percentile(this.waits,0.5),p95:percentile(this.waits,0.95)},rejected:{...this.rejected},globalPrefixTokens:this.globalPrefix,
        prefillTokensPerSec:rate===null?null:Math.round(rate)},
      telemetry:this.pool.telemetry?{intervalMs:this.pool.telemetry.intervalMs,kvHigh:this.pool.telemetry.kvHigh,waitingMax:this.pool.telemetry.waitingMax,
        timeoutMs:this.pool.telemetry.timeoutMs??Math.min(500,this.pool.telemetry.intervalMs)}:null,
      latency:{ttftMs:quantiles(this.ttfts),e2eMs:quantiles(this.e2es)},
      affinity:{mode:this.pool.affinity?'on':'off',...(this.pool.affinity??DEFAULT_AFFINITY),...this.affinityCounts},prefixTtlMs:this.pool.prefixTtlMs??120000,
      upstreams,...(this.pool.source.metrics?{registry:this.pool.source.metrics()}:{})};
  }
  private secondaryMetrics():FailoverMetrics {
    const breakers=[...this.members.values()].map(member=>member.health.metrics());
    const state:BreakerState=!breakers.length?'open':breakers.some(b=>b.state==='closed')?'closed':breakers.some(b=>b.state==='half_open')?'half_open':'open';
    const sum=(key:'opened'|'probesOk'|'probesFailed')=>breakers.reduce((total,b)=>total+b[key],0);
    const max=(key:'consecutiveFailures'|'consecutiveTimeouts')=>breakers.reduce((top,b)=>Math.max(top,b[key]),0);
    return {secondary:this.pool.secondary!.model,
      breaker:{state,consecutiveFailures:max('consecutiveFailures'),consecutiveTimeouts:max('consecutiveTimeouts'),opened:sum('opened'),probesOk:sum('probesOk'),probesFailed:sum('probesFailed')},
      answered:{primary:this.counts.primary,secondary:this.counts.secondary},failovers:{...this.failovers},
      closedNotFailedOver:this.counts.closedNotFailedOver,rateLimited:this.counts.rateLimited,secondaryErrors:this.counts.secondaryErrors,perMinuteCap:this.perMinuteCap()};
  }
}
