import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryUpstreamRegistry, type UpstreamRecord } from '@ptr/messaging';
import { FileUpstreamSource, RedisRegistrySource, StaticUpstreamSource, UpstreamPool, checkUpstreamUrl, parseUpstreamAllow, readUpstreamsFile } from '../src';
import { upstreamFromEnvironment } from '../src/main';

const rec=(id:string,port:number,extra:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'gemma-4-e4b-fp8',id,baseUrl:`http://127.0.0.1:${port}/v1`,
  maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e1',seq:0,...extra});
const ids=(source:{snapshot():UpstreamRecord[]})=>source.snapshot().map(r=>r.id).sort();
function tempFile(content:unknown):string {
  const file=join(mkdtempSync(join(tmpdir(),'ptr-upstreams-')),'upstreams.json');
  writeFileSync(file,typeof content==='string'?content:JSON.stringify(content));return file;
}

describe('upstream allowlist (PTR_GATEWAY_UPSTREAM_ALLOW)',()=>{
  test('default 127.0.0.1:18000-18999; single ports and lists; anything but loopback ranges is a startup error',()=>{
    expect(parseUpstreamAllow(undefined)).toEqual([{host:'127.0.0.1',from:18000,to:18999}]);
    expect(parseUpstreamAllow('127.0.0.1:18000-18010, 127.0.0.1:30000')).toEqual([{host:'127.0.0.1',from:18000,to:18010},{host:'127.0.0.1',from:30000,to:30000}]);
    for(const bad of ['','10.0.0.5:18000','localhost:18000','127.0.0.1:18010-18000','127.0.0.1:0','127.0.0.1:70000','127.0.0.1'])
      expect(()=>parseUpstreamAllow(bad)).toThrow('INVALID_PTR_GATEWAY_UPSTREAM_ALLOW');
  });
  test('a record URL must be plain loopback http on an allowed port',()=>{
    const allow=parseUpstreamAllow(undefined);
    expect(checkUpstreamUrl('http://127.0.0.1:18000/v1',allow)).toBeNull();
    expect(checkUpstreamUrl('http://127.0.0.1:19000/v1',allow)).toBe('not_allowed');
    expect(checkUpstreamUrl('http://127.0.0.1/v1',allow)).toBe('not_allowed');
    for(const url of ['https://127.0.0.1:18000/v1','http://10.0.0.5:18000/v1','http://localhost:18000/v1','http://u:p@127.0.0.1:18000/v1','http://127.0.0.1:18000/v1?x=1'])
      expect(checkUpstreamUrl(url,allow)).toBe('not_loopback');
    expect(checkUpstreamUrl('http://127.0.0.1:45678/v1')).toBeNull(); // file/env entries: loopback rule only
  });
});

describe('upstreams file (PTR_GATEWAY_UPSTREAMS_FILE)',()=>{
  test('one pool is read; maxSeqs defaults to 12, weight to 1; entries are validated',()=>{
    const records=readUpstreamsFile(JSON.stringify({pools:{'gemma-4-e4b-fp8':{upstreams:[{id:'pod-a',baseUrl:'http://127.0.0.1:18000/v1'},
      {id:'pod-b',baseUrl:'http://127.0.0.1:18001/v1',maxSeqs:16,kvCapacityTokens:347000,weight:2}]},other:{upstreams:[]}}}),'gemma-4-e4b-fp8');
    expect(records).toEqual([rec('pod-a',18000,{epoch:'file'}),rec('pod-b',18001,{epoch:'file',maxSeqs:16,kvCapacityTokens:347000,weight:2})]);
    for(const bad of ['{',JSON.stringify({pools:{}}),JSON.stringify({pools:{'gemma-4-e4b-fp8':{upstreams:[{id:'a',baseUrl:'http://10.0.0.5:1/v1'}]}}}),
      JSON.stringify({pools:{'gemma-4-e4b-fp8':{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:1/v1'},{id:'a',baseUrl:'http://127.0.0.1:2/v1'}]}}}),
      JSON.stringify({pools:{'gemma-4-e4b-fp8':{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:1/v1',maxSeqs:0}]}}}),
      JSON.stringify({pools:{'gemma-4-e4b-fp8':{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:1/v1',secret:'x'}]}}})])
      expect(()=>readUpstreamsFile(bad,'gemma-4-e4b-fp8')).toThrow('INVALID_UPSTREAMS_FILE');
  });
  test('the example file in configs/ parses',()=>{
    const text=readFileSync(join(__dirname,'../../../configs/gateway-upstreams.example.json'),'utf8');
    expect(readUpstreamsFile(text,'gemma-4-e4b-fp8').map(r=>[r.id,r.maxSeqs])).toEqual([['pod-a',12],['pod-b',12]]);
  });
  test('reloads on mtime change and on demand (SIGHUP); a bad edit keeps the last good list',async()=>{
    const write=(entries:{id:string;baseUrl:string}[])=>JSON.stringify({pools:{'gemma-4-e4b-fp8':{upstreams:entries}}});
    const file=tempFile(write([{id:'a',baseUrl:'http://127.0.0.1:18000/v1'}]));
    const source=new FileUpstreamSource(file,'gemma-4-e4b-fp8',{reloadMs:20});
    let changes=0;source.onChange(()=>{changes++;});
    await source.start();
    try {
      expect(ids(source)).toEqual(['a']);
      writeFileSync(file,write([{id:'a',baseUrl:'http://127.0.0.1:18000/v1'},{id:'b',baseUrl:'http://127.0.0.1:18001/v1'}]));
      utimesSync(file,new Date(),new Date(Date.now()+5000));
      const end=Date.now()+2000;while(Date.now()<end&&ids(source).length<2) await new Promise(r=>setTimeout(r,10));
      expect(ids(source)).toEqual(['a','b']);expect(changes).toBe(1);
      writeFileSync(file,'{broken');
      source.reload();
      expect(ids(source)).toEqual(['a','b']);expect(source.metrics().fileErrors).toBe(1);
      writeFileSync(file,write([{id:'b',baseUrl:'http://127.0.0.1:18001/v1'}]));
      source.reload();
      expect(ids(source)).toEqual(['b']);expect(changes).toBe(2);
    } finally {await source.close();}
    expect(()=>new FileUpstreamSource(tempFile('{'),'gemma-4-e4b-fp8')).toThrow('INVALID_UPSTREAMS_FILE');
  });
});

describe('record comparison',()=>{
  test('a changed prefillTokensPerSec or drainMaxMs is a change of the snapshot (file reload, registry poll)',async()=>{
    const write=(prefill?:number)=>JSON.stringify({pools:{'gemma-4-e4b-fp8':{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:18000/v1',...(prefill?{prefillTokensPerSec:prefill}:{})}]}}});
    const file=tempFile(write());
    const source=new FileUpstreamSource(file,'gemma-4-e4b-fp8');
    let changes=0;source.onChange(()=>{changes++;});
    writeFileSync(file,write(9000));source.reload();
    expect(changes).toBe(1);expect(source.snapshot()[0]!.prefillTokensPerSec).toBe(9000);
    writeFileSync(file,write());source.reload();
    expect(changes).toBe(2);expect(source.snapshot()[0]!.prefillTokensPerSec).toBeUndefined();
    let now=1_000_000;const store=new MemoryUpstreamRegistry(()=>now);
    const registry=new RedisRegistrySource(store,{pool:'gemma-4-e4b-fp8',allow:parseUpstreamAllow(undefined),pollMs:1e9,now:()=>now});
    let nudged=0;registry.onChange(()=>{nudged++;});
    await store.heartbeat(rec('pod-a',18000,{drainMaxMs:60000}),10000);await registry.poll();
    await store.heartbeat(rec('pod-a',18000,{drainMaxMs:30000,seq:1}),10000);await registry.poll();
    expect(nudged).toBe(2);expect(registry.snapshot()[0]!.drainMaxMs).toBe(30000);
    now+=1;await registry.close();
  });
});

describe('Redis registry source',()=>{
  function setup(options:{seed?:StaticUpstreamSource;allow?:string}={}) {
    let now=1_000_000;const store=new MemoryUpstreamRegistry(()=>now);
    const source=new RedisRegistrySource(store,{pool:'gemma-4-e4b-fp8',allow:parseUpstreamAllow(options.allow),pollMs:1e9,graceMs:10000,now:()=>now,seed:options.seed});
    return {store,source,advance:(ms:number)=>{now+=ms;}};
  }
  test('polls the live records; a nudge triggers an immediate poll',async()=>{
    const {store,source}=setup();
    await source.start();
    try {
      expect(source.snapshot()).toEqual([]);
      await store.heartbeat(rec('pod-a',18000),10000);
      const end=Date.now()+1000;while(Date.now()<end&&!source.snapshot().length) await new Promise(r=>setTimeout(r,5));
      expect(ids(source)).toEqual(['pod-a']);
    } finally {await source.close();}
  });
  test('T9: a record outside the allowlist or off loopback is ignored and counted once per record',async()=>{
    const {store,source}=setup();
    await store.heartbeat(rec('pod-a',18000),10000);
    await store.heartbeat(rec('rogue',19999),10000);
    await store.heartbeat(rec('remote',18001,{baseUrl:'http://10.0.0.5:18001/v1'}),10000);
    for(let i=0;i<3;i++) await source.poll();
    expect(ids(source)).toEqual(['pod-a']);
    expect(source.metrics()).toMatchObject({rejected:2,rejectedReasons:{not_allowed:1,not_loopback:1}});
    await store.heartbeat(rec('rogue',19998,{seq:1}),10000);await source.poll(); // a changed record counts again
    expect(source.metrics().rejected).toBe(3);
  });
  test('a record expires out of the membership when its heartbeats stop',async()=>{
    const {store,source,advance}=setup();
    await store.heartbeat(rec('pod-a',18000),10000);await store.heartbeat(rec('pod-b',18001),10000);await source.poll();
    advance(6000);await store.heartbeat(rec('pod-a',18000,{seq:1}),10000);
    advance(5000);await source.poll();
    expect(ids(source)).toEqual(['pod-a']);
  });
  test('T7: Redis unreachable freezes the membership (no expiry); after reconnecting, missing records survive the TTL grace',async()=>{
    const {store,source,advance}=setup();
    await store.heartbeat(rec('pod-a',18000),10000);await store.heartbeat(rec('pod-b',18001),10000);await source.poll();
    store.down=true;advance(1000);await source.poll();
    expect(source.metrics()).toMatchObject({stale:true,failedPolls:1});
    advance(15000);await source.poll(); // both records would have expired by now
    expect(ids(source)).toEqual(['pod-a','pod-b']);expect(source.metrics().staleForMs).toBe(15000);
    store.down=false;await source.poll(); // back: both records are gone from Redis (expired during the outage)
    expect(ids(source)).toEqual(['pod-a','pod-b']);expect(source.metrics()).toMatchObject({stale:false,graceRemainingMs:10000});
    await store.heartbeat(rec('pod-a',18000,{seq:5}),10000); // pod-a's agent heartbeats again; pod-b's never does
    advance(9999);await source.poll();expect(ids(source)).toEqual(['pod-a','pod-b']);
    await store.heartbeat(rec('pod-a',18000,{seq:6}),10000); // a live agent keeps heartbeating
    advance(1);await source.poll();expect(ids(source)).toEqual(['pod-a']);
  });
  test('the static seed is used only until the registry is first read; the registry is the authority after that',async()=>{
    const seed=new StaticUpstreamSource([rec('pod-a',18000,{epoch:'file',maxSeqs:4}),rec('pod-s',18005,{epoch:'file'})]);
    const {store,source,advance}=setup({seed});
    store.down=true;await source.start();
    try {
      expect(ids(source)).toEqual(['pod-a','pod-s']);expect(source.metrics().stale).toBe(true);
      store.down=false;await store.heartbeat(rec('pod-a',18000,{maxSeqs:12}),10000);await source.poll();
      // First read after a stale start: the registry takes over at once; seed entries it lacks get the TTL grace
      // (their agents may not have re-published yet), then they are dropped.
      expect(source.snapshot().find(r=>r.id==='pod-a')).toEqual(rec('pod-a',18000,{maxSeqs:12}));
      expect(ids(source)).toEqual(['pod-a','pod-s']);expect(source.metrics().graceRemainingMs).toBe(10000);
      advance(10000);await store.heartbeat(rec('pod-a',18000,{maxSeqs:12,seq:1}),10000);await source.poll();
      expect(source.snapshot()).toEqual([rec('pod-a',18000,{maxSeqs:12,seq:1})]);
      // Drained and removed: it must not come back from the seed.
      await store.setState('gemma-4-e4b-fp8','pod-a','draining');await source.poll();
      expect(source.snapshot()[0]).toMatchObject({id:'pod-a',state:'draining'});
      await store.remove('gemma-4-e4b-fp8','pod-a');await source.poll();
      expect(source.snapshot()).toEqual([]);
      store.down=true;await source.poll();expect(source.snapshot()).toEqual([]); // a later outage freezes, never re-seeds
    } finally {await source.close();}
  });
  test('two records on the same origin (host:port) are one engine: the second is rejected (duplicate_url)',async()=>{
    const {store,source}=setup();
    await store.heartbeat(rec('pod-a',18000),10000);await store.heartbeat(rec('pod-b',18000,{baseUrl:'http://127.0.0.1:18000/other/v1'}),10000);
    await source.poll();await source.poll();
    expect(ids(source)).toEqual(['pod-a']);expect(source.metrics()).toMatchObject({rejected:1,rejectedReasons:{duplicate_url:1}});
  });
  test('feeds the pool: a registered upstream appears in the pool, a drained one stops taking calls',async()=>{
    const {store,source}=setup();
    const pool=new UpstreamPool({model:'gemma-4-e4b-fp8',source});
    await pool.ready(AbortSignal.timeout(1000));
    try {
      await store.heartbeat(rec('pod-a',18000),10000);await source.poll();
      expect(pool.poolMetrics().upstreams.map(u=>[u.id,u.state])).toEqual([['pod-a','active']]);
      await store.setState('gemma-4-e4b-fp8','pod-a','draining');await source.poll();
      expect(pool.poolMetrics().upstreams.map(u=>[u.id,u.state])).toEqual([['pod-a','draining']]);
      expect(pool.poolMetrics().registry).toMatchObject({discovery:'redis',stale:false});
    } finally {await pool.close();}
  });
});

describe('gateway discovery configuration',()=>{
  const file=()=>tempFile({pools:{m:{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:18000/v1'}]}}});
  test('static discovery with a file builds a pool; env-only keeps the single upstream',async()=>{
    const fromFile=upstreamFromEnvironment({PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_MODEL:'m',PTR_GATEWAY_UPSTREAMS_FILE:file()});
    expect(fromFile.upstream).toBeInstanceOf(UpstreamPool);expect(typeof fromFile.reload).toBe('function');
    await fromFile.upstream.ready?.(AbortSignal.timeout(1000));
    expect((fromFile.upstream as UpstreamPool).poolMetrics()).toMatchObject({pool:'m',registry:{discovery:'file'},upstreams:[{id:'a',limit:12}]});
    await fromFile.close?.();
  });
  test('invalid combinations fail at startup',()=>{
    const base={PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_MODEL:'m'};
    expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_DISCOVERY:'consul'})).toThrow('INVALID_PTR_GATEWAY_DISCOVERY');
    expect(()=>upstreamFromEnvironment({PTR_GATEWAY_UPSTREAMS_FILE:file()})).toThrow('UPSTREAMS_REQUIRE_SELFHOSTED');
    expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),PTR_SELFHOSTED_BASE_URL:'http://127.0.0.1:18000/v1'})).toThrow('SELFHOSTED_BASE_URL_WITH_UPSTREAMS_FILE');
    expect(()=>upstreamFromEnvironment({PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_GATEWAY_UPSTREAMS_FILE:file()})).toThrow('POOL_NOT_CONFIGURED');
    expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_DISCOVERY:'redis',PTR_REDIS_URL:'redis://127.0.0.1:6379/0'})).toThrow();
    expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),PTR_GATEWAY_SLOW_START_MS:'-1'})).toThrow('INVALID_PTR_GATEWAY_SLOW_START_MS');
    expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),PTR_GATEWAY_PRIMARY_ATTEMPTS:'0'})).toThrow('INVALID_PTR_GATEWAY_PRIMARY_ATTEMPTS');
    expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),PTR_GATEWAY_UPSTREAM_ALLOW:'10.0.0.1:1'})).toThrow('INVALID_PTR_GATEWAY_UPSTREAM_ALLOW');
    // The wait for a free upstream runs inside the upstream deadline (which starts after admission): it must be longer.
    expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),PTR_GATEWAY_QUEUE_TIMEOUT_MS:'10000',PTR_GATEWAY_UPSTREAM_TIMEOUT_MS:'10000'})).toThrow('INVALID_PTR_GATEWAY_UPSTREAM_TIMEOUT_MS');
    const ok=upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),PTR_GATEWAY_QUEUE_TIMEOUT_MS:'30000',PTR_GATEWAY_UPSTREAM_TIMEOUT_MS:'31000'});
    void ok.close?.();
  });
});
