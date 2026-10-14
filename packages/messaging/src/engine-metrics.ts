/** Pure read-only vLLM metrics parser for local engine observations.
 * No polling, router, registry, credit admission or failover state lives here.
 */
export interface EngineMetrics {
  running:number|null; waiting:number|null; kvUsage:number|null;
  prefixQueries:number|null; prefixHits:number|null; startTimeSeconds:number|null;
}
const add=(sum:number|null,value:number)=>(sum??0)+value;
/**
 * One sample line → name and value; null for comments, blank or malformed lines. Label values may contain `}` and
 * escaped quotes; a timestamp or an OpenMetrics exemplar (`# {…} v`) after the value is ignored.
 */
function sample(line:string):{name:string;value:number}|null {
  const name=/^[A-Za-z_:][A-Za-z0-9_:]*/.exec(line)?.[0];
  if(!name) return null;
  let i=name.length;
  if(line[i]==='{') {
    let quoted=false;
    for(i++;i<line.length;i++) {
      const c=line[i];
      if(quoted&&c==='\\') {i++;continue;}
      if(c==='"') quoted=!quoted;
      else if(c==='}'&&!quoted) break;
    }
    if(i>=line.length) return null;
    i++;
  }
  const value=/^\s+(\S+)/.exec(line.slice(i))?.[1];
  return value===undefined?null:{name,value:Number(value)}; // NaN, +Inf, -Inf → not finite, skipped by the caller
}
export function parseEngineMetrics(text:string):EngineMetrics {
  const out:EngineMetrics={running:null,waiting:null,kvUsage:null,prefixQueries:null,prefixHits:null,startTimeSeconds:null};
  for(const raw of text.split('\n')) {
    const parsed=sample(raw.trim());
    if(!parsed||!Number.isFinite(parsed.value)) continue;
    const {name,value}=parsed;
    if(name==='vllm:num_requests_running') out.running=add(out.running,value);
    else if(name==='vllm:num_requests_waiting') out.waiting=add(out.waiting,value);
    else if(name==='vllm:kv_cache_usage_perc'||name==='vllm:gpu_cache_usage_perc') out.kvUsage=Math.max(out.kvUsage??0,value);
    else if(/^vllm:(gpu_)?prefix_cache_queries(_total)?$/.test(name)) out.prefixQueries=add(out.prefixQueries,value);
    else if(/^vllm:(gpu_)?prefix_cache_hits(_total)?$/.test(name)) out.prefixHits=add(out.prefixHits,value);
    else if(name==='process_start_time_seconds') out.startTimeSeconds=value;
  }
  return out;
}
