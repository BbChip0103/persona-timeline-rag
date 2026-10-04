import type { TextProvider } from '@ptr/core';
import { LatencyInjectedTextProvider, parseLatencyProfile, ProviderError } from '../src';

const signal=()=>new AbortController().signal;
const messages=[{role:'user' as const,content:'Synthetic hello'}];
const echo:TextProvider={generate:async()=> 'synthetic reply'};

describe('latency-injected fake provider (load tests only)',()=>{
  test('seeded log-normal samples are reproducible and match the requested median/p95',()=>{
    const profile=parseLatencyProfile('{"medianMs":1900,"p95Ms":3600,"seed":7}');
    const a=new LatencyInjectedTextProvider(echo,profile), b=new LatencyInjectedTextProvider(echo,profile);
    const xs=Array.from({length:4000},()=>a.sampleDelayMs()), ys=Array.from({length:4000},()=>b.sampleDelayMs());
    expect(xs).toEqual(ys);
    const sorted=[...xs].sort((x,y)=>x-y);
    expect(sorted[2000]!).toBeGreaterThan(1900*0.93);expect(sorted[2000]!).toBeLessThan(1900*1.07);
    expect(sorted[3800]!).toBeGreaterThan(3600*0.9);expect(sorted[3800]!).toBeLessThan(3600*1.1);
  });
  test('delegates the inner reply unchanged after the delay',async()=>{
    const provider=new LatencyInjectedTextProvider(echo,parseLatencyProfile('{"medianMs":20,"p95Ms":30,"seed":1}'));
    const started=Date.now();
    expect(await provider.generate(messages,{signal:signal()})).toBe('synthetic reply');
    expect(Date.now()-started).toBeGreaterThanOrEqual(10);
  });
  test('abort during the delay rejects promptly with CANCELLED and never calls the inner provider',async()=>{
    const inner={generate:jest.fn(async()=> 'never')};
    const provider=new LatencyInjectedTextProvider(inner,parseLatencyProfile('{"medianMs":5000,"p95Ms":6000,"seed":1}'));
    const controller=new AbortController();const started=Date.now();
    const pending=provider.generate(messages,{signal:controller.signal});
    setTimeout(()=>controller.abort(),20);
    await expect(pending).rejects.toThrow('CANCELLED');
    expect(Date.now()-started).toBeLessThan(1000);expect(inner.generate).not.toHaveBeenCalled();
  });
  test('injected 429 and hang failures are seeded and typed like the live adapter',async()=>{
    const throttled=new LatencyInjectedTextProvider(echo,parseLatencyProfile('{"medianMs":1,"p95Ms":2,"seed":3,"error429Rate":1}'));
    await expect(throttled.generate(messages,{signal:signal()})).rejects.toThrow(new ProviderError('PROVIDER_HTTP_429'));
    const hanging=new LatencyInjectedTextProvider(echo,parseLatencyProfile('{"medianMs":1,"p95Ms":2,"seed":3,"hangRate":1}'));
    const controller=new AbortController();const pending=hanging.generate(messages,{signal:controller.signal});
    setTimeout(()=>controller.abort(),30);
    await expect(pending).rejects.toThrow('CANCELLED');
  });
  test('profile parsing rejects invalid or unbounded values',()=>{
    for(const raw of ['not json','{}','{"medianMs":0,"p95Ms":10}','{"medianMs":100,"p95Ms":50}','{"medianMs":100,"p95Ms":200,"error429Rate":2}','{"medianMs":100,"p95Ms":700000}','{"medianMs":100,"p95Ms":200,"extra":1}'])
      expect(()=>parseLatencyProfile(raw)).toThrow();
  });
});
