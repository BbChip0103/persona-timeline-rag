import type { ChatReply } from '@ptr/contracts';
import type { TurnDispatcherEvent } from '@ptr/core';
import {type Registry,Counter,Gauge,Histogram,TURN_SECONDS_BUCKETS,createMetricsRegistry} from '../../../packages/ops/src/metrics';
import {createLog} from '../../../packages/ops/src/log';
import {bounded} from '../../../packages/ops/src/bounded';

/**
 * Metrics and JSON log events of the api and worker roles . Labels are fixed enums or
 * constant-like codes; turn ids appear in log lines only (never as labels), user and model text never.
 */
const CODE=/^[A-Za-z0-9_]{1,40}$/;
const code=(value:string|undefined)=>value!==undefined&&CODE.test(value)?value:'UNSPECIFIED';
/** Model upstream kinds as recorded in reply.serving (D21). `litellm` remains only to read older stored replies safely. */
const UPSTREAM_KINDS=new Set(['primary','secondary','local','local-pool','fake','openrouter','openrouter-primary','direct','litellm']);
const GUARD_ACTIONS=new Set(['none','replaced','edited']);
const GUARD_REASONS=new Set(['human_impersonation','missing_ai_disclosure','private_life','background_denial','meta_talk']);

/** Route label: a fixed name per API route (ids never become labels). */
export function routeLabel(path:string):string {
  const routes:[RegExp,string][]=[[/^\/api\/health$/,'health'],[/^\/api\/personas$/,'personas'],[/^\/api\/sessions$/,'sessions'],
    [/^\/api\/sessions\/[^/]+$/,'session'],[/^\/api\/sessions\/[^/]+\/turns$/,'send_turn'],[/^\/api\/sessions\/[^/]+\/drafts$/,'draft'],
    [/^\/api\/turns\/[^/]+$/,'turn'],[/^\/api\/turns\/[^/]+\/events$/,'turn_events'],[/^\/api\/turns\/[^/]+\/cancel$/,'cancel_turn'],[/^\/metrics\/prom$/,'metrics']];
  return routes.find(([pattern])=>pattern.test(path))?.[1]??'other';
}
export class ApiMetrics {
  readonly registry=createMetricsRegistry('api');
  readonly requests=new Counter({name:'ptr_http_requests_total',help:'HTTP requests by route and status class.',labelNames:['route','status_class'],registers:[this.registry]});
  readonly ownerRejected=new Counter({name:'ptr_owner_rejected_total',help:'Requests refused for their owner: missing, format, or the other token\'s owner space.',labelNames:['reason'],registers:[this.registry]});
  readonly turnsCreated=new Counter({name:'ptr_turns_created_total',help:'Turns reserved (idempotent repeats excluded).',registers:[this.registry]});
  readonly sseOpen=new Gauge({name:'ptr_sse_streams_open',help:'Turn event streams open now.',registers:[this.registry]});
  render():Promise<string> {return this.registry.metrics();}
}

/** Worker: ChatService hooks, the TurnWorker finish hook, and the render of its /metrics/prom. */
export function workerObservability(options:{activeTurns:()=>number;write?:(line:string)=>void}) {
  const log=createLog('worker',options.write);
  const registry=createMetricsRegistry('worker');
  const finished=new Counter({name:'ptr_turns_finished_total',help:'Turns this worker ran to an end, by outcome and error code.',labelNames:['outcome','code'],registers:[registry]});
  const safety=new Counter({name:'ptr_safety_fallback_total',help:'Input safety filter fell back to the rules (fail-open), by scope and reason.',labelNames:['scope','reason'],registers:[registry]});
  const guard=new Counter({name:'ptr_reply_guard_total',help:'Reply guard outcomes of completed turns, by action and reason.',labelNames:['action','reason'],registers:[registry]});
  const calls=new Counter({name:'ptr_model_calls_total',help:'Model calls of completed turns, by the upstream that answered (reply.serving).',labelNames:['upstream_kind'],registers:[registry]});
  const duration=new Histogram({name:'ptr_turn_duration_seconds',help:'Claim to end of a turn.',buckets:[...TURN_SECONDS_BUCKETS],registers:[registry]});
  const queueWait=new Histogram({name:'ptr_turn_queue_wait_seconds',help:'Turn creation to claim.',buckets:[...TURN_SECONDS_BUCKETS],registers:[registry]});
  new Gauge({name:'ptr_turns_inflight',help:'Turns running on this worker now.',registers:[registry],collect(){this.set(options.activeTurns());}});
  /** Outcome per turn from the chat hooks, read when the worker reports the turn finished. */
  const outcomes=new Map<string,{outcome:'completed'|'failed';code:string}>();
  const chatHooks={
    onTurnFailure:({turnId,code:failure}:{turnId:string;code:string})=>{outcomes.set(turnId,{outcome:'failed',code:code(failure)});},
    onTurnCompleted:({turnId,reply}:{turnId:string;reply:ChatReply})=>{
      outcomes.set(turnId,{outcome:'completed',code:'none'});
      for(const upstream of reply.serving?.upstreams??[]) calls.inc({upstream_kind:UPSTREAM_KINDS.has(upstream)?upstream:'unknown'});
      if(reply.replyGuard) guard.inc({action:GUARD_ACTIONS.has(reply.replyGuard.action)?reply.replyGuard.action:'unknown',
        reason:reply.replyGuard.reason===undefined?'none':GUARD_REASONS.has(reply.replyGuard.reason)?reply.replyGuard.reason:'unknown'});
    },
    onSafetyFallback:({scope,reason}:{scope:'turn'|'draft';reason:string})=>{
      const safeScope=scope==='turn'||scope==='draft'?scope:'unknown';
      safety.inc({scope:safeScope,reason:code(reason)});log('input_safety_fallback',{scope:safeScope,reason:code(reason)});
    },
  };
  /** A claimed turn ended: one counter step and one log line; no chat hook means the lease was lost (or the run threw). */
  const onFinished=({turnId,queueWaitMs,durationMs}:{turnId:string;queueWaitMs:number;durationMs:number})=>{
    const result=outcomes.get(turnId)??{outcome:'abandoned' as const,code:'none'};outcomes.delete(turnId);
    finished.inc(result);if(Number.isFinite(durationMs)) duration.observe(durationMs/1000);
    if(Number.isFinite(queueWaitMs)) queueWait.observe(queueWaitMs/1000);
    log('turn_finished',{turnId,...result,durationMs,queueWaitMs});
  };
  const render=()=>registry.metrics();
  return {chatHooks,onFinished,render,log,registry};
}

/** A gauge read at scrape time; a failing or slow source (1 s) leaves the sample out. */
async function reading(read:()=>Promise<number>):Promise<number|undefined> {
  try {return await bounded(read,1000);}
  catch {return undefined;}
}
/** Worker-local outbox maintenance hook, collected on the worker's shared /metrics/prom registry. */
export function workerMaintenanceObservability(registry:Registry,options:{queueWaiting:()=>Promise<number>;oldestPendingAgeSeconds:()=>Promise<number>;write?:(line:string)=>void}) {
  const log=createLog('worker',options.write);
  const failed=new Counter({name:'ptr_dispatch_failed_total',help:'Queued turns expired by worker maintenance, by code.',labelNames:['code'],registers:[registry]});
  const requeued=new Counter({name:'ptr_dispatch_requeued_total',help:'Outbox dispatches repaired by worker compare-and-swap.',registers:[registry]});
  const republished=new Counter({name:'ptr_outbox_republished_total',help:'Outbox dispatches published again (never reached a worker).',registers:[registry]});
  new Gauge({name:'ptr_queue_waiting',help:'Jobs waiting in the turn queue (BullMQ wait).',registers:[registry],async collect(){
    const value=await reading(options.queueWaiting);if(value===undefined||!Number.isFinite(value)) this.remove();else this.set(value);
  }});
  new Gauge({name:'ptr_oldest_pending_age_seconds',help:'Age of the oldest nonterminal outbox dispatch (0 when none).',registers:[registry],async collect(){
    const value=await reading(options.oldestPendingAgeSeconds);if(value===undefined||!Number.isFinite(value)) this.remove();else this.set(value);
  }});
  const onEvent=(event:TurnDispatcherEvent)=>{
    if(event.type==='requeued') {requeued.inc();log('turn_requeued',{turnId:event.turnId});}
    else if(event.type==='failed') {failed.inc({code:event.errorCode});log('turn_failed',{turnId:event.turnId,code:event.errorCode});}
    else {republished.inc();log('turn_republished',{turnId:event.turnId});}
  };
  const render=()=>registry.metrics();
  return {onEvent,render,log};
}
