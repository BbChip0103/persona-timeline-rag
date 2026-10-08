import { GatewayDirectory, GatewayPublisher, MemoryGatewayRegistry, checkGatewayUrl, orderGateways, parseGatewayAllow, parseGatewayRecord,
  screenGatewayRecords, serializeGatewayRecord, type GatewayRegistryStore } from '../src/gateway-registry';
import { gateway, gatewayRegistryContract } from './gateway-registry.contract';

gatewayRegistryContract('memory',async()=>{
  const store=new MemoryGatewayRegistry();
  return {store,wait:async(ms:number)=>store.advance(ms)};
});

const allow=parseGatewayAllow(undefined);
const url=(port:number)=>`http://127.0.0.1:${port}/v1`;

describe('gateway records and the worker-side policy ()',()=>{
  test('PTR_GATEWAY_ALLOW: default 127.0.0.1:56460-56469; same syntax as the upstream allowlist, its own error name',()=>{
    expect(allow).toEqual([{host:'127.0.0.1',from:56460,to:56469}]);
    expect(parseGatewayAllow('127.0.0.1:56501-56503,127.0.0.1:56600')).toEqual([{host:'127.0.0.1',from:56501,to:56503},{host:'127.0.0.1',from:56600,to:56600}]);
    for(const bad of ['','10.0.0.1:56460','127.0.0.1:0','127.0.0.1:9-1','localhost:56460']) expect(()=>parseGatewayAllow(bad)).toThrow('INVALID_PTR_GATEWAY_ALLOW');
  });
  test('a registry URL must be http://127.0.0.1:<allowed port>/v1 without credentials, query or fragment',()=>{
    expect(checkGatewayUrl(url(56460),allow)).toBeNull();
    expect(checkGatewayUrl(`${url(56460)}/`,allow)).toBeNull();
    expect(checkGatewayUrl(url(56479),allow)).toBe('not_allowed'); // the Redis port is never a gateway
    for(const bad of ['https://127.0.0.1:56460/v1','http://localhost:56460/v1','http://u:p@127.0.0.1:56460/v1','http://127.0.0.1:56460/v1?x=1','http://127.0.0.1:56460/v2','nope'])
      expect(checkGatewayUrl(bad,allow)).toBe('not_loopback');
  });
  test('records round-trip; malformed ones throw; the id `leader` is reserved for the hint key',()=>{
    expect(parseGatewayRecord(serializeGatewayRecord(gateway()))).toEqual(gateway());
    for(const bad of [{id:'leader'},{maxQueue:-1},{state:'gone'},{startedAt:'x'},{url:''}]) {
      const hash={...serializeGatewayRecord(gateway()),...Object.fromEntries(Object.entries(bad).map(([k,v])=>[k,String(v)]))};
      expect(()=>parseGatewayRecord(hash)).toThrow('INVALID_GATEWAY_RECORD');
    }
  });
  test('screening drops malformed, off-loopback, off-allowlist and duplicate-URL records with a reason; order = leader, then oldest start, then id',()=>{
    const hashes=[gateway({id:'gw-c',url:url(56462),startedAt:3000}),gateway({id:'gw-b',url:url(56461),startedAt:2000}),gateway({id:'gw-a',url:url(56460),startedAt:2000}),
      gateway({id:'gw-d',url:url(56479)}),gateway({id:'gw-e',url:url(56460),startedAt:1}),gateway({id:'gw-f',url:url(56463),state:'draining'})].map(serializeGatewayRecord);
    hashes.push({id:'gw-g'});
    const {records,rejections}=screenGatewayRecords(hashes,allow);
    expect(rejections.map(r=>r.reason).sort()).toEqual(['duplicate_url','invalid_record','not_allowed']);
    expect(records.map(r=>r.id)).toEqual(['gw-a','gw-b','gw-c','gw-f']);
    expect(orderGateways(records,'gw-c').map(r=>r.id)).toEqual(['gw-c','gw-a','gw-b']); // draining excluded
    expect(orderGateways(records,null).map(r=>r.id)).toEqual(['gw-a','gw-b','gw-c']);
    expect(orderGateways(records,'gw-f').map(r=>r.id)).toEqual(['gw-a','gw-b','gw-c']); // a draining "leader" is no leader
  });
});

describe('GatewayDirectory (worker side): registry list with the static PTR_GATEWAY_URLS as seed and fallback',()=>{
  const seed=[url(56460),url(56461)];
  test('before the first read the seed; then leader → oldest active, seed URLs the registry does not know appended last',async()=>{
    const store=new MemoryGatewayRegistry();
    const directory=new GatewayDirectory(store,{seed,allow,pollMs:1e9});
    expect(directory.urls()).toEqual(seed);
    await store.heartbeat(gateway({id:'gw-b',url:url(56462),startedAt:500}),10000,5000); // leader
    await store.heartbeat(gateway({id:'gw-a',url:url(56461),startedAt:100}),10000,5000);
    await directory.poll();
    expect(directory.urls()).toEqual([url(56462),url(56461),url(56460)]);
    expect(directory.metrics()).toMatchObject({stale:false,leader:'gw-b',active:2,rejected:0});
  });
  test('a draining gateway leaves the list (also as a seed); an empty registry falls back to the seed',async()=>{
    const store=new MemoryGatewayRegistry();
    const directory=new GatewayDirectory(store,{seed,allow,pollMs:1e9});
    await store.heartbeat(gateway({id:'gw-a',url:url(56460)}),10000,5000);
    await store.heartbeat(gateway({id:'gw-b',url:url(56461),startedAt:2000}),10000,5000);
    await store.heartbeat(gateway({id:'gw-a',url:url(56460),state:'draining',seq:1}),10000,5000);
    await directory.poll();
    expect(directory.urls()).toEqual([url(56461)]);
    await store.remove('gw-a');await store.remove('gw-b');
    await directory.poll();
    expect(directory.urls()).toEqual(seed);
  });
  test('Redis unreachable: the last list is kept (stale) and nothing is ever empty',async()=>{
    const store=new MemoryGatewayRegistry();
    const directory=new GatewayDirectory(store,{seed:[url(56460)],allow,pollMs:1e9});
    await store.heartbeat(gateway({id:'gw-b',url:url(56461)}),10000,5000);
    await directory.poll();
    store.down=true;await directory.poll();
    expect(directory.urls()).toEqual([url(56461),url(56460)]);
    expect(directory.metrics()).toMatchObject({stale:true,failedPolls:1});
    const cold=new GatewayDirectory(store,{seed:[url(56460)],allow,pollMs:1e9});
    await cold.poll();
    expect(cold.urls()).toEqual([url(56460)]);
  });
  test('rejected records are counted once per record version and never listed; the log names reasons only (no URLs)',async()=>{
    const store=new MemoryGatewayRegistry();const lines:string[]=[];
    const directory=new GatewayDirectory(store,{seed:[url(56460)],allow,pollMs:1e9,log:line=>lines.push(line)});
    await store.heartbeat(gateway({id:'gw-x',url:'http://127.0.0.1:18000/v1'}),10000,5000);
    await directory.poll();await directory.poll();
    expect(directory.urls()).toEqual([url(56460)]);
    expect(directory.metrics().rejected).toBe(1);
    expect(lines).toHaveLength(1);expect(lines[0]).toContain('not_allowed');expect(lines[0]).not.toContain('18000');
  });
  test('start polls at once and then every pollMs; close stops it',async()=>{
    const store=new MemoryGatewayRegistry();
    await store.heartbeat(gateway({id:'gw-b',url:url(56461)}),10000,5000);
    const directory=new GatewayDirectory(store,{seed:[url(56460)],allow,pollMs:20});
    await directory.start();
    expect(directory.urls()[0]).toBe(url(56461));
    await store.heartbeat(gateway({id:'gw-c',url:url(56462),startedAt:1}),10000,5000);
    await new Promise(r=>setTimeout(r,80));
    expect(directory.urls()).toEqual([url(56461),url(56462),url(56460)]);
    await directory.close();
  });
});

describe('GatewayPublisher (gateway side): heartbeat, leader hint, draining, k active gateways',()=>{
  test('publishes at start and every heartbeat; counts active gateways (itself included); draining and stop',async()=>{
    const store=new MemoryGatewayRegistry();
    const a=new GatewayPublisher(store,{id:'gw-a',url:url(56460),maxQueue:256,startedAt:1000,heartbeatMs:1e9,allow,claimAfterMs:0});
    await a.start();
    expect(a.metrics()).toMatchObject({leader:true,active:1,state:'active'});
    const b=new GatewayPublisher(store,{id:'gw-b',url:url(56461),maxQueue:128,startedAt:2000,heartbeatMs:1e9,allow,claimAfterMs:0});
    await b.start();
    expect(b.metrics()).toMatchObject({leader:false,active:2});
    expect(a.activeGateways()).toBe(1); // until its next heartbeat reads the list again
    await a.beat();expect(a.activeGateways()).toBe(2);
    await a.setDraining();
    expect(a.metrics()).toMatchObject({state:'draining',leader:false});
    expect((await store.list()).leader).toBeNull();
    await b.beat();expect(b.metrics()).toMatchObject({leader:true,active:1});
    expect(a.activeGateways()).toBe(2); // a draining gateway still counts itself (its in-flight calls may still fail over)
    await a.stop();
    expect((await store.list()).records.map(r=>r.id)).toEqual(['gw-b']);
    await b.stop();
  });
  test('k is unknown (null) until the first successful read; it counts only records that pass PTR_GATEWAY_ALLOW, plus itself',async()=>{
    const store=new MemoryGatewayRegistry();
    const a=new GatewayPublisher(store,{id:'gw-a',url:url(56460),maxQueue:256,startedAt:1000,heartbeatMs:1e9,allow,claimAfterMs:0});
    expect(a.activeGateways()).toBeNull();
    store.down=true;await a.start();
    expect(a.activeGateways()).toBeNull(); // cold start during a Redis outage: the caller uses its most conservative value
    store.down=false;
    await store.heartbeat(gateway({id:'gw-x',url:'http://127.0.0.1:18000/v1'}),10000,5000); // off the allowlist
    await store.heartbeat(gateway({id:'gw-b',url:url(56461)}),10000,5000);
    await a.beat();
    expect(a.activeGateways()).toBe(2);
    await a.stop();
  });
  test('a gateway takes a free leader hint only after one lease of successful heartbeats (a failed beat restarts the wait)',async()=>{
    const store=new MemoryGatewayRegistry();let now=0;
    const a=new GatewayPublisher(store,{id:'gw-a',url:url(56460),maxQueue:256,startedAt:1000,heartbeatMs:1e9,leaderMs:5000,allow,now:()=>now});
    await a.start();expect(a.metrics().leader).toBe(false);
    now=3000;await a.beat();expect(a.metrics().leader).toBe(false);
    store.down=true;now=4000;await a.beat();store.down=false;
    now=6000;await a.beat();expect(a.metrics().leader).toBe(false); // the run of good beats restarted at 6000
    now=11000;await a.beat();expect(a.metrics().leader).toBe(true);
    await a.stop();
  });
  test('a registry error keeps the last count and never throws from the heartbeat',async()=>{
    const store=new MemoryGatewayRegistry();
    const a=new GatewayPublisher(store,{id:'gw-a',url:url(56460),maxQueue:256,startedAt:1000,heartbeatMs:1e9,allow,claimAfterMs:0});
    await store.heartbeat(gateway({id:'gw-b',url:url(56461)}),10000,5000);
    await a.start();expect(a.activeGateways()).toBe(2);
    store.down=true;await a.beat();
    expect(a.activeGateways()).toBe(2);expect(a.metrics()).toMatchObject({failedBeats:1});
    expect(await a.stop()).toBe(false); // the delete failed: reported, not thrown
    store.down=false;
  });
  test('failed heartbeats: one WARNING at the first, then at most one a minute while they go on; no URL or message in the line',async()=>{
    const store=new MemoryGatewayRegistry();let now=0;const lines:string[]=[];
    const a=new GatewayPublisher(store,{id:'gw-a',url:url(56460),maxQueue:256,startedAt:1000,heartbeatMs:1e9,allow,claimAfterMs:0,now:()=>now,onWarning:line=>lines.push(line)});
    // A cold start against an unreachable registry: k unknown, so the failover cap is 1 a minute.
    store.down=true;await a.start();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^WARNING gateway registry heartbeat failed \(Error\): 1 in a row, 1 in total; k unknown, so the failover per-minute cap is 1$/);
    for(now=2000;now<60000;now+=2000)await a.beat();
    expect(lines).toHaveLength(1); // 29 more failures within the minute: silent
    expect(a.metrics()).toMatchObject({failedBeats:30,consecutiveFailedBeats:30,active:null,leader:false});
    now=60000;await a.beat();
    expect(lines).toHaveLength(2);expect(lines[1]).toContain('31 in a row, 31 in total');
    // Recovery resets the run; a flapping registry still logs at most once a minute.
    store.down=false;now=62000;await a.beat();
    expect(a.metrics()).toMatchObject({consecutiveFailedBeats:0,failedBeats:31,active:1});
    store.down=true;now=64000;await a.beat();
    expect(lines).toHaveLength(2);
    store.down=false;now=66000;await a.beat();store.down=true;now=121000;await a.beat();
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('WARNING gateway registry heartbeat failed (Error): 1 in a row, 33 in total; k 1 (last read), so the failover per-minute cap stays at cap/1');
    for(const line of lines)expect(line).not.toMatch(/http|127\.0\.0\.1|REGISTRY_UNAVAILABLE/);
    store.down=false;await a.stop();
  });
  test('a failed heartbeat clears the leader flag in the metrics; the next good beat renews the hint',async()=>{
    const store=new MemoryGatewayRegistry();
    const a=new GatewayPublisher(store,{id:'gw-a',url:url(56460),maxQueue:256,startedAt:1000,heartbeatMs:1e9,allow,claimAfterMs:0});
    await a.start();expect(a.metrics().leader).toBe(true);
    store.down=true;await a.beat();
    expect(a.metrics()).toMatchObject({leader:false,consecutiveFailedBeats:1});
    store.down=false;await a.beat();expect(a.metrics().leader).toBe(true); // it still held the hint (within its lease)
    await a.stop();
  });
  test('the warning names an error code (never the message) and stays silent without onWarning',async()=>{
    const lines:string[]=[];
    const failing:GatewayRegistryStore={heartbeat:async()=>{throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:56479 secret'),{code:'ECONNREFUSED'});},
      list:async()=>({records:[],leader:null}),remove:async()=>undefined};
    const a=new GatewayPublisher(failing,{id:'gw-a',url:url(56460),maxQueue:256,startedAt:1000,heartbeatMs:1e9,allow,onWarning:line=>lines.push(line)});
    await a.start();
    expect(lines).toEqual(['WARNING gateway registry heartbeat failed (ECONNREFUSED): 1 in a row, 1 in total; k unknown, so the failover per-minute cap is 1']);
    const quiet=new GatewayPublisher(failing,{id:'gw-b',url:url(56461),maxQueue:256,startedAt:1000,heartbeatMs:1e9,allow});
    await quiet.start();expect(quiet.metrics().failedBeats).toBe(1);
    await a.stop();await quiet.stop();
  });
});
