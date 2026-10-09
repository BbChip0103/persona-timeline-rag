import { commonFamilies, renderFamilies, type Family, type Sample } from '@ptr/ops';
import type { GatewayMetrics } from './server';

/**
 * The gateway's `/metrics/prom` , read from the same numbers as the JSON `/metrics`. Upstream labels are
 * `primary`/`secondary`/`fake` or pool member ids (registry or upstreams-file ids, never URLs). Per-upstream breaker and
 * timeout series come from pool members; a single engine or the env-only failover reports one `primary`.
 */
export function gatewayFamilies(metrics:GatewayMetrics,extra:{served:Record<string,number>;timeouts:number;ttft:Sample[]}):string {
  const {rejected}=metrics, pool=metrics.pool, failover=metrics.failover;
  const members=(pool?.upstreams??[]).filter(member=>member.state!=='gone');
  const perUpstream=(pick:(member:(typeof members)[number])=>number,single:number|undefined):Sample[]=>
    pool?members.map(member=>({labels:{upstream:member.id},value:pick(member)})):single===undefined?[]:[{labels:{upstream:'primary'},value:single}];
  const families:Family[]=[...commonFamilies('gateway'),
    {name:'ptr_gateway_requests_total',help:'Chat requests by result: completed, upstream_error, or rejected before any upstream call.',type:'counter',samples:[
      {labels:{result:'completed'},value:metrics.completed},{labels:{result:'upstream_error'},value:metrics.upstreamErrors},
      {labels:{result:'rejected'},value:rejected.queueFull+rejected.queueTimeout+rejected.draining+rejected.deadline}]},
    {name:'ptr_gateway_rejected_total',help:'Marked rejections (nothing sent upstream) by reason.',type:'counter',samples:[
      {labels:{reason:'queue_full'},value:rejected.queueFull},{labels:{reason:'queue_timeout'},value:rejected.queueTimeout},
      {labels:{reason:'draining'},value:rejected.draining},{labels:{reason:'deadline'},value:rejected.deadline}]},
    {name:'ptr_gateway_served_total',help:'Successful answers by the upstream that served them (X-PTR-Upstream).',type:'counter',
      samples:Object.entries(extra.served).map(([upstream,value])=>({labels:{upstream},value}))},
    {name:'ptr_gateway_breaker_open',help:'1 while the upstream breaker is open or half open (engine unreachable).',type:'gauge',
      samples:perUpstream(member=>member.breaker==='closed'?0:1,failover?(failover.breaker.state==='closed'?0:1):undefined)},
    {name:'ptr_gateway_breaker_opened_total',help:'Times the upstream breaker opened.',type:'counter',
      samples:perUpstream(member=>member.breakerOpened,failover?.breaker.opened)},
    {name:'ptr_gateway_failover_total',help:'Requests sent to the secondary, by reason.',type:'counter',
      samples:Object.entries(failover?.failovers??{}).map(([reason,value])=>({labels:{reason},value}))},
    {name:'ptr_gateway_deadline_aborts_total',help:'Sent calls cut at their X-PTR-Deadline.',type:'counter',samples:[{value:metrics.deadlineAborts}]},
    {name:'ptr_gateway_retry_deadline_total',help:'Retries after a primary attempt not sent because the deadline left too little time.',type:'counter',
      samples:[{value:pool?.retryDeadline??failover?.retryDeadline??0}]},
    {name:'ptr_gateway_inflight',help:'Calls in flight upstream.',type:'gauge',samples:[{value:metrics.inFlight}]},
    {name:'ptr_gateway_queue_waiting',help:'Requests waiting for admission.',type:'gauge',samples:[{value:metrics.queued}]},
    {name:'ptr_gateway_ttft_seconds',help:'Time to first token of successful pool calls, arrival (queue wait included) to first chunk.',type:'histogram',samples:extra.ttft},
    {name:'ptr_gateway_upstream_timeouts_total',help:'Sent calls that timed out on the upstream (not deadline cuts).',type:'counter',
      samples:perUpstream(member=>member.timeouts,pool?undefined:extra.timeouts)},
  ];
  return renderFamilies(families);
}
