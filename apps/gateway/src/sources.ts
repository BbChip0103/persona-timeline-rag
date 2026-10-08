import { readFileSync, statSync } from 'node:fs';
import { parseUpstreamRecord, POOL_NAME, REGISTRY_TTL_MS, REGISTRY_HEARTBEAT_MS, UPSTREAM_ID, type RegistryReader, type UpstreamRecord } from '@ptr/messaging';

export interface SourceMetrics {
  discovery:'static'|'file'|'redis';
  /** registry_stale: the last registry poll failed; membership is frozen. */
  stale:boolean; staleForMs:number|null; failedPolls:number;
  /** registry_rejected: records ignored (baseUrl off loopback or outside PTR_GATEWAY_UPSTREAM_ALLOW, a baseUrl another id already uses, or malformed), counted once per record version. */
  rejected:number; rejectedReasons:Record<string,number>;
  /** Time left in the post-reconnect grace during which records missing from the registry are kept. */
  graceRemainingMs:number;
  version:number|null; fileErrors:number;
}
/** Where the pool's upstream set comes from: a fixed list, a JSON file, or the Redis registry (later: Kubernetes EndpointSlices). */
export interface UpstreamSource {
  snapshot():UpstreamRecord[];
  /** Called after every change of the snapshot; returns an unsubscribe function. */
  onChange(listener:()=>void):()=>void;
  /** First load / first poll and background refresh; resolves even when the registry is unreachable (then stale). */
  start?():Promise<void>;
  close?():Promise<void>;
  metrics?():SourceMetrics;
}

class Listeners {
  private readonly set=new Set<()=>void>();
  add(listener:()=>void):()=>void {this.set.add(listener);return ()=>{this.set.delete(listener);};}
  emit():void {for(const listener of [...this.set]) listener();}
}
const baseMetrics=(discovery:SourceMetrics['discovery']):SourceMetrics=>({discovery,stale:false,staleForMs:null,failedPolls:0,rejected:0,rejectedReasons:{},
  graceRemainingMs:0,version:null,fileErrors:0});
const sameRecords=(a:UpstreamRecord[],b:UpstreamRecord[])=>a.length===b.length&&a.every((record,index)=>{
  const other=b[index]!;
  return record.id===other.id&&record.baseUrl===other.baseUrl&&record.maxSeqs===other.maxSeqs&&record.weight===other.weight&&record.state===other.state
    &&record.epoch===other.epoch&&record.kvCapacityTokens===other.kvCapacityTokens;
});
const byId=(records:UpstreamRecord[])=>[...records].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);

/** Fixed list: env-only PTR_SELFHOSTED_* and FailoverUpstream are "a file with one entry". */
export class StaticUpstreamSource implements UpstreamSource {
  private readonly listeners=new Listeners();
  constructor(private readonly records:UpstreamRecord[]) {}
  snapshot():UpstreamRecord[] {return this.records;}
  onChange(listener:()=>void):()=>void {return this.listeners.add(listener);}
  metrics():SourceMetrics {return baseMetrics('static');}
}

export interface AllowRule {host:string;from:number;to:number}
/** PTR_GATEWAY_UPSTREAM_ALLOW: comma list of `127.0.0.1:<port>` or `127.0.0.1:<from>-<to>` (default 127.0.0.1:18000-18999). */
export function parseUpstreamAllow(value:string|undefined):AllowRule[] {
  const invalid=()=>new Error('INVALID_PTR_GATEWAY_UPSTREAM_ALLOW');
  const raw=value??'127.0.0.1:18000-18999';
  const rules=raw.split(',').map(part=>part.trim()).filter(Boolean).map(part=>{
    const match=/^127\.0\.0\.1:(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);if(!match) throw invalid();
    const from=Number(match[1]),to=Number(match[2]??match[1]);
    if(from<1||to>65535||from>to) throw invalid();
    return {host:'127.0.0.1',from,to};
  });
  if(!rules.length) throw invalid();
  return rules;
}
/**
 * The gateway's own rule for any upstream URL (same as OpenAICompatibleUpstream): plain http on 127.0.0.1, no
 * credentials, query or fragment. With `allow` (registry records) the explicit port must also be allowlisted.
 * Returns the rejection reason, or null when it may be used.
 */
export function checkUpstreamUrl(baseUrl:string,allow?:AllowRule[]):'not_loopback'|'not_allowed'|null {
  let url:URL;try {url=new URL(baseUrl);} catch {return 'not_loopback';}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash) return 'not_loopback';
  if(!allow) return null;
  const port=Number(url.port);
  return url.port&&allow.some(rule=>rule.host===url.hostname&&port>=rule.from&&port<=rule.to)?null:'not_allowed';
}

const FILE_KEYS=new Set(['id','baseUrl','maxSeqs','kvCapacityTokens','weight','prefillTokensPerSec']);
/**
 * `{"pools":{"<pool = served model name>":{"upstreams":[{"id","baseUrl","maxSeqs"?,"kvCapacityTokens"?,"weight"?}]}}}`.
 * Operator config: loopback rule only (the registry allowlist is for records anyone with the Redis password can write).
 * `prefillTokensPerSec` is accepted for the later credit stage and ignored now.
 */
export function readUpstreamsFile(text:string,pool:string):UpstreamRecord[] {
  const invalid=()=>new Error('INVALID_UPSTREAMS_FILE');
  let parsed:unknown;try {parsed=JSON.parse(text);} catch {throw invalid();}
  const entries=(parsed as {pools?:Record<string,{upstreams?:unknown}>})?.pools?.[pool]?.upstreams;
  if(!Array.isArray(entries)) throw invalid();
  const seen=new Set<string>();
  return entries.map(entry=>{
    const e=entry as Record<string,unknown>;
    if(!e||typeof e!=='object'||Object.keys(e).some(key=>!FILE_KEYS.has(key))) throw invalid();
    const maxSeqs=e.maxSeqs??12, weight=e.weight??1, kv=e.kvCapacityTokens??null;
    if(typeof e.id!=='string'||!UPSTREAM_ID.test(e.id)||seen.has(e.id)||typeof e.baseUrl!=='string'||checkUpstreamUrl(e.baseUrl)
      ||!Number.isInteger(maxSeqs)||(maxSeqs as number)<1||(maxSeqs as number)>4096||typeof weight!=='number'||!(weight>0&&weight<=100)
      ||(kv!==null&&(!Number.isInteger(kv)||(kv as number)<1))) throw invalid();
    seen.add(e.id);
    return {pool,id:e.id,baseUrl:e.baseUrl,maxSeqs:maxSeqs as number,kvCapacityTokens:kv as number|null,weight,state:'active',epoch:'file',seq:0};
  });
}

/** PTR_GATEWAY_UPSTREAMS_FILE: read at startup (invalid = startup error), re-read when its mtime changes and on SIGHUP. */
export class FileUpstreamSource implements UpstreamSource {
  private records:UpstreamRecord[];private mtimeMs:number;private timer:NodeJS.Timeout|undefined;
  private readonly listeners=new Listeners();private fileErrors=0;
  constructor(private readonly path:string,private readonly pool:string,private readonly options:{reloadMs?:number}={}) {
    this.mtimeMs=statSync(path).mtimeMs;
    this.records=byId(readUpstreamsFile(readFileSync(path,'utf8'),pool));
  }
  snapshot():UpstreamRecord[] {return this.records;}
  onChange(listener:()=>void):()=>void {return this.listeners.add(listener);}
  async start():Promise<void> {
    if(this.timer) return;
    this.timer=setInterval(()=>{
      try {if(statSync(this.path).mtimeMs!==this.mtimeMs) this.reload();} catch {this.fileErrors++;}
    },this.options.reloadMs??5000);this.timer.unref();
  }
  /** Re-read now (SIGHUP). A file that no longer parses keeps the last good list. */
  reload():void {
    try {
      this.mtimeMs=statSync(this.path).mtimeMs;
      const next=byId(readUpstreamsFile(readFileSync(this.path,'utf8'),this.pool));
      if(sameRecords(next,this.records)) return;
      this.records=next;this.listeners.emit();
    } catch {
      this.fileErrors++;
      // No file contents or URLs in logs.
      process.stderr.write('GATEWAY_UPSTREAMS_FILE_INVALID (keeping the last good list)\n');
    }
  }
  async close():Promise<void> {clearInterval(this.timer);this.timer=undefined;}
  metrics():SourceMetrics {return {...baseMetrics('file'),fileErrors:this.fileErrors};}
}

export interface RegistrySourceOptions {
  pool:string;
  /** Registry records must also pass this allowlist (13.4). */
  allow:AllowRule[];
  pollMs?:number;
  /** After the registry becomes readable again, records missing from it are kept this long (default: the record TTL). */
  graceMs?:number;
  now?:()=>number;
  /**
   * Static seed (the upstreams file, or PTR_SELFHOSTED_BASE_URL as one entry): the membership until the registry has
   * been read once (Redis unreachable at startup). From then on the registry is the only authority, so a drained or
   * removed upstream can never come back from the seed.
   */
  seed?:UpstreamSource;
}
/**
 * PTR_GATEWAY_DISCOVERY=redis. Polls the pool's registry every `pollMs` (2 s) and at once on a pub/sub nudge (lost
 * nudges are covered by the next poll). While Redis cannot be read the membership is frozen: nothing is added or
 * expired, and dead upstreams are left to the breaker (`stale`). Once readable again, records missing from the
 * registry are kept for `graceMs` (the TTL, 10 s) before they are dropped, because the agents' next heartbeat may not
 * have landed yet, or Redis expired them while it was unreachable.
 */
export class RedisRegistrySource implements UpstreamSource {
  private registry:UpstreamRecord[]=[];private merged:UpstreamRecord[]=[];
  private readonly listeners=new Listeners();
  private timer:NodeJS.Timeout|undefined;private unsubscribe:(()=>Promise<void>)|undefined;private subscribing:Promise<void>|undefined;
  private stopSeed:(()=>void)|undefined;
  private polling:Promise<void>|undefined;private again=false;private closed=false;
  private staleSince:number|null=null;private everRead=false;private graceUntil=0;private failedPolls=0;private version:number|null=null;
  private readonly rejectedKeys=new Set<string>();private rejected=0;private readonly rejectedReasons:Record<string,number>={};
  private readonly now:()=>number;
  constructor(private readonly reader:RegistryReader,private readonly options:RegistrySourceOptions) {
    this.now=options.now??Date.now;
    this.merged=this.merge();
    this.stopSeed=options.seed?.onChange(()=>this.publish());
  }
  snapshot():UpstreamRecord[] {return this.merged;}
  onChange(listener:()=>void):()=>void {return this.listeners.add(listener);}
  async start():Promise<void> {
    await this.options.seed?.start?.();
    await this.poll();
    if(this.closed) return;
    this.timer=setInterval(()=>void this.poll(),this.options.pollMs??REGISTRY_HEARTBEAT_MS);this.timer.unref();
    await this.subscribe();
  }
  /** One subscription at a time (a slow subscribe must not race the retry after the next poll). */
  private subscribe():Promise<void> {
    if(this.unsubscribe||this.closed) return Promise.resolve();
    this.subscribing??=(async()=>{
      try {this.unsubscribe=await this.reader.subscribe(()=>void this.poll());} catch {/* retried after the next successful poll */}
      finally {this.subscribing=undefined;}
      if(this.closed) {await this.unsubscribe?.();this.unsubscribe=undefined;}
    })();
    return this.subscribing;
  }
  /** One poll; overlapping requests (timer + nudges) collapse into one follow-up poll. */
  poll():Promise<void> {
    if(this.polling) {this.again=true;return this.polling;}
    this.polling=(async()=>{
      try {
        do {this.again=false;await this.pollOnce();} while(this.again&&!this.closed);
      } finally {this.polling=undefined;}
    })();
    return this.polling;
  }
  private async pollOnce():Promise<void> {
    let listed:{records:Record<string,string>[];version:number};
    try {listed=await this.reader.list(this.options.pool);}
    catch {
      this.failedPolls++;
      if(this.staleSince===null) this.staleSince=this.now();
      return; // frozen: keep the last membership
    }
    const now=this.now();
    if(this.staleSince!==null&&this.everRead) this.graceUntil=now+(this.options.graceMs??REGISTRY_TTL_MS);
    this.staleSince=null;this.everRead=true;this.version=listed.version;
    const next=new Map<string,UpstreamRecord>(), urls=new Set<string>();
    // By id, so which of two records sharing a baseUrl wins does not depend on Redis ordering.
    for(const hash of [...listed.records].sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0)) {
      const key=`${hash.id}\u0000${hash.epoch}\u0000${hash.baseUrl}`;
      let record:UpstreamRecord|undefined, reason:string|null;
      try {
        record=parseUpstreamRecord(hash);
        reason=record.pool!==this.options.pool||!POOL_NAME.test(record.pool)?'pool_mismatch':checkUpstreamUrl(record.baseUrl,this.options.allow);
        // One engine under two ids would get twice its maxSeqs.
        if(!reason&&urls.has(new URL(record.baseUrl).href.replace(/\/$/,''))) reason='duplicate_url';
      } catch {reason='invalid_record';}
      if(reason||!record) {
        if(!this.rejectedKeys.has(key)) {if(this.rejectedKeys.size>=10000) this.rejectedKeys.clear();this.rejectedKeys.add(key);this.rejected++;this.rejectedReasons[reason!]=(this.rejectedReasons[reason!]??0)+1;}
        continue;
      }
      next.set(record.id,record);urls.add(new URL(record.baseUrl).href.replace(/\/$/,''));
    }
    if(now<this.graceUntil) for(const record of this.registry) if(!next.has(record.id)) next.set(record.id,record);
    this.registry=byId([...next.values()]);
    this.publish();
    if(!this.unsubscribe&&this.timer) void this.subscribe();
  }
  private merge():UpstreamRecord[] {
    if(this.everRead) return this.registry;
    const ids=new Set(this.registry.map(record=>record.id));
    return byId([...(this.options.seed?.snapshot()??[]).filter(record=>!ids.has(record.id)),...this.registry]);
  }
  private publish():void {
    const next=this.merge();
    if(sameRecords(next,this.merged)) return;
    this.merged=next;this.listeners.emit();
  }
  async close():Promise<void> {
    this.closed=true;clearInterval(this.timer);this.timer=undefined;this.stopSeed?.();
    await this.options.seed?.close?.();
    await this.polling?.catch(()=>undefined);
    await this.unsubscribe?.();this.unsubscribe=undefined;
  }
  metrics():SourceMetrics {
    const now=this.now();
    return {...baseMetrics('redis'),stale:this.staleSince!==null,staleForMs:this.staleSince===null?null:now-this.staleSince,failedPolls:this.failedPolls,
      rejected:this.rejected,rejectedReasons:{...this.rejectedReasons},graceRemainingMs:Math.max(0,this.graceUntil-now),version:this.version};
  }
}
