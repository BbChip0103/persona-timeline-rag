import { MemoryUpstreamRegistry, REGISTRY_PREFIX, assertRegistryPrefix, parseUpstreamRecord, registryKeys, serializeUpstreamRecord, type UpstreamRecord } from '../src/upstream-registry';
import { registryContract } from './upstream-registry.contract';

registryContract('memory',async()=>{
  const store=new MemoryUpstreamRegistry();
  return {store,wait:async(ms:number)=>{store.advance(ms);}};
});

const record:UpstreamRecord={pool:'gemma-4-e4b-fp8',id:'pod-a',baseUrl:'http://127.0.0.1:18000/v1',maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e1',seq:3};

describe('upstream record format',()=>{
  test('key layout lives under ptr:llm (no overlap with ptr:turns / ptr:events)',()=>{
    expect(REGISTRY_PREFIX).toBe('ptr:llm');
    expect(registryKeys()).toMatchObject({version:'ptr:llm:reg:ver',channel:'ptr:llm:reg'});
    expect(registryKeys().record('p','a')).toBe('ptr:llm:up:p:a');expect(registryKeys().index('p')).toBe('ptr:llm:ups:p');
    expect(registryKeys('ptrtest:run1:llm').index('p')).toBe('ptrtest:run1:llm:ups:p');
  });
  test('prefixes are validated (dedicated test namespaces allowed, no wildcards or empty parts)',()=>{
    expect(assertRegistryPrefix('ptrtest:abc_1:llm')).toBe('ptrtest:abc_1:llm');
    for(const bad of ['','ptr:','ptr:*','ptr llm','a'.repeat(80),'ptr:turns']) expect(()=>assertRegistryPrefix(bad)).toThrow('INVALID_REGISTRY_PREFIX');
  });
  test('serialize/parse round trip; null kv capacity is an empty field',()=>{
    const hash=serializeUpstreamRecord(record);
    expect(hash.kvCapacityTokens).toBe('');
    expect(parseUpstreamRecord(hash)).toEqual(record);
  });
  test('malformed records are refused with one code',()=>{
    const hash=serializeUpstreamRecord(record);
    for(const bad of ([{maxSeqs:'0'},{maxSeqs:'1.5'},{maxSeqs:'5000'},{weight:'0'},{weight:'nan'},{state:'up'},{id:'a:b'},{pool:'p:q'},{epoch:''},
      {kvCapacityTokens:'-1'},{seq:'x'},{baseUrl:'not a url'}] as Record<string,string>[]))
      expect(()=>parseUpstreamRecord({...hash,...bad})).toThrow('INVALID_UPSTREAM_RECORD');
    const {id:_id,...missing}=hash;
    expect(()=>parseUpstreamRecord(missing)).toThrow('INVALID_UPSTREAM_RECORD');
  });
  test('the memory store can simulate an outage: every call rejects',async()=>{
    const store=new MemoryUpstreamRegistry();store.down=true;
    await expect(store.list('p')).rejects.toThrow('REGISTRY_UNAVAILABLE');
    await expect(store.heartbeat(record,1000)).rejects.toThrow('REGISTRY_UNAVAILABLE');
  });
});
