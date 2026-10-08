/**
 * Engine telemetry (routing , stage S4): each pool member's `GET {origin}/metrics` (Prometheus text) is
 * polled every PTR_GATEWAY_METRICS_INTERVAL_MS. It is used only as a filter (§3.1 item 5: KV usage < kvHigh and
 * waiting ≤ waitingMax while fresh), never as a score input (delayed telemetry in a closed loop oscillates). Older than
 * 3 × the interval it is ignored (fail-open: the gateway's own ledger decides). It also reports credit_model_miss
 * (the engine queues although the gateway's credits said it had room) and detects engine restarts.
 *
 * Metric names (vLLM v1, docs/design/metrics.md and v1/metrics/loggers.py upstream; NOT verified against the deployed
 * vLLM build, design [확인 필요]): vllm:num_requests_running, vllm:num_requests_waiting (gauges, summed over label
 * sets), vllm:kv_cache_usage_perc (gauge 0–1; older builds vllm:gpu_cache_usage_perc; the highest label set counts),
 * vllm:prefix_cache_queries / vllm:prefix_cache_hits (counters, with or without the `_total` suffix; older
 * vllm:gpu_prefix_cache_*), and process_start_time_seconds (prometheus_client's process collector; may be absent, e.g.
 * in multiprocess mode, then restarts are not detected here).
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

export interface TelemetryOptions {
  intervalMs:number;
  /** PTR_GATEWAY_ENGINE_KV_HIGH (0.95): fresh KV usage at or above it takes the upstream out of selection. */
  kvHigh:number;
  /** PTR_GATEWAY_ENGINE_WAITING_MAX (2): fresh waiting above it takes the upstream out of selection. */
  waitingMax:number;
  /** One poll's timeout (default min(500 ms, interval)). */
  timeoutMs?:number;
  /** Fresh polls in a row with waiting > 0 that count one credit_model_miss (default 3). */
  missPolls?:number;
  /**
   * The member's maxSeqs and a warning sink: blocked for `suspectPolls` (10) polls in a row while the engine runs fewer
   * than maxSeqs / 4 sequences is suspicious (a metric that does not mean what we assume), warned once per episode.
   */
  maxSeqs?:()=>number; warn?:(line:string)=>void; suspectPolls?:number;
  /** Polls in a row with one start time that re-arm restart detection after it was turned off (default 30). */
  rearmPolls?:number;
  now:()=>number;
}
export interface TelemetryMetrics {
  /** telemetry_stale: no good poll within 3 × the interval (never polled counts as stale). */
  stale:boolean; ageMs:number|null; staleEpisodes:number; failedPolls:number;
  running:number|null; waiting:number|null; kvUsage:number|null;
  /** Prefix cache hit share over the last two good polls (null without the counters or without new queries). */
  prefixHitRate:number|null;
  /** The filter result now, and how many good polls blocked. */
  blocked:boolean; blockedPolls:number;
  /** credit_model_miss episodes, and the current run of polls with waiting > 0. */
  creditModelMiss:number; waitingStreak:number;
  restarts:number;
  /** True after a start time earlier than the latest seen appeared (several processes on one port) until 30 polls in a row agree again. */
  restartDetectionDisabled:boolean;
  /** Polls with an impossible value (KV usage outside [0, 1], a negative count), which is then treated as unknown. */
  implausible:number;
  /** Episodes of "blocked while running < maxSeqs / 4" (see TelemetryOptions.maxSeqs). */
  suspectBlocked:number;
}
/** One upstream's poller. `onChange` runs when a poll flips the filter result or reveals an engine restart. */
export class EngineTelemetry {
  private last:EngineMetrics|undefined;private lastOkAt:number|undefined;private staleCountedFor:number|undefined;
  private startTime:number|null=null;private startCandidate:number|null=null;private restartDetectionOff=false;private lastStart:number|null=null;private sameStart=0;private hitRate:number|null=null;private suspectStreak=0;
  private timer:NodeJS.Timeout|undefined;private polling:Promise<void>|undefined;private stopped=false;
  private readonly counts={staleEpisodes:0,failedPolls:0,blockedPolls:0,creditModelMiss:0,waitingStreak:0,restarts:0,implausible:0,suspectBlocked:0};
  constructor(private readonly fetchMetrics:(signal:AbortSignal)=>Promise<string|null>,private readonly options:TelemetryOptions,
    private readonly onChange:(event:{restarted:boolean;detectionOff:boolean;baselineChanged:boolean})=>void) {}
  start():void {
    if(this.timer||this.stopped) return;
    void this.poll();
    this.timer=setInterval(()=>void this.poll(),this.options.intervalMs);this.timer.unref();
  }
  stop():void {this.stopped=true;clearInterval(this.timer);this.timer=undefined;}
  /** True while no good poll is younger than 3 × the interval. */
  stale():boolean {
    const stale=this.lastOkAt===undefined||this.options.now()-this.lastOkAt>3*this.options.intervalMs;
    if(stale&&this.lastOkAt!==undefined&&this.staleCountedFor!==this.lastOkAt) {this.staleCountedFor=this.lastOkAt;this.counts.staleEpisodes++;}
    return stale;
  }
  /** §3.1 item 5, only while fresh: KV usage ≥ kvHigh or waiting > waitingMax. */
  blocked():boolean {
    if(this.stale()||!this.last) return false;
    return (this.last.kvUsage!==null&&this.last.kvUsage>=this.options.kvHigh)||(this.last.waiting!==null&&this.last.waiting>this.options.waitingMax);
  }
  /** One poll; a poll still running is joined, not duplicated. */
  poll():Promise<void> {
    this.polling??=this.pollOnce().finally(()=>{this.polling=undefined;});
    return this.polling;
  }
  private async pollOnce():Promise<void> {
    let text:string|null;
    try {text=await this.fetchMetrics(AbortSignal.timeout(this.options.timeoutMs??Math.min(500,this.options.intervalMs)));} catch {text=null;}
    if(this.stopped) return;
    if(text===null) {this.counts.failedPolls++;return;}
    const before=this.blocked(), parsed=parseEngineMetrics(text), previous=this.last;
    // Impossible values are unknown (never a block): a metric that does not mean what we assume must not remove a server.
    let implausible=false;
    if(parsed.kvUsage!==null&&(parsed.kvUsage<0||parsed.kvUsage>1)) {parsed.kvUsage=null;implausible=true;}
    if(parsed.running!==null&&parsed.running<0) {parsed.running=null;implausible=true;}
    if(parsed.waiting!==null&&parsed.waiting<0) {parsed.waiting=null;implausible=true;}
    if(implausible) this.counts.implausible++;
    this.last=parsed;this.lastOkAt=this.options.now();
    // A restart is a LATER start time seen on two polls in a row. A start time earlier than the latest one seen (current
    // or candidate) cannot come from a restart: several processes answer on this port (API servers each with its own
    // start), so detection is turned off for this member (one warning) instead of flapping between them. It re-arms once
    // `rearmPolls` polls in a row report one start time (one process again), with that value as the new baseline. A new
    // baseline other than the one before detection went off (`baselineChanged`) means the process left on the port may
    // not be the engine the gateway's prefix table describes: the pool empties that table (S5 re-check).
    let restarted=false, detectionOff=false, baselineChanged=false;
    const start=parsed.startTimeSeconds;
    if(start!==null&&this.restartDetectionOff) {
      this.sameStart=start===this.lastStart?this.sameStart+1:1;this.lastStart=start;
      if(this.sameStart>=(this.options.rearmPolls??30)) {
        this.restartDetectionOff=false;baselineChanged=start!==this.startTime;this.startTime=start;this.startCandidate=null;
        this.options.warn?.(`restart detection back on: ${this.sameStart} polls in a row with one process_start_time_seconds`);
      }
    } else if(start!==null) {
      const latest=Math.max(this.startTime??-Infinity,this.startCandidate??-Infinity);
      if(this.startTime===null) this.startTime=start;
      else if(start<latest) {
        this.restartDetectionOff=true;this.startCandidate=null;this.lastStart=start;this.sameStart=1;detectionOff=true;
        this.options.warn?.('restart detection off: process_start_time_seconds went back to an earlier value, so several processes answer on this port');
      }
      else if(start===this.startTime) this.startCandidate=null;
      else if(start===this.startCandidate) {restarted=true;this.startTime=start;this.startCandidate=null;}
      else this.startCandidate=start;
    }
    if(restarted) {this.counts.restarts++;this.counts.waitingStreak=0;this.hitRate=null;}
    else if(previous&&parsed.prefixQueries!==null&&parsed.prefixHits!==null&&previous.prefixQueries!==null&&previous.prefixHits!==null) {
      const queries=parsed.prefixQueries-previous.prefixQueries;
      if(queries>0) this.hitRate=Math.round((parsed.prefixHits-previous.prefixHits)/queries*1000)/1000;
    }
    if(parsed.waiting!==null&&parsed.waiting>0) {if(++this.counts.waitingStreak===(this.options.missPolls??3)) this.counts.creditModelMiss++;}
    else this.counts.waitingStreak=0;
    const after=this.blocked(), maxSeqs=this.options.maxSeqs?.();
    if(after) this.counts.blockedPolls++;
    if(after&&maxSeqs&&Number.isFinite(maxSeqs)&&parsed.running!==null&&parsed.running<maxSeqs/4) {
      if(++this.suspectStreak===(this.options.suspectPolls??10)) {
        this.counts.suspectBlocked++;
        this.options.warn?.(`blocked by engine telemetry for ${this.suspectStreak} polls while running ${parsed.running} < maxSeqs ${maxSeqs} / 4 `
          +`(kv_cache_usage_perc ${parsed.kvUsage}, waiting ${parsed.waiting}): check that the engine's metrics mean what the filter assumes`);
      }
    } else this.suspectStreak=0;
    if(restarted||detectionOff||baselineChanged||after!==before) this.onChange({restarted,detectionOff,baselineChanged});
  }
  metrics():TelemetryMetrics {
    const stale=this.stale(), now=this.options.now();
    return {stale,ageMs:this.lastOkAt===undefined?null:now-this.lastOkAt,staleEpisodes:this.counts.staleEpisodes,failedPolls:this.counts.failedPolls,
      running:this.last?.running??null,waiting:this.last?.waiting??null,kvUsage:this.last?.kvUsage??null,prefixHitRate:this.hitRate,
      blocked:this.blocked(),blockedPolls:this.counts.blockedPolls,creditModelMiss:this.counts.creditModelMiss,waitingStreak:this.counts.waitingStreak,
      restarts:this.counts.restarts,restartDetectionDisabled:this.restartDetectionOff,implausible:this.counts.implausible,suspectBlocked:this.counts.suspectBlocked};
  }
}
