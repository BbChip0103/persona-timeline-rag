import { parseGatewayRecord, type GatewayRecord, type GatewayRegistryStore } from '../src/gateway-registry';

/** One store under test: `wait` advances the store's clock (memory) or really sleeps (Redis). */
export interface GatewayHarness { store:GatewayRegistryStore; wait(ms:number):Promise<void>; cleanup?():Promise<void> }

export const gateway=(overrides:Partial<GatewayRecord>={}):GatewayRecord=>({id:'gw-a',url:'http://127.0.0.1:56460/v1',maxQueue:256,state:'active',
  startedAt:1000,seq:0,...overrides});
const live=async(store:GatewayRegistryStore)=>(await store.list()).records.map(parseGatewayRecord).map(({beatAt:_beatAt,...record})=>record).sort((a,b)=>a.id<b.id?-1:1);

/** Gateway registry semantics  shared by the in-memory store and the Redis (Lua) store. */
export function gatewayRegistryContract(name:string,make:()=>Promise<GatewayHarness>) {
  describe(`gateway registry contract: ${name}`,()=>{
    let h:GatewayHarness;
    beforeEach(async()=>{h=await make();});
    afterEach(async()=>{await h.cleanup?.();});

    test('a heartbeat publishes the record with its TTL; the first active gateway takes the free leader hint and renews it',async()=>{
      expect(await h.store.heartbeat(gateway(),10000,5000)).toBe('gw-a');
      expect(await h.store.heartbeat(gateway({id:'gw-b',url:'http://127.0.0.1:56461/v1',startedAt:2000}),10000,5000)).toBe('gw-a');
      expect(await live(h.store)).toEqual([gateway(),gateway({id:'gw-b',url:'http://127.0.0.1:56461/v1',startedAt:2000})]);
      expect((await h.store.list()).leader).toBe('gw-a');
      await h.wait(3000);
      expect(await h.store.heartbeat(gateway({seq:1}),10000,5000)).toBe('gw-a'); // renewed: still the leader after 5 s in total
      await h.wait(3000);
      expect((await h.store.list()).leader).toBe('gw-a');
    });
    test('a record expires after its TTL without heartbeats; the leader hint after its own (shorter) lease, then another active gateway takes it',async()=>{
      await h.store.heartbeat(gateway({id:'gw-a'}),1500,600);
      await h.store.heartbeat(gateway({id:'gw-b',url:'http://127.0.0.1:56461/v1'}),10000,600);
      await h.wait(800);
      expect((await h.store.list()).leader).toBeNull();
      expect((await live(h.store)).map(r=>r.id)).toEqual(['gw-a','gw-b']);
      expect(await h.store.heartbeat(gateway({id:'gw-b',url:'http://127.0.0.1:56461/v1',seq:1}),10000,600)).toBe('gw-b');
      await h.wait(1000);
      expect((await live(h.store)).map(r=>r.id)).toEqual(['gw-b']);
    });
    test('draining: the record says so and a draining leader gives the hint up at once; draining never takes it',async()=>{
      await h.store.heartbeat(gateway(),10000,5000);
      expect(await h.store.heartbeat(gateway({state:'draining',seq:1}),10000,5000)).toBeNull();
      expect((await h.store.list()).leader).toBeNull();
      expect((await live(h.store))[0]!.state).toBe('draining');
      expect(await h.store.heartbeat(gateway({state:'draining',seq:2}),10000,5000)).toBeNull();
      expect(await h.store.heartbeat(gateway({id:'gw-b',url:'http://127.0.0.1:56461/v1'}),10000,5000)).toBe('gw-b');
    });
    test('a free hint goes to the oldest active gateway still beating: a newcomer never takes it from a running standby',async()=>{
      const b=gateway({id:'gw-b',url:'http://127.0.0.1:56461/v1',startedAt:2000}), c=gateway({id:'gw-c',url:'http://127.0.0.1:56462/v1',startedAt:3000});
      await h.store.heartbeat(gateway(),10000,600);await h.store.heartbeat(b,10000,600);
      await h.wait(400);await h.store.heartbeat(b,10000,600);
      await h.wait(400); // gw-a stopped beating 800 ms ago: its hint (600 ms) is gone, its record (10 s) is not
      expect(await h.store.heartbeat(c,10000,600)).toBeNull(); // gw-b is older and still beating
      expect(await h.store.heartbeat(b,10000,600)).toBe('gw-b'); // gw-a is older but no longer beating
      expect((await live(h.store)).map(r=>r.id)).toEqual(['gw-a','gw-b','gw-c']);
      expect((await h.store.list()).records.every(r=>Number.isInteger(Number(r.beatAt))&&r.beatAt!=="")).toBe(true);
    });
    test('claim=false never takes a free hint but still renews one it holds',async()=>{
      expect(await h.store.heartbeat(gateway(),10000,5000,false)).toBeNull();
      expect(await h.store.heartbeat(gateway({seq:1}),10000,5000)).toBe('gw-a');
      expect(await h.store.heartbeat(gateway({seq:2}),10000,5000,false)).toBe('gw-a');
    });
    test('remove deletes the record (and the hint when it holds it)',async()=>{
      await h.store.heartbeat(gateway(),10000,5000);
      await h.store.heartbeat(gateway({id:'gw-b',url:'http://127.0.0.1:56461/v1'}),10000,5000);
      await h.store.remove('gw-a');
      expect((await live(h.store)).map(r=>r.id)).toEqual(['gw-b']);
      expect((await h.store.list()).leader).toBeNull();
      await h.store.remove('gw-b');
      expect(await live(h.store)).toEqual([]);
    });
  });
}
