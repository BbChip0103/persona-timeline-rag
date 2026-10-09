import type { ChatReply } from '@ptr/contracts';
import type { TurnDispatcherEvent } from '@ptr/core';
import { Counter, Histogram, TURN_SECONDS_BUCKETS, commonFamilies, createLog, renderFamilies } from '@ptr/ops';

/**
 * Metrics and JSON log events of the api, worker and dispatcher roles . Labels are fixed enums or
 * constant-like codes; turn ids appear in log lines only (never as labels), user and model text never.
 */
const CODE=/^[A-Za-z0-9_]{1,40}$/;
const code=(value:string|undefined)=>value!==undefined&&CODE.test(value)?value:'UNSPECIFIED';
/** Model upstream kinds as recorded in reply.serving (D21). */
const UPSTREAM_KINDS=new Set(['primary','secondary','fake','openrouter','direct']);

/** Route label: a fixed name per API route (ids never become labels). */
export function routeLabel(path:string):string {
  const routes:[RegExp,string][]=[[/^\/api\/health$/,'health'],[/^\/api\/personas$/,'personas'],[/^\/api\/sessions$/,'sessions'],
    [/^\/api\/sessions\/[^/]+$/,'session'],[/^\/api\/sessions\/[^/]+\/turns$/,'send_turn'],[/^\/api\/sessions\/[^/]+\/drafts$/,'draft'],
    [/^\/api\/turns\/[^/]+$/,'turn'],[/^\/api\/turns\/[^/]+\/events$/,'turn_events'],[/^\/api\/turns\/[^/]+\/cancel$/,'cancel_turn'],[/^\/metrics\/prom$/,'metrics']];
  return routes.find(([pattern])=>pattern.test(path))?.[1]??'other';
}
export class ApiMetrics {
  readonly requests=new Counter();readonly ownerRejected=new Counter();
  turnsCreated=0;sseOpen=0;
  render():string {
    return renderFamilies([...commonFamilies('api'),
      {name:'ptr_http_requests_total',help:'HTTP requests by route and status class.',type:'counter',samples:this.requests.samples()},
      {name:'ptr_turns_created_total',help:'Turns reserved (idempotent repeats excluded).',type:'counter',samples:[{value:this.turnsCreated}]},
      {name:'ptr_sse_streams_open',help:'Turn event streams open now.',type:'gauge',samples:[{value:this.sseOpen}]},
      {name:'ptr_owner_rejected_total',help:'Requests refused for their owner: missing, format, or the other token\'s owner space.',type:'counter',samples:this.ownerRejected.samples()}]);
  }
}

/** Worker: ChatService hooks, the TurnWorker finish hook, and the render of its /metrics/prom. */
export function workerObservability(options:{activeTurns:()=>number;write?:(line:string)=>void}) {
  const log=createLog('worker',options.write);
  const finished=new Counter(), safety=new Counter(), guard=new Counter(), calls=new Counter();
  const duration=new Histogram(TURN_SECONDS_BUCKETS), queueWait=new Histogram(TURN_SECONDS_BUCKETS);
  /** Outcome per turn from the chat hooks, read when the worker reports the turn finished. */
  const outcomes=new Map<string,{outcome:'completed'|'failed';code:string}>();
  const chatHooks={
    onTurnFailure:({turnId,code:failure}:{turnId:string;code:string})=>{outcomes.set(turnId,{outcome:'failed',code:code(failure)});},
    onTurnCompleted:({turnId,reply}:{turnId:string;reply:ChatReply})=>{
      outcomes.set(turnId,{outcome:'completed',code:'none'});
      for(const upstream of reply.serving?.upstreams??[]) calls.inc({upstream_kind:UPSTREAM_KINDS.has(upstream)?upstream:'unknown'});
      if(reply.replyGuard) guard.inc({action:reply.replyGuard.action,reason:reply.replyGuard.reason??'none'});
    },
    onSafetyFallback:({scope,reason}:{scope:'turn'|'draft';reason:string})=>{
      safety.inc({scope,reason:code(reason)});log('input_safety_fallback',{scope,reason:code(reason)});
    },
  };
  /** A claimed turn ended: one counter step and one log line; no chat hook means the lease was lost (or the run threw). */
  const onFinished=({turnId,queueWaitMs,durationMs}:{turnId:string;queueWaitMs:number;durationMs:number})=>{
    const result=outcomes.get(turnId)??{outcome:'abandoned' as const,code:'none'};outcomes.delete(turnId);
    finished.inc(result);duration.observe(durationMs/1000);queueWait.observe(queueWaitMs/1000);
    log('turn_finished',{turnId,...result,durationMs,queueWaitMs});
  };
  const render=()=>renderFamilies([...commonFamilies('worker'),
    {name:'ptr_turns_finished_total',help:'Turns this worker ran to an end, by outcome and error code.',type:'counter',samples:finished.samples()},
    {name:'ptr_turn_duration_seconds',help:'Claim to end of a turn.',type:'histogram',samples:duration.samples()},
    {name:'ptr_turn_queue_wait_seconds',help:'Turn creation to claim.',type:'histogram',samples:queueWait.samples()},
    {name:'ptr_turns_inflight',help:'Turns running on this worker now.',type:'gauge',samples:[{value:options.activeTurns()}]},
    {name:'ptr_safety_fallback_total',help:'Input safety filter fell back to the rules (fail-open), by scope and reason.',type:'counter',samples:safety.samples()},
    {name:'ptr_reply_guard_total',help:'Reply guard outcomes of completed turns, by action and reason.',type:'counter',samples:guard.samples()},
    {name:'ptr_model_calls_total',help:'Model calls of completed turns, by the upstream that answered (reply.serving).',type:'counter',samples:calls.samples()}]);
  return {chatHooks,onFinished,render,log};
}

/** A gauge read at scrape time; a failing or slow source (1 s) leaves the sample out. */
async function reading(read:()=>Promise<number>):Promise<number|undefined> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([read(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('timeout')),1000);})]);}
  catch {return undefined;}
  finally {clearTimeout(timer);}
}
/** Dispatcher: the TurnDispatcher event hook and the render of its /metrics/prom. */
export function dispatcherObservability(options:{queueWaiting:()=>Promise<number>;oldestPendingAgeSeconds:()=>Promise<number>;write?:(line:string)=>void}) {
  const log=createLog('dispatcher',options.write);
  const failed=new Counter();let requeued=0, republished=0;
  const onEvent=(event:TurnDispatcherEvent)=>{
    if(event.type==='requeued') {requeued++;log('turn_requeued',{turnId:event.turnId});}
    else if(event.type==='failed') {failed.inc({code:event.errorCode});log('turn_failed',{turnId:event.turnId,code:event.errorCode});}
    else {republished++;log('turn_republished',{turnId:event.turnId});}
  };
  const render=async()=>{
    const [waiting,oldest]=await Promise.all([reading(options.queueWaiting),reading(options.oldestPendingAgeSeconds)]);
    return renderFamilies([...commonFamilies('dispatcher'),
      {name:'ptr_dispatch_requeued_total',help:'Turns requeued after their worker lease expired.',type:'counter',samples:[{value:requeued}]},
      {name:'ptr_dispatch_failed_total',help:'Turns the dispatcher failed, by code (WORKER_LOST, QUEUE_TIMEOUT).',type:'counter',samples:failed.samples()},
      {name:'ptr_outbox_republished_total',help:'Outbox dispatches published again (never reached a worker).',type:'counter',samples:[{value:republished}]},
      {name:'ptr_queue_waiting',help:'Jobs waiting in the turn queue (BullMQ wait).',type:'gauge',samples:waiting===undefined?[]:[{value:waiting}]},
      {name:'ptr_oldest_pending_age_seconds',help:'Age of the oldest unclaimed outbox dispatch, since its turn was created or last requeued (0 when none).',type:'gauge',samples:oldest===undefined?[]:[{value:oldest}]}]);
  };
  return {onEvent,render,log};
}
