import { z } from 'zod';
import type { ProviderMessage } from '@ptr/contracts';
import type { TextProvider } from '@ptr/core';
import { ProviderError } from './budget';

/** Load-test only: per-call model delay and failure injection around a (fake) provider. */
const LatencyProfileSchema=z.object({
  medianMs:z.number().int().min(1).max(600_000),
  p95Ms:z.number().int().min(1).max(600_000),
  seed:z.number().int().min(0).max(2**31-1).default(1),
  error429Rate:z.number().min(0).max(1).default(0),
  hangRate:z.number().min(0).max(1).default(0),
}).strict().refine(value=>value.p95Ms>=value.medianMs,'p95Ms must be >= medianMs');
export type LatencyProfile=z.infer<typeof LatencyProfileSchema>;
export function parseLatencyProfile(raw:string):LatencyProfile { return LatencyProfileSchema.parse(JSON.parse(raw)); }

// z-score of the 95th percentile of the standard normal distribution.
const Z95=1.6448536269514722;
function mulberry32(seed:number):()=>number {
  let state=seed>>>0;
  return ()=>{
    state=(state+0x6D2B79F5)>>>0;
    let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);
    return ((t^(t>>>14))>>>0)/4294967296;
  };
}
function sleep(ms:number,signal:AbortSignal):Promise<void> {
  return new Promise((resolve,reject)=>{
    if(signal.aborted) return reject(new ProviderError('CANCELLED'));
    const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);
    const onAbort=()=>{clearTimeout(timer);reject(new ProviderError('CANCELLED'));};
    signal.addEventListener('abort',onAbort,{once:true});
  });
}

/** Log-normal delay fitted to median/p95, so fake load tests wait like a real model call. */
export class LatencyInjectedTextProvider implements TextProvider {
  private readonly random:()=>number;
  private readonly mu:number;
  private readonly sigma:number;
  constructor(private readonly inner:TextProvider,private readonly profile:LatencyProfile) {
    this.random=mulberry32(profile.seed);
    this.mu=Math.log(profile.medianMs);
    this.sigma=(Math.log(profile.p95Ms)-this.mu)/Z95;
  }
  sampleDelayMs():number {
    // Box-Muller; 1-u keeps log() away from zero.
    const u=1-this.random(), v=this.random();
    const normal=Math.sqrt(-2*Math.log(u))*Math.cos(2*Math.PI*v);
    return Math.round(Math.exp(this.mu+this.sigma*normal));
  }
  async generate(messages:ProviderMessage[],options:{signal:AbortSignal;onServed?:(upstream:string)=>void}):Promise<string> {
    const failure=this.random(), delay=this.sampleDelayMs();
    if(failure<this.profile.hangRate) {
      // Never resolves on its own: exercises the caller's timeout/cancel path.
      await new Promise<never>((_,reject)=>{
        if(options.signal.aborted) return reject(new ProviderError('CANCELLED'));
        options.signal.addEventListener('abort',()=>reject(new ProviderError('CANCELLED')),{once:true});
      });
    }
    await sleep(delay,options.signal);
    if(failure<this.profile.hangRate+this.profile.error429Rate) throw new ProviderError('PROVIDER_HTTP_429');
    return this.inner.generate(messages,options);
  }
}
