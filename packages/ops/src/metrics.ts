import { version } from '../../../package.json';

/**
 * Hand-written Prometheus text exposition, format 0.0.4 : no client library. Every role serves the
 * same shape at `/metrics/prom`: aggregates only, labels from fixed enums or operator-chosen upstream ids, never text.
 */
export type Labels=Record<string,string>;
export interface Sample {suffix?:'_bucket'|'_sum'|'_count';labels?:Labels;value:number}
export interface Family {name:string;help:string;type:'counter'|'gauge'|'histogram';samples:Sample[]}

const METRIC_NAME=/^[a-zA-Z_:][a-zA-Z0-9_:]*$/, LABEL_NAME=/^[a-zA-Z_][a-zA-Z0-9_]*$/;
const labelKey=(labels:Labels)=>JSON.stringify(Object.entries(labels).sort(([a],[b])=>a.localeCompare(b)));

/** Counter (or gauge) values per label set, in first-seen order. */
export class Counter {
  private readonly values=new Map<string,{labels:Labels;value:number}>();
  inc(labels:Labels={},by=1):void {
    const key=labelKey(labels);const entry=this.values.get(key);
    if(entry) entry.value+=by;else this.values.set(key,{labels:{...labels},value:by});
  }
  get(labels:Labels={}):number {return this.values.get(labelKey(labels))?.value??0;}
  samples():Sample[] {return [...this.values.values()].map(({labels,value})=>({labels,value}));}
}
/** Cumulative histogram with fixed upper bounds (seconds). */
export class Histogram {
  private readonly counts:number[];private sum=0;private count=0;
  constructor(private readonly buckets:readonly number[]) {this.counts=buckets.map(()=>0);}
  observe(value:number):void {
    if(!Number.isFinite(value)) return;
    this.sum+=value;this.count++;
    this.buckets.forEach((bound,index)=>{if(value<=bound) this.counts[index]!++;});
  }
  samples():Sample[] {
    return [...this.buckets.map((bound,index)=>({suffix:'_bucket' as const,labels:{le:String(bound)},value:this.counts[index]!})),
      {suffix:'_bucket',labels:{le:'+Inf'},value:this.count},{suffix:'_sum',value:this.sum},{suffix:'_count',value:this.count}];
  }
}
/** Turn-scale buckets: the 30 s turn deadline and the 60 s queue limit sit on bucket edges. */
export const TURN_SECONDS_BUCKETS=[0.1,0.25,0.5,1,2.5,5,10,20,30,45,60,120] as const;
/** Time to first token: the 10 s headers wait and the 30 s turn deadline sit on bucket edges. */
export const TTFT_SECONDS_BUCKETS=[0.1,0.25,0.5,1,2,3,5,10,20,30] as const;

const escapeLabel=(value:string)=>value.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/\n/g,'\\n');
const escapeHelp=(value:string)=>value.replace(/\\/g,'\\\\').replace(/\n/g,'\\n');
const formatValue=(value:number)=>Number.isNaN(value)?'NaN':value===Infinity?'+Inf':value===-Infinity?'-Inf':String(value);
export function renderFamilies(families:readonly Family[]):string {
  const lines:string[]=[];
  for(const family of families) {
    if(!METRIC_NAME.test(family.name)) throw new Error('INVALID_METRIC_NAME');
    lines.push(`# HELP ${family.name} ${escapeHelp(family.help)}`,`# TYPE ${family.name} ${family.type}`);
    for(const sample of family.samples) {
      const labels=Object.entries(sample.labels??{});
      if(labels.some(([name])=>!LABEL_NAME.test(name)||name.startsWith('__'))) throw new Error('INVALID_LABEL_NAME');
      const rendered=labels.length?`{${labels.map(([name,value])=>`${name}="${escapeLabel(value)}"`).join(',')}}`:'';
      lines.push(`${family.name}${sample.suffix??''}${rendered} ${formatValue(sample.value)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Fixed once, so every scrape reports the same start time. */
const PROCESS_START_SECONDS=Math.round((Date.now()/1000-process.uptime())*1000)/1000;
/** Labels every role reports: build (role, package version) and process start (seconds since the epoch). */
export function commonFamilies(role:string):Family[] {
  return [{name:'ptr_build_info',help:'Build information; always 1.',type:'gauge',samples:[{labels:{role,version},value:1}]},
    {name:'process_start_time_seconds',help:'Start time of the process since the Unix epoch in seconds.',type:'gauge',
      samples:[{value:PROCESS_START_SECONDS}]}];
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
