import { parseUpstreamRecord, type RegistryReader, type RegistryWriter, type UpstreamRecord } from '../src/upstream-registry';

/** One store under test: `wait` advances the store's clock (memory) or really sleeps (Redis). */
export interface RegistryHarness { store:RegistryReader&RegistryWriter; wait(ms:number):Promise<void>; cleanup?():Promise<void> }

const record=(overrides:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'gemma-4-e4b-fp8',id:'pod-a',baseUrl:'http://127.0.0.1:18000/v1',
  maxSeqs:12,kvCapacityTokens:347000,weight:1,state:'active',epoch:'epoch-1',seq:0,...overrides});
const live=async(store:RegistryReader,pool='gemma-4-e4b-fp8')=>(await store.list(pool)).records.map(parseUpstreamRecord);

/** Registry semantics shared by the in-memory store and the Redis (Lua) store. */
export function registryContract(name:string,make:()=>Promise<RegistryHarness>) {
  describe(`upstream registry contract: ${name}`,()=>{
    let h:RegistryHarness;
    beforeEach(async()=>{h=await make();});
    afterEach(async()=>{await h.cleanup?.();});

    test('a first heartbeat creates the record, bumps the version and nudges subscribers; a plain heartbeat does neither',async()=>{
      let nudges=0;const unsubscribe=await h.store.subscribe(()=>{nudges++;});
      try {
        const before=(await h.store.list('gemma-4-e4b-fp8')).version;
        expect(await h.store.heartbeat(record(),10000)).toBe('created');
        const after=await h.store.list('gemma-4-e4b-fp8');
        expect(after.version).toBe(before+1);
        expect(after.records.map(parseUpstreamRecord)).toEqual([record()]);
        expect(await h.store.heartbeat(record({seq:1}),10000)).toBe('active');
        expect((await h.store.list('gemma-4-e4b-fp8')).version).toBe(before+1);
        expect((await live(h.store))[0]!.seq).toBe(1);
        for(let i=0;i<50&&nudges<1;i++) await new Promise(r=>setTimeout(r,10));
        expect(nudges).toBe(1);
      } finally {await unsubscribe();}
    });
    test('a changed field (maxSeqs) is a change: version bump',async()=>{
      await h.store.heartbeat(record(),10000);const version=(await h.store.list('gemma-4-e4b-fp8')).version;
      expect(await h.store.heartbeat(record({maxSeqs:8,seq:1}),10000)).toBe('changed');
      expect((await h.store.list('gemma-4-e4b-fp8')).version).toBe(version+1);
      expect((await live(h.store))[0]!.maxSeqs).toBe(8);
    });
    test('draining sticks: later heartbeats of the same epoch only refresh the TTL; a new epoch is a new engine',async()=>{
      expect(await h.store.setState('gemma-4-e4b-fp8','pod-a','draining')).toBe(false); // nothing to drain
      await h.store.heartbeat(record(),300);
      expect(await h.store.setState('gemma-4-e4b-fp8','pod-a','draining')).toBe(true);
      expect(await h.store.heartbeat(record({seq:1}),300)).toBe('draining');
      expect((await live(h.store))[0]).toMatchObject({state:'draining',seq:1});
      await h.wait(200);await h.store.heartbeat(record({seq:2}),300);await h.wait(200);
      expect((await live(h.store))[0]).toMatchObject({state:'draining'}); // TTL refreshed while draining
      expect(await h.store.heartbeat(record({epoch:'epoch-2',seq:0}),300)).toBe('created');
      expect((await live(h.store))[0]).toMatchObject({state:'active',epoch:'epoch-2'});
    });
    test('a heartbeat carries the publisher\'s state: a draining agent recreates its expired record as draining',async()=>{
      expect(await h.store.heartbeat(record({state:'draining'}),10000)).toBe('created');
      expect((await live(h.store))[0]).toMatchObject({state:'draining'});
      expect(await h.store.heartbeat(record({id:'pod-b',baseUrl:'http://127.0.0.1:18001/v1'}),10000)).toBe('created');
      expect(await h.store.heartbeat(record({id:'pod-b',baseUrl:'http://127.0.0.1:18001/v1',state:'draining',seq:1}),10000)).toBe('changed');
      expect((await live(h.store)).find(r=>r.id==='pod-b')).toMatchObject({state:'draining'});
    });
    test('a drain outlives its record: a tombstone keeps the same epoch draining when its agent re-publishes after expiry',async()=>{
      await h.store.heartbeat(record(),300);
      expect(await h.store.setState('gemma-4-e4b-fp8','pod-a','draining',5000)).toBe(true);
      await h.wait(450);
      expect(await live(h.store)).toEqual([]); // expired before the agent deleted it
      expect(await h.store.heartbeat(record({seq:7}),300)).toBe('draining'); // same engine comes back: still draining
      expect((await live(h.store))[0]).toMatchObject({state:'draining',seq:7});
      await h.store.remove('gemma-4-e4b-fp8','pod-a','epoch-1');
      expect(await h.store.heartbeat(record({seq:8}),300)).toBe('draining'); // the tombstone outlives the removal too
      expect(await h.store.heartbeat(record({epoch:'epoch-2',seq:0}),300)).toBe('created'); // a new engine is not drained
      expect((await live(h.store))[0]).toMatchObject({state:'active',epoch:'epoch-2'});
    });
    test('the drain tombstone expires',async()=>{
      await h.store.heartbeat(record(),5000);
      await h.store.setState('gemma-4-e4b-fp8','pod-a','draining',200);
      await h.store.remove('gemma-4-e4b-fp8','pod-a');
      await h.wait(300);
      expect(await h.store.heartbeat(record(),5000)).toBe('created');
      expect((await live(h.store))[0]!.state).toBe('active');
    });
    test('pool and id are validated before any key is built',async()=>{
      await expect(h.store.setState('p:q','a','draining')).rejects.toThrow('INVALID_REGISTRY_KEY');
      await expect(h.store.remove('p','a:*')).rejects.toThrow('INVALID_REGISTRY_KEY');
      await expect(h.store.list('p*')).rejects.toThrow('INVALID_REGISTRY_KEY');
      await expect(h.store.heartbeat(record({id:'a:b'}),1000)).rejects.toThrow('INVALID_REGISTRY_KEY');
    });
    test('remove: only the matching epoch (unless forced); bumps the version',async()=>{
      await h.store.heartbeat(record(),10000);const version=(await h.store.list('gemma-4-e4b-fp8')).version;
      expect(await h.store.remove('gemma-4-e4b-fp8','pod-a','epoch-0')).toBe(false);
      expect(await live(h.store)).toHaveLength(1);
      expect(await h.store.remove('gemma-4-e4b-fp8','pod-a','epoch-1')).toBe(true);
      expect(await live(h.store)).toHaveLength(0);
      expect((await h.store.list('gemma-4-e4b-fp8')).version).toBe(version+1);
      await h.store.heartbeat(record(),10000);
      expect(await h.store.remove('gemma-4-e4b-fp8','pod-a')).toBe(true);
      expect(await h.store.remove('gemma-4-e4b-fp8','pod-a')).toBe(false);
    });
    test('a record without heartbeats expires after its TTL and leaves the listing',async()=>{
      await h.store.heartbeat(record(),300);await h.store.heartbeat(record({id:'pod-b',baseUrl:'http://127.0.0.1:18001/v1'}),5000);
      expect((await live(h.store)).map(r=>r.id).sort()).toEqual(['pod-a','pod-b']);
      await h.wait(450);
      expect((await live(h.store)).map(r=>r.id)).toEqual(['pod-b']);
      expect(await h.store.pools()).toEqual(['gemma-4-e4b-fp8']);
    });
    test('pools are separate listings',async()=>{
      await h.store.heartbeat(record(),10000);await h.store.heartbeat(record({pool:'gemma-4-26b'}),10000);
      expect(await live(h.store,'gemma-4-26b')).toHaveLength(1);
      expect((await h.store.pools()).sort()).toEqual(['gemma-4-26b','gemma-4-e4b-fp8']);
    });
  });
}
