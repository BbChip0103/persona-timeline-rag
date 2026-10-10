import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client';
import { version } from '../../../package.json';

// Genuine Prometheus collectors own accumulation, buckets, escaping and exposition.
export { Counter, Gauge, Histogram, Registry };
export type Labels=Record<string,string>;
export interface Sample {suffix?:'_bucket'|'_sum'|'_count';labels?:Labels;value:number}
export interface Family {name:string;help:string;type:'counter'|'gauge'|'histogram';samples:Sample[]}
export const TURN_SECONDS_BUCKETS=[0.1,0.25,0.5,1,2.5,5,10,20,30,45,60,120] as const;
export const TTFT_SECONDS_BUCKETS=[0.1,0.25,0.5,1,2,3,5,10,20,30] as const;

const PROCESS_START_SECONDS=Math.round((Date.now()/1000-process.uptime())*1000)/1000;
/** Isolated per-role registry: constructing test runtimes cannot duplicate global metrics. */
export function createMetricsRegistry(role:'api'|'worker'):Registry {
  const registry=new Registry(Registry.PROMETHEUS_CONTENT_TYPE);
  new Gauge({name:'ptr_build_info',help:'Build information; always 1.',labelNames:['role','version'],registers:[registry]})
    .set({role,version},1);
  new Gauge({name:'process_start_time_seconds',help:'Start time of the process since the Unix epoch in seconds.',registers:[registry]})
    .set(PROCESS_START_SECONDS);
  return registry;
}

export interface ParsedSample {name:string;labels:Labels;value:number}
export interface ParsedExposition {types:Map<string,Family['type']>;samples:ParsedSample[]}
const SAMPLE=/^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/;
function parseLabels(raw:string):Labels {
  const labels:Labels={};let rest=raw.trim();
  while(rest.length) {
    const match=/^([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"\s*(,\s*)?/.exec(rest);
    if(!match) throw new Error('INVALID_EXPOSITION');
    labels[match[1]!]=match[2]!.replace(/\\(.)/g,(_,c:string)=>c==='n'?'\n':c);
    rest=rest.slice(match[0].length);
  }
  return labels;
}
function parseValue(raw:string):number {
  if(raw==='+Inf'||raw==='Inf') return Infinity;if(raw==='-Inf') return -Infinity;if(raw==='NaN') return NaN;
  if(!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(raw)) throw new Error('INVALID_EXPOSITION');
  return Number(raw);
}
/**
 * Strict reader of the format above (also used by `pnpm ops:status`): every sample must belong to the family declared
 * by the last TYPE line (histograms with their _bucket/_sum/_count suffixes); anything else throws INVALID_EXPOSITION.
 */
export function parseExposition(text:string):ParsedExposition {
  const types=new Map<string,Family['type']>(), samples:ParsedSample[]=[];let current:string|undefined;
  for(const line of text.split('\n')) {
    if(!line.trim()) continue;
    if(line.startsWith('#')) {
      const type=/^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (\S+)$/.exec(line);
      if(type) {
        if(!['counter','gauge','histogram','summary','untyped'].includes(type[2]!)||types.has(type[1]!)) throw new Error('INVALID_EXPOSITION');
        types.set(type[1]!,type[2] as Family['type']);current=type[1];
      } else if(!/^# HELP [a-zA-Z_:][a-zA-Z0-9_:]* ?/.test(line)&&!/^# /.test(line)) throw new Error('INVALID_EXPOSITION');
      continue;
    }
    const match=SAMPLE.exec(line);
    if(!match) throw new Error('INVALID_EXPOSITION');
    const name=match[1]!;
    const family=types.get(current??'')==='histogram'?name.replace(/_(bucket|sum|count)$/,''):name;
    if(family!==current) throw new Error('INVALID_EXPOSITION');
    samples.push({name,labels:parseLabels(match[2]??''),value:parseValue(match[3]!)});
  }
  return {types,samples};
}
