import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TextProvider } from '@ptr/core';
import { parseExposition, PROM_CONTENT_TYPE } from '@ptr/ops';
import { createGateway, FailoverUpstream, gatewayFamilies, StaticUpstreamSource, TextProviderUpstream, UpstreamConnectError, UpstreamPool,
  type GatewayMetrics, type GatewayOptions, type Primary, type Upstream, type UpstreamResult } from '../src';

// : the gateway's /metrics/prom names, exactly (plus the O2 retry-deadline counter).
const GATEWAY_NAMES=['ptr_build_info','process_start_time_seconds','ptr_gateway_requests_total','ptr_gateway_rejected_total','ptr_gateway_served_total',
  'ptr_gateway_breaker_open','ptr_gateway_breaker_opened_total','ptr_gateway_failover_total','ptr_gateway_deadline_aborts_total','ptr_gateway_retry_deadline_total',
  'ptr_gateway_inflight','ptr_gateway_queue_waiting','ptr_gateway_ttft_seconds','ptr_gateway_upstream_timeouts_total'];
const token='synthetic_gateway_token_abcdefghij';
const messages=[{role:'user',content:'SENTINEL-user-text 안녕'}];
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));});
async function gateway(upstream:Upstream,options:Partial<GatewayOptions>={}) {
  const g=createGateway({token,upstream,limits:{maxConcurrent:2,maxQueue:2,queueTimeoutMs:2000,upstreamTimeoutMs:30000},...options});
  servers.push(g.server);await new Promise<void>(r=>g.server.listen(0,'127.0.0.1',r));
  return {g,base:`http://127.0.0.1:${(g.server.address() as AddressInfo).port}`};
}
const post=(base:string,headers:Record<string,string>={})=>fetch(`${base}/v1/chat/completions`,
  {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify({messages,stream:true})});
const scrape=async(base:string)=>{
  const response=await fetch(`${base}/metrics/prom`);
  expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe(PROM_CONTENT_TYPE);
  const text=await response.text();expect(text).not.toContain('SENTINEL');
  return {text,parsed:parseExposition(text)};
};
const value=(parsed:ReturnType<typeof parseExposition>,name:string,labels:Record<string,string>={})=>
  parsed.samples.find(sample=>sample.name===name&&Object.entries(labels).every(([key,v])=>sample.labels[key]===v))?.value;
const reply:TextProvider={generate:async()=> '반가워요.'};

describe('gateway /metrics/prom ',()=>{
  test('open without the token (loopback, aggregates only); the names are exactly the §6 list',async()=>{
    const {base}=await gateway(new TextProviderUpstream(reply,'synthetic/fake-text-v1'));
    expect((await fetch(`${base}/metrics`)).status).toBe(403); // the JSON metrics keep their token
    const {parsed}=await scrape(base);
    expect([...parsed.types.keys()].sort()).toEqual([...GATEWAY_NAMES].sort());
    expect(value(parsed,'ptr_build_info',{role:'gateway'})).toBe(1);
  });
  test('X-PTR-Upstream is always sent (D21): the fake model is `fake`, a single engine `primary`; served counts follow it',async()=>{
    const fake=await gateway(new TextProviderUpstream(reply,'synthetic/fake-text-v1'));
    const answered=await post(fake.base);expect(answered.headers.get('x-ptr-upstream')).toBe('fake');await answered.text();
    const real=await gateway(new TextProviderUpstream(reply,'google/gemma-4-26b-a4b-it'));
    const second=await post(real.base);expect(second.headers.get('x-ptr-upstream')).toBe('primary');await second.text();
    const {parsed}=await scrape(fake.base);
    expect(value(parsed,'ptr_gateway_served_total',{upstream:'fake'})).toBe(1);
    expect(value(parsed,'ptr_gateway_requests_total',{result:'completed'})).toBe(1);
  });
  test('O2 counters: a marked deadline refusal is rejected{reason="deadline"} and counts as a rejected request',async()=>{
    const {base}=await gateway(new TextProviderUpstream(reply,'m'));
    expect((await post(base,{'X-PTR-Deadline':String(Date.now()+1000)})).status).toBe(503);
    const {parsed}=await scrape(base);
    expect(value(parsed,'ptr_gateway_rejected_total',{reason:'deadline'})).toBe(1);
    expect(value(parsed,'ptr_gateway_requests_total',{result:'rejected'})).toBe(1);
    expect(value(parsed,'ptr_gateway_deadline_aborts_total')).toBe(0);
  });
  test('failover: served by the secondary, the primary breaker, failovers by reason; upstream errors log the raw turn id only',async()=>{
    const lines:string[]=[];
    const primary:Primary={model:'m',health:async()=>false,complete:()=>Promise.reject(new UpstreamConnectError('connect_refused',true))};
    const secondary=new TextProviderUpstream(reply,'secondary/model');
    const failover=new FailoverUpstream(primary,secondary,{failureThreshold:1,cooldownMs:60000});
    const {base}=await gateway(failover,{log:line=>lines.push(line)});
    for(let i=0;i<2;i++) {const response=await post(base,{'X-PTR-Request-Key':`turn-${i}`});expect(response.headers.get('x-ptr-upstream')).toBe('secondary');await response.text();}
    const {parsed}=await scrape(base);
    expect(value(parsed,'ptr_gateway_served_total',{upstream:'secondary'})).toBe(2);
    expect(value(parsed,'ptr_gateway_breaker_open',{upstream:'primary'})).toBe(1);
    expect(value(parsed,'ptr_gateway_breaker_opened_total',{upstream:'primary'})).toBe(1);
    expect(value(parsed,'ptr_gateway_failover_total',{reason:'connect_refused'})).toBe(1);
    expect(value(parsed,'ptr_gateway_failover_total',{reason:'breaker_open'})).toBe(1);
    // Errors: the request key (the worker's turn id) is logged as is (D20), never message text.
    const failing=await gateway(new TextProviderUpstream({generate:async()=>{throw new Error('SENTINEL-model-text');}},'m'),{log:line=>lines.push(line)});
    expect((await post(failing.base,{'X-PTR-Request-Key':'3f1c2a9e-0000-4000-8000-00000000000a'})).status).toBe(502);
    const events=lines.map(line=>JSON.parse(line));
    expect(events).toContainEqual(expect.objectContaining({role:'gateway',event:'gateway_upstream_error',turnId:'3f1c2a9e-0000-4000-8000-00000000000a',code:'UPSTREAM_UNAVAILABLE',midStream:false}));
    expect(lines.join('\n')).not.toContain('SENTINEL');
  });
});

test('a fake failover secondary (load tests) is still `fake`, never `secondary`, so fake replies are never taken for real ones',async()=>{
  const primary:Primary={model:'m',health:async()=>false,complete:()=>Promise.reject(new UpstreamConnectError('connect_refused',true))};
  const {base}=await gateway(new FailoverUpstream(primary,new TextProviderUpstream(reply,'synthetic/fake-text-v1'),{failureThreshold:1,cooldownMs:60000}));
  const response=await post(base);expect(response.headers.get('x-ptr-upstream')).toBe('fake');await response.text();
  expect(value((await scrape(base)).parsed,'ptr_gateway_served_total',{upstream:'fake'})).toBe(1);
});

describe('gatewayFamilies for an upstream pool',()=>{
  const base:GatewayMetrics={upstream:'m',inFlight:3,queued:2,accepted:10,completed:7,upstreamErrors:1,rejected:{queueFull:1,queueTimeout:2,draining:0,deadline:1},
    deadlineAborts:1,draining:false,queueWaitMs:{p50:null,p95:null},upstreamMs:{p50:null,p95:null},capacity:{maxConcurrent:8,maxQueue:256,total:264}};
  test('per-member breaker state, opened count and timeouts by registry id; TTFT histogram; retry-deadline counter',async()=>{
    const pool=new UpstreamPool({model:'m',source:new StaticUpstreamSource([{pool:'m',id:'gpu-a',baseUrl:'static:a',maxSeqs:4,kvCapacityTokens:null,weight:1,state:'active',epoch:'e',seq:0}]),
      create:()=>({model:'m',health:async()=>true,complete:async():Promise<UpstreamResult>=>({status:200,contentType:'application/json',body:'{}'})}),admission:true,routeLogSample:0});
    const poolMetrics=pool.poolMetrics();
    const metrics:GatewayMetrics={...base,pool:{...poolMetrics,retryDeadline:4,
      upstreams:poolMetrics.upstreams.map(member=>({...member,breaker:'open',breakerOpened:2,timeouts:3}))}};
    // A real call through the pool feeds its TTFT histogram (arrival to first chunk).
    await pool.complete({messages},new AbortController().signal);
    const parsed=parseExposition(gatewayFamilies(metrics,{served:{primary:7},timeouts:0,ttft:pool.ttftSeconds.samples()}));
    expect(value(parsed,'ptr_gateway_breaker_open',{upstream:'gpu-a'})).toBe(1);
    expect(value(parsed,'ptr_gateway_breaker_opened_total',{upstream:'gpu-a'})).toBe(2);
    expect(value(parsed,'ptr_gateway_upstream_timeouts_total',{upstream:'gpu-a'})).toBe(3);
    expect(value(parsed,'ptr_gateway_ttft_seconds_count')).toBe(1);expect(value(parsed,'ptr_gateway_ttft_seconds_bucket',{le:'0.1'})).toBe(1);
    expect(value(parsed,'ptr_gateway_retry_deadline_total')).toBe(4);
    expect(value(parsed,'ptr_gateway_rejected_total',{reason:'queue_timeout'})).toBe(2);
    expect(value(parsed,'ptr_gateway_requests_total',{result:'rejected'})).toBe(4);
    expect(value(parsed,'ptr_gateway_inflight')).toBe(3);expect(value(parsed,'ptr_gateway_queue_waiting')).toBe(2);
    await pool.close();
  });
});
