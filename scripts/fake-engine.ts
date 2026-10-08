/**
 * FakeEngineUpstream (routing ): an OpenAI-compatible streaming engine for zero-cost routing comparisons.
 *
 * - `slots` sequences run at once; more wait inside the engine (vLLM `num_requests_waiting`).
 * - KV: a running request holds (uncached prompt + output) tokens; one that would exceed `kvCapacityTokens` waits.
 * - Prefill: one lane at `prefillTokensPerSec` (chunked prefill shares compute), so concurrent long prompts queue.
 * - Prefix cache: an LRU of message-boundary chain hashes H_k = sha256(H_{k−1} ‖ role ‖ content_k) with cumulative
 *   tokens; a hit skips that many prompt tokens. The engine counts tokens as bytes / `bytesPerToken` (4.45, the measured
 *   median; the gateway estimates with 3.9, so it over-reserves like in production).
 * - Decode: `tpotMs` per token at batch 1, × (1 + `tpotSlope` × (running − 1)).
 * - Output length: `ptr_fake_output_tokens` in the body (else 150), capped by `max_tokens`.
 * - `/health` 200; `/metrics` with the vLLM v1 names the gateway reads (vllm:num_requests_running / _waiting,
 *   vllm:kv_cache_usage_perc, vllm:prefix_cache_queries_total / _hits_total, vllm:cache_config_info{num_gpu_blocks,
 *   block_size}) and process_start_time_seconds. Checked against vLLM's docs/source upstream, not against the deployed
 *   build (). The prefix counters count requests here; vLLM counts tokens.
 * - Telemetry controls for acceptance runs: `report()` forces the reported KV usage / waiting, `hangMetrics()` leaves
 *   /metrics unanswered (stale telemetry), `restart()` restarts on the same port with a new start time and empty state.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface FakeEngineConfig {
  name:string; slots:number; prefillTokensPerSec:number; tpotMs:number; tpotSlope?:number;
  kvCapacityTokens:number; prefixCacheEntries?:number; bytesPerToken?:number;
}
interface Job { promptTokens:number; cachedTokens:number; outputTokens:number; hashes:{hash:string;tokens:number}[]; res:ServerResponse; state:'waiting'|'prefill'|'decode'|'done' }

export class FakeEngine {
  private server:Server|undefined;private readonly sockets=new Set<Socket>();
  private readonly running=new Set<Job>();private waiting:Job[]=[];
  private readonly prefix=new Map<string,number>();
  private prefillBusyUntil=0;private kvUsed=0;private startTime=0;
  private forced:{kvUsage?:number;waiting?:number}={};private metricsHang=false;
  readonly stats={requests:0,completed:0,prefixQueries:0,prefixHits:0,cancelled:0};
  port=0;
  constructor(readonly config:FakeEngineConfig) {}
  get baseUrl():string {return `http://127.0.0.1:${this.port}/v1`;}
  async start(port=0):Promise<void> {
    this.startTime=Date.now()/1000;
    const server=createServer((req,res)=>this.handle(req,res));
    server.on('connection',socket=>{this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve());});
    this.server=server;this.port=(server.address() as {port:number}).port;
  }
  async stop():Promise<void> {
    for(const socket of this.sockets) socket.destroy();
    await new Promise(resolve=>this.server?.close(resolve)??resolve(undefined));
  }
  /** Requests queued inside the engine (the real value, whatever `report()` forces). */
  get waitingCount():number {return this.waiting.length;}
  /** Force the reported KV usage and/or waiting count (`{}` = report the real values again). */
  report(values:{kvUsage?:number;waiting?:number}):void {this.forced={...values};}
  /** Leave /metrics requests unanswered (the gateway's telemetry goes stale). */
  hangMetrics(hang:boolean):void {this.metricsHang=hang;}
  /** Engine process restart: every running or waiting request is cut, caches are empty, the start time is new. */
  async restart():Promise<void> {
    for(const job of [...this.running,...this.waiting]) job.state='done';
    this.running.clear();this.waiting=[];this.prefix.clear();this.kvUsed=0;this.prefillBusyUntil=0;
    const port=this.port;await this.stop();await this.start(port);
  }
  metricsText():string {
    const usage=this.forced.kvUsage??this.kvUsed/this.config.kvCapacityTokens, waiting=this.forced.waiting??this.waiting.length;
    return [`vllm:num_requests_running{model_name="fake"} ${this.running.size}`,`vllm:num_requests_waiting{model_name="fake"} ${waiting}`,
      `vllm:kv_cache_usage_perc{model_name="fake"} ${usage}`,`vllm:prefix_cache_queries_total{model_name="fake"} ${this.stats.prefixQueries}`,
      `vllm:prefix_cache_hits_total{model_name="fake"} ${this.stats.prefixHits}`,
      `vllm:cache_config_info{block_size="16",enable_prefix_caching="True",num_gpu_blocks="${Math.floor(this.config.kvCapacityTokens/16)}"} 1.0`,
      `process_start_time_seconds ${this.startTime}`].join('\n')+'\n';
  }
  private tokens(text:string):number {return Buffer.byteLength(text,'utf8')/(this.config.bytesPerToken??4.45);}
  private handle(req:IncomingMessage,res:ServerResponse):void {
    if(req.url==='/health') {res.writeHead(200);res.end();return;}
    if(req.url==='/metrics') {if(this.metricsHang) return;res.writeHead(200,{'Content-Type':'text/plain'});res.end(this.metricsText());return;}
    let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
      let body:{messages?:{role:string;content:string}[];max_tokens?:number;ptr_fake_output_tokens?:number};
      try {body=JSON.parse(raw);} catch {res.writeHead(400);res.end();return;}
      const messages=body.messages??[];
      // Chain hashes over all but the last message, with cumulative tokens (what a prefix cache can reuse).
      const hashes:{hash:string;tokens:number}[]=[];let previous='',cumulative=0;
      for(const message of messages.slice(0,-1)) {
        previous=createHash('sha256').update(`${previous}\u0000${message.role}\u0000${message.content}`).digest('hex');
        cumulative+=this.tokens(message.content);hashes.push({hash:previous,tokens:cumulative});
      }
      const promptTokens=messages.reduce((sum,message)=>sum+this.tokens(message.content),0);
      this.stats.requests++;this.stats.prefixQueries++;
      let cachedTokens=0;
      for(const entry of [...hashes].reverse()) if(this.prefix.has(entry.hash)) {cachedTokens=entry.tokens;this.touch(entry.hash);break;}
      if(cachedTokens>0) this.stats.prefixHits++;
      const outputTokens=Math.max(1,Math.min(body.max_tokens??512,body.ptr_fake_output_tokens??150));
      const job:Job={promptTokens,cachedTokens,outputTokens,hashes,res,state:'waiting'};
      res.on('close',()=>{if(job.state!=='done') this.finish(job,true);});
      this.waiting.push(job);this.admit();
    });
  }
  private kvNeed(job:Job):number {return job.promptTokens-job.cachedTokens+job.outputTokens;}
  private admit():void {
    while(this.waiting.length&&this.running.size<this.config.slots) {
      const job=this.waiting[0]!;
      // A request larger than the whole cache still runs alone (vLLM would chunk/preempt; here it just runs).
      if(this.running.size&&this.kvUsed+this.kvNeed(job)>this.config.kvCapacityTokens) break;
      this.waiting.shift();this.running.add(job);this.kvUsed+=this.kvNeed(job);this.run(job);
    }
  }
  private run(job:Job):void {
    job.state='prefill';
    const now=Date.now(), prefillMs=(job.promptTokens-job.cachedTokens)/this.config.prefillTokensPerSec*1000;
    const start=Math.max(now,this.prefillBusyUntil);this.prefillBusyUntil=start+prefillMs;
    setTimeout(()=>{
      if(job.state==='done') return;
      for(const entry of job.hashes) this.touch(entry.hash);
      job.state='decode';
      job.res.writeHead(200,{'Content-Type':'text/event-stream'});
      let sent=0;
      const step=()=>{
        if(job.state==='done') return;
        const chunk=Math.min(10,job.outputTokens-sent);sent+=chunk;
        job.res.write(`data: ${JSON.stringify({choices:[{delta:{content:'토큰 '.repeat(chunk)}}]})}\n\n`);
        if(sent>=job.outputTokens) {
          job.res.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:Math.round(job.promptTokens),completion_tokens:job.outputTokens}})}\n\ndata: [DONE]\n\n`);
          this.finish(job,false);return;
        }
        const tpot=this.config.tpotMs*(1+(this.config.tpotSlope??0.05)*(this.running.size-1));
        setTimeout(step,tpot*chunk);
      };
      step();
    },start+prefillMs-now);
  }
  private touch(hash:string):void {
    this.prefix.delete(hash);this.prefix.set(hash,1);
    while(this.prefix.size>(this.config.prefixCacheEntries??2000)) this.prefix.delete(this.prefix.keys().next().value!);
  }
  private finish(job:Job,cancelled:boolean):void {
    const wasRunning=this.running.delete(job);
    if(wasRunning) this.kvUsed-=this.kvNeed(job);else this.waiting=this.waiting.filter(other=>other!==job);
    job.state='done';
    if(cancelled) this.stats.cancelled++;else this.stats.completed++;
    this.admit();
  }
}
