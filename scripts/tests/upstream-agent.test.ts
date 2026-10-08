import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { MemoryUpstreamRegistry, parseUpstreamRecord } from '@ptr/messaging';
import { agentTimings, drainUpstream, engineEpoch, parseAgentArgs, parseEngineMetrics, runAgent, type AgentHandle } from '../upstream-agent';

const VLLM_METRICS=`# HELP vllm:num_requests_running Number of requests in model execution batches.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="gemma-4-e4b-fp8"} 3.0
vllm:num_requests_running{engine="1",model_name="gemma-4-e4b-fp8"} 1.0
# TYPE vllm:num_requests_waiting gauge
vllm:num_requests_waiting{engine="0",model_name="gemma-4-e4b-fp8"} 2.0
# TYPE vllm:cache_config_info gauge
vllm:cache_config_info{block_size="16",cache_dtype="auto",enable_prefix_caching="True",gpu_memory_utilization="0.9",num_gpu_blocks="21687"} 1.0
# TYPE process_start_time_seconds gauge
process_start_time_seconds 1.7600123456e+09
`;

/** Fake engine: /health status, /metrics with running/waiting/start time; all mutable. */
function fakeEngine() {
  const state={health:200,running:0,waiting:0,start:1760000000,kvBlocks:1000 as number|null,metrics:true};
  const server=createServer((req,res)=>{
    if(req.url==='/health'){res.writeHead(state.health);res.end();return;}
    if(req.url==='/metrics'&&state.metrics){res.writeHead(200,{'Content-Type':'text/plain'});
      res.end(`vllm:num_requests_running{model_name="m"} ${state.running}\nvllm:num_requests_waiting{model_name="m"} ${state.waiting}\n`
        +(state.kvBlocks===null?'':`vllm:cache_config_info{block_size="16",num_gpu_blocks="${state.kvBlocks}"} 1.0\n`)+`process_start_time_seconds ${state.start}\n`);return;}
    res.writeHead(404);res.end();
  });
  return {server,state};
}
const servers:Server[]=[];const agents:AgentHandle[]=[];
afterEach(async()=>{
  for(const agent of agents.splice(0)) agent.kill();
  await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));
});
async function listen(server:Server):Promise<string> {servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;}
const until=async(check:()=>boolean|Promise<boolean>,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw new Error('condition not met');};
const fast={heartbeatMs:40,ttlMs:400,drainSettleMs:100,drainMaxMs:3000,healthPollMs:20,engineFailures:2};
const live=async(store:MemoryUpstreamRegistry)=>(await store.list('m')).records.map(parseUpstreamRecord);
function agent(store:MemoryUpstreamRegistry,baseUrl:string,extra:Record<string,unknown>={}) {
  const handle=runAgent(store,{pool:'m',id:'pod-a',baseUrl,...fast,log:()=>undefined,...extra});agents.push(handle);return handle;
}

describe('engine metrics (vLLM Prometheus text)',()=>{
  test('running/waiting are summed over label sets; KV capacity = num_gpu_blocks × block_size; start time read',()=>{
    expect(parseEngineMetrics(VLLM_METRICS)).toEqual({running:4,waiting:2,kvCapacityTokens:21687*16,startTimeSeconds:1760012345.6});
    expect(parseEngineMetrics('# nothing here\n')).toEqual({running:null,waiting:null,kvCapacityTokens:null,startTimeSeconds:null});
  });
  test('the epoch is derived from the engine start time: stable across agent restarts, new for a new engine process',()=>{
    const a=engineEpoch('pod-a','http://127.0.0.1:18000/v1',1760000000);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(engineEpoch('pod-a','http://127.0.0.1:18000/v1',1760000000)).toBe(a);
    expect(engineEpoch('pod-a','http://127.0.0.1:18000/v1',1760000001)).not.toBe(a);
  });
});

describe('ptr-upstream-agent',()=>{
  test('waits for /health 200, then registers (epoch from the start time, KV from metrics) and heartbeats',async()=>{
    const engine=fakeEngine();engine.state.health=503;const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);const handle=agent(store,base);
    await new Promise(r=>setTimeout(r,150));
    expect(await live(store)).toEqual([]);expect(handle.status().phase).toBe('waiting');
    engine.state.health=200;
    await until(async()=>(await live(store)).length===1);
    const [record]=await live(store);
    expect(record).toMatchObject({pool:'m',id:'pod-a',baseUrl:base,maxSeqs:12,kvCapacityTokens:16000,weight:1,state:'active',epoch:engineEpoch('pod-a',base,1760000000)});
    await until(async()=>(await live(store))[0]!.seq>=3);
    // The record outlives its TTL only through heartbeats.
    await new Promise(r=>setTimeout(r,500));expect(await live(store)).toHaveLength(1);
  });
  test('without KV metrics the --kv-capacity-tokens value is used; a restarted agent comes back with the same epoch',async()=>{
    const engine=fakeEngine();engine.state.kvBlocks=null;const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);
    const first=agent(store,base,{kvCapacityTokens:43000});
    await until(async()=>(await live(store)).length===1);
    const {epoch,kvCapacityTokens}=(await live(store))[0]!;expect(kvCapacityTokens).toBe(43000);
    first.kill();await first.done;
    await until(async()=>(await live(store)).length===0,2000); // expired: nobody heartbeats
    agent(store,base,{kvCapacityTokens:43000});
    await until(async()=>(await live(store)).length===1);
    expect((await live(store))[0]!.epoch).toBe(epoch);
  });
  test('drain from the registry (CLI): stays draining while the engine works, then deletes the record and stops',async()=>{
    const engine=fakeEngine();engine.state.running=2;const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);const handle=agent(store,base);
    await until(async()=>(await live(store)).length===1);
    const drained=drainUpstream(store,'m','pod-a',{timeoutMs:5000,pollMs:20});
    await until(()=>handle.status().phase==='draining');
    await new Promise(r=>setTimeout(r,300));
    expect((await live(store))[0]).toMatchObject({state:'draining'}); // still busy: kept (heartbeats keep it alive)
    engine.state.running=0;
    expect(await drained).toBe('drained');
    expect(await handle.done).toBe('drained');expect(await live(store)).toEqual([]);
  });
  test('SIGTERM-style drain(): marks draining itself; bounded by drainMaxMs when the engine never goes idle',async()=>{
    const engine=fakeEngine();engine.state.waiting=1;const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);const handle=agent(store,base,{drainMaxMs:300});
    await until(async()=>(await live(store)).length===1);
    const started=Date.now();handle.drain();
    await until(async()=>(await live(store))[0]?.state==='draining');
    expect(await handle.done).toBe('drained');
    expect(Date.now()-started).toBeGreaterThanOrEqual(290);expect(await live(store)).toEqual([]);
  });
  test('drain waits for the draining state to reach the registry before it can delete the record',async()=>{
    const engine=fakeEngine();const base=await listen(engine.server);
    const memory=new MemoryUpstreamRegistry(Date.now);let failWrites=false;
    const store={heartbeat:(...a:Parameters<MemoryUpstreamRegistry['heartbeat']>)=>failWrites?Promise.reject(new Error('down')):memory.heartbeat(...a),
      setState:(...a:Parameters<MemoryUpstreamRegistry['setState']>)=>failWrites?Promise.reject(new Error('down')):memory.setState(...a),
      remove:(...a:Parameters<MemoryUpstreamRegistry['remove']>)=>failWrites?Promise.reject(new Error('down')):memory.remove(...a),
      pools:()=>memory.pools()};
    const handle=runAgent(store,{pool:'m',id:'pod-a',baseUrl:base,...fast,log:()=>undefined});agents.push(handle);
    await until(async()=>(await live(memory)).length===1);
    failWrites=true;handle.drain();
    await new Promise(r=>setTimeout(r,350)); // > settle (100 ms) + two idle checks: the engine is idle
    expect(handle.status().phase).toBe('draining');expect(await live(memory)).toHaveLength(1);
    const states:string[]=[];failWrites=false;
    const watch=setInterval(()=>void live(memory).then(r=>{if(r[0])states.push(r[0].state);}),5);
    expect(await handle.done).toBe('drained');clearInterval(watch);
    expect(states).toContain('draining');expect(await live(memory)).toEqual([]);
  });
  test('a CLI drain survives an agent crash and record expiry: the agent restarted on the same engine finishes the drain',async()=>{
    const engine=fakeEngine();engine.state.running=1;const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);const first=agent(store,base);
    await until(async()=>(await live(store)).length===1);
    const drained=drainUpstream(store,'m','pod-a',{timeoutMs:5000,pollMs:20,tombstone:{fallbackMs:5000,ttlMs:400}});
    await until(()=>first.status().phase==='draining');
    first.kill();await first.done; // crashed mid-drain (engine still busy)
    await until(async()=>(await live(store)).length===0,2000); // record expired
    const second=agent(store,base);
    await until(async()=>(await live(store))[0]?.state==='draining'); // came back draining, not active
    expect(second.status().phase).toBe('draining');
    engine.state.running=0;
    expect(await second.done).toBe('drained');expect(await drained).toBe('drained');
  });
  test('labels are matched whole: a label ending in block_size does not count as block_size',()=>{
    expect(parseEngineMetrics('vllm:cache_config_info{kv_block_size="64",block_size="16",num_gpu_blocks="10"} 1\n').kvCapacityTokens).toBe(160);
    expect(parseEngineMetrics('vllm:cache_config_info{kv_block_size="64",num_gpu_blocks="10"} 1\n').kvCapacityTokens).toBeNull();
  });
  test('the /health timeout is an option (default 2500 ms): a slow but healthy engine still registers',async()=>{
    const slow=createServer((req,res)=>{if(req.url==='/health'){setTimeout(()=>{res.writeHead(200);res.end();},1200);return;}res.writeHead(404);res.end();});
    const base=await listen(slow);const store=new MemoryUpstreamRegistry(Date.now);
    agent(store,base);
    await until(async()=>(await live(store)).length===1,4000);
    const quick=new MemoryUpstreamRegistry(Date.now);agent(quick,base,{id:'pod-b',healthTimeoutMs:300});
    await new Promise(r=>setTimeout(r,1500));expect(await live(quick)).toEqual([]);
  });
  test('a dead engine is deregistered; when it comes back (new process) it registers with a new epoch',async()=>{
    const engine=fakeEngine();const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);agent(store,base);
    await until(async()=>(await live(store)).length===1);const {epoch}=(await live(store))[0]!;
    engine.state.health=503;
    await until(async()=>(await live(store)).length===0);
    engine.state.start+=60;engine.state.health=200;
    await until(async()=>(await live(store)).length===1);
    expect((await live(store))[0]!.epoch).not.toBe(epoch);
  });
  test('Redis unreachable: the agent keeps trying and re-publishes once it is back',async()=>{
    const engine=fakeEngine();const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);const handle=agent(store,base);
    await until(async()=>(await live(store)).length===1);
    store.down=true;await new Promise(r=>setTimeout(r,600)); // longer than the TTL
    expect(handle.status().phase).toBe('active');
    store.down=false;
    await until(async()=>(await live(store)).length===1);
  });
  test('drainUpstream: not_found without a record; timeout when nobody removes it',async()=>{
    const store=new MemoryUpstreamRegistry(Date.now);
    expect(await drainUpstream(store,'m','pod-x',{timeoutMs:100,pollMs:10})).toBe('not_found');
    await store.heartbeat({pool:'m',id:'pod-x',baseUrl:'http://127.0.0.1:18000/v1',maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e',seq:0},60000);
    expect(await drainUpstream(store,'m','pod-x',{timeoutMs:100,pollMs:10})).toBe('timeout');
  });
});

describe('agent timings',()=>{
  test('defaults; a /health timeout must leave a heartbeat inside the TTL (timeout < TTL − heartbeat)',()=>{
    expect(agentTimings({})).toEqual({heartbeatMs:2000,ttlMs:10000,drainMaxMs:120000,drainSettleMs:4000,healthTimeoutMs:2500});
    expect(()=>agentTimings({PTR_UPSTREAM_HEALTH_TIMEOUT_MS:'8000'})).toThrow('INVALID_PTR_UPSTREAM_HEALTH_TIMEOUT_MS');
    expect(agentTimings({PTR_UPSTREAM_HEALTH_TIMEOUT_MS:'7999'}).healthTimeoutMs).toBe(7999);
    expect(()=>agentTimings({PTR_UPSTREAM_TTL_MS:'3000'})).toThrow('INVALID_PTR_UPSTREAM_TTL_MS');
  });
  test('the record carries the agent\'s drain bound so a CLI drain tombstone lives as long as that drain can take',async()=>{
    const engine=fakeEngine();const base=await listen(engine.server);
    const store=new MemoryUpstreamRegistry(Date.now);agent(store,base,{drainMaxMs:4321});
    await until(async()=>(await live(store)).length===1);
    expect((await live(store))[0]!.drainMaxMs).toBe(4321);
  });
});

describe('agent CLI arguments',()=>{
  test('register needs pool, id and a loopback base URL; numbers are bounded; defaults maxSeqs 12, weight 1',()=>{
    expect(parseAgentArgs(['register','--pool=gemma-4-e4b-fp8','--id=pod-a','--base-url=http://127.0.0.1:18000/v1'])).toEqual({command:'register',
      pool:'gemma-4-e4b-fp8',id:'pod-a',baseUrl:'http://127.0.0.1:18000/v1',maxSeqs:12,weight:1,kvCapacityTokens:null});
    expect(parseAgentArgs(['register','--pool=p','--id=a','--base-url=http://127.0.0.1:18000/v1','--max-seqs=16','--kv-capacity-tokens=43000','--weight=2','--epoch=boot-7']))
      .toMatchObject({maxSeqs:16,kvCapacityTokens:43000,weight:2,epoch:'boot-7'});
    expect(parseAgentArgs(['list'])).toEqual({command:'list'});
    expect(parseAgentArgs(['drain','--pool=p','--id=a'])).toEqual({command:'drain',pool:'p',id:'a'});
    for(const bad of [[],['start'],['register','--pool=p','--id=a'],['register','--pool=p','--id=a:b','--base-url=http://127.0.0.1:1/v1'],
      ['register','--pool=p','--id=a','--base-url=http://10.0.0.5:18000/v1'],['register','--pool=p','--id=a','--base-url=http://127.0.0.1:18000/v1','--max-seqs=0'],
      ['drain','--pool=p'],['register','--pool=p','--id=a','--base-url=http://127.0.0.1:18000/v1','--unknown=1']])
      expect(()=>parseAgentArgs(bad)).toThrow('INVALID_AGENT_ARGS');
  });
});
