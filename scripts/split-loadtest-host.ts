/** Numeric, bounded host provenance only. Never reads process argv, environment or payloads. */
import {open} from 'node:fs/promises';
import {cpus,loadavg,uptime} from 'node:os';

export const HOST_VMSTAT_KEYS=['pgfault','pgmajfault','pswpin','pswpout'] as const;
export function selectedCounters(text:string,keys:readonly string[]):Record<string,number> {
  const wanted=new Set(keys),result:Record<string,number>={};
  for(const line of text.split('\n')){const match=/^([A-Za-z_]+):?\s+(\d+)(?:\s+kB)?$/.exec(line.trim());if(match&&wanted.has(match[1]!)){const n=Number(match[2]);if(Number.isSafeInteger(n))result[match[1]!]=n;}}
  return result;
}
export function pressureCounters(text:string):Record<string,Record<string,number>> {
  const result:Record<string,Record<string,number>>={};
  for(const line of text.trim().split('\n')){const [kind,...fields]=line.split(/\s+/);if(kind!=='some'&&kind!=='full')continue;const values:Record<string,number>={};for(const field of fields){const match=/^(avg10|avg60|avg300|total)=(\d+(?:\.\d+)?)$/.exec(field);if(match){const n=Number(match[2]);if(Number.isFinite(n))values[match[1]!]=n;}}if(Object.keys(values).length)result[kind]=values;}
  return result;
}
export function processCounters(text:string):Record<string,number> {
  // Linux comm may contain spaces or parentheses: never expose it, parse after its final ')'.
  const end=text.lastIndexOf(')'),fields=text.slice(end+2).trim().split(/\s+/),result:Record<string,number>={};
  if(end<0)return result;
  for(const [key,index] of [['parentPid',1],['userTicks',11],['systemTicks',12],['threads',17],['startTicks',19],['virtualBytes',20],['residentPages',21]] as const){const raw=fields[index];if(raw&&/^\d+$/.test(raw)){const n=Number(raw);if(Number.isSafeInteger(n))result[key]=n;}}
  return result;
}
async function boundedProc(path:string):Promise<string|null>{let file:Awaited<ReturnType<typeof open>>|undefined;try{file=await open(path,'r');const buffer=Buffer.alloc(32769),{bytesRead}=await file.read(buffer,0,buffer.length,0);return bytesRead>32768?null:buffer.subarray(0,bytesRead).toString('utf8');}catch{return null;}finally{await file?.close();}}
export async function hostSnapshot(ownedPids:readonly number[]) {
  const capturedAt=new Date().toISOString(),started=performance.now();
  const [memory,vmstat,cpu,io,pressureMemory]=await Promise.all(['/proc/meminfo','/proc/vmstat','/proc/pressure/cpu','/proc/pressure/io','/proc/pressure/memory'].map(boundedProc));
  const pids=[...new Set([process.pid,...ownedPids.filter(n=>Number.isSafeInteger(n)&&n>0)])];
  const processes=await Promise.all(pids.map(async pid=>{const [stats,status]=await Promise.all([boundedProc(`/proc/${pid}/stat`),boundedProc(`/proc/${pid}/status`)]);return {pid,available:stats!==null&&status!==null,counters:stats===null?null:processCounters(stats),memoryKbAndSwitches:status===null?null:selectedCounters(status,['VmRSS','VmSwap','voluntary_ctxt_switches','nonvoluntary_ctxt_switches'])};}));
  const cpuCount=cpus().length,loadAverage=loadavg(),uptimeSeconds=uptime(),memoryKb=memory===null?null:selectedCounters(memory,['MemTotal','MemAvailable','SwapTotal','SwapFree']),vmstatCounters=vmstat===null?null:selectedCounters(vmstat,HOST_VMSTAT_KEYS),
    pressure={cpu:cpu===null?null:pressureCounters(cpu),io:io===null?null:pressureCounters(io),memory:pressureMemory===null?null:pressureCounters(pressureMemory)};
  const available=memoryKb!==null&&Object.keys(memoryKb).length===4&&vmstatCounters!==null&&Object.keys(vmstatCounters).length===4&&Object.values(pressure).every(p=>p!==null&&Object.keys(p.some??{}).length===4)&&processes.every(p=>p.available&&Object.keys(p.counters??{}).length===7&&Object.keys(p.memoryKbAndSwitches??{}).length===4);
  return {capturedAt,completedAt:new Date().toISOString(),probeElapsedMs:performance.now()-started,cpuCount,loadAverage,uptimeSeconds,memoryKb,vmstat:vmstatCounters,pressure,processes,available};
}
export type HostSnapshot=Awaited<ReturnType<typeof hostSnapshot>>;
