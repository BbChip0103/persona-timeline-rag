import { UpstreamPool, type FailoverMetrics, type FailoverOptions, type Primary } from './pool';
import { StaticUpstreamSource } from './sources';
import type { ChatCompletionRequest, RequestContext, Upstream, UpstreamResult } from './upstreams';

/**
 * Primary (self-hosted engine) with a secondary used only when the primary certainly did not answer: a
 * connection-phase failure, a connection closed before any response byte (`failOverOnClose`), or the breaker is
 * open (the request is then never sent to the primary). It runs inside the gateway's admission slot, so a full
 * gateway queue is still rejected and never spills over. Timeouts after sending, HTTP errors and streams cut
 * mid-response are surfaced, not retried elsewhere. Breaker: see UpstreamHealth.
 * This is an UpstreamPool with one fixed, uncapped member (the env-only PTR_SELFHOSTED_* case).
 */
export class FailoverUpstream implements Upstream {
  readonly model:string;
  private readonly pool:UpstreamPool;
  constructor(primary:Primary,private readonly secondary:Upstream,options:Partial<FailoverOptions>={}) {
    this.model=primary.model;
    this.pool=new UpstreamPool({model:primary.model,create:()=>primary,secondary,failover:options,
      source:new StaticUpstreamSource([{pool:primary.model,id:'primary',baseUrl:'static:primary',maxSeqs:Infinity,kvCapacityTokens:null,weight:1,state:'active',epoch:'static',seq:0}])});
  }
  async ready(signal:AbortSignal):Promise<void> {await this.secondary.ready?.(signal);}
  complete(request:ChatCompletionRequest,signal:AbortSignal,context?:RequestContext):Promise<UpstreamResult> {return this.pool.complete(request,signal,context);}
  failoverMetrics():FailoverMetrics {return this.pool.failoverMetrics!();}
}
