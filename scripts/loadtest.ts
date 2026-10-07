/**
 * Goal2 load / failure harness for the scaled topology: API ×N, turn worker ×M, dispatcher ×D, LLM gateway,
 * Redis (BullMQ queue + pub/sub) and Postgres. Synthetic data on the isolated ptr_loadtest database and a fake
 * (optionally latency-injected) model unless a self-hosted engine is chosen: it measures the serving
 * architecture, never real LLM throughput. Clients follow turns over SSE (or poll, for comparison).
 *
 *   pnpm exec tsx scripts/loadtest.ts seed
 *   pnpm exec tsx scripts/loadtest.ts ramp --levels=64,256,1024 --stage-seconds=45 --apis=2 --workers=4
 *   pnpm exec tsx scripts/loadtest.ts crash --target=workers|api|redis|gateway --users=32
 *   pnpm exec tsx scripts/loadtest.ts same-session --trials=30
 *
 * Requires PTR_LOADTEST_DATABASE_URL (guarded: ptr_loadtest/ptr_loadtester only) and PTR_REDIS_URL. The run uses
 * its own BullMQ queue and event namespace and wipes that queue when it ends.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { openSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { assertLocalDatabaseUrl, createLocalPool, PostgresPersonaRepository, PostgresSourceRepository } from '@ptr/storage';
import { FakeEmbeddingProvider } from '@ptr/providers';
import { BullMqTurnDelivery, assertLocalRedisUrl } from '@ptr/messaging';
import { LOADTEST_QUESTIONS, sseParser, summarizeStage, syntheticCorpus, type TurnSample } from './loadtest-lib';

const ACTIVE=['pending','retrieving','generating','validating'];
const TERMINAL=['completed','failed','cancelled'];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// Goal1 live Gemini 3 turns (77 fresh): p50 2061ms / p95 3838ms end to end; model share approximated below.
const DEFAULT_LATENCY='{"medianMs":1900,"p95Ms":3600,"seed":7}';
const QUEUE='loadtest-turns', NAMESPACE='loadtest';

function loadtestUrl():string {
  const url=process.env.PTR_LOADTEST_DATABASE_URL??'';
  assertLocalDatabaseUrl(url);
  if(new URL(url).pathname!=='/ptr_loadtest') throw new Error('Load tests run only against ptr_loadtest');
  return url;
}
const redisUrl=()=>assertLocalRedisUrl(process.env.PTR_REDIS_URL??'');
function args():Record<string,string> {
  return Object.fromEntries(process.argv.slice(3).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')];}));
}

async function seed(directory:string):Promise<{personas:number;posts:number;file:string}> {
  const pool=createLocalPool(loadtestUrl());
  try {
    const {personas,posts}=syntheticCorpus(8,60);
    const personaRepo=new PostgresPersonaRepository(pool), sources=new PostgresSourceRepository(pool), embed=new FakeEmbeddingProvider();
    for(const persona of personas) await personaRepo.importPersona(persona);
    await sources.importPosts(posts,'synthetic_fixture');
    for(let i=0;i<posts.length;i+=32) {
      const batch=posts.slice(i,i+32);
      const vectors=await embed.embed(batch.map(post=>post.caption),{signal:new AbortController().signal});
      for(const [index,post] of batch.entries()) await sources.importVector(post.id,embed.model,vectors[index]!);
    }
    const file=join(directory,'personas.json');
    await writeFile(file,JSON.stringify(personas),{mode:0o600});
    return {personas:personas.length,posts:posts.length,file};
  } finally {await pool.end();}
}

export interface Topology {
  apis:number; workers:number; workerConcurrency:number; dispatchers:number;
  /** Workers reach the model through the gateway (default) or call the fake model in-process (comparison). */
  gateway:boolean; gatewayMaxConcurrency:number; gatewayMaxQueue:number;
  queueMax:number; poolMax:number; leaseMs:number;
  provider:'fake'|'selfhosted'; selfhostedBaseUrl?:string; selfhostedModel?:string; structured?:boolean;
  client:'sse'|'poll';
}
type Role='api'|'worker'|'dispatcher'|'gateway';
interface Proc {role:Role;child:ChildProcess;port?:number}
interface ApiJson {session?:{id:string};turn?:{id:string;state:string;errorCode?:string|null};error?:{code?:string}}

/** Spawns and supervises every process of the topology with an explicit environment (no inherited credentials). */
class Fleet {
  private procs:Proc[]=[];
  readonly apiToken=randomBytes(24).toString('hex');
  readonly gatewayToken=randomBytes(24).toString('hex');
  readonly gatewayPort:number;
  constructor(private readonly basePort:number,private readonly personasFile:string,private readonly latency:string|null,
    private readonly directory:string,readonly topology:Topology) {this.gatewayPort=basePort+50;}
  private env(extra:NodeJS.ProcessEnv={}):NodeJS.ProcessEnv {
    const t=this.topology;
    const model:NodeJS.ProcessEnv=t.gateway
      ?{PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_URL:`http://127.0.0.1:${this.gatewayPort}/v1`,PTR_GATEWAY_TOKEN:this.gatewayToken,PTR_GATEWAY_STRUCTURED:t.structured?'1':'0'}
      :t.provider==='selfhosted'
        ?{PTR_CHAT_PROVIDER:'selfhosted',PTR_SELFHOSTED_BASE_URL:t.selfhostedBaseUrl,PTR_SELFHOSTED_MODEL:t.selfhostedModel,PTR_SELFHOSTED_STRUCTURED:t.structured?'1':'0'}
        :{PTR_CHAT_PROVIDER:'fake',...(this.latency?{PTR_FAKE_LATENCY:this.latency}:{})};
    return {PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',DATABASE_URL:loadtestUrl(),PTR_REDIS_URL:redisUrl(),
      PTR_TURN_QUEUE:QUEUE,PTR_EVENTS_NAMESPACE:NAMESPACE,PTR_API_TOKEN:this.apiToken,PTR_PERSONAS_FILE:this.personasFile,
      PTR_QUEUE_MAX_DEPTH:String(t.queueMax),PTR_DB_POOL_MAX:String(t.poolMax),PTR_WORKER_CONCURRENCY:String(t.workerConcurrency),
      PTR_LEASE_MS:String(t.leaseMs),PTR_DISPATCH_GRACE_MS:'2000',PTR_DISPATCH_INTERVAL_MS:'500',...model,...extra};
  }
  private launch(role:Role,script:string,extra:NodeJS.ProcessEnv,port?:number):Proc {
    const out=openSync(join(this.directory,`${role}.log`),'a');
    // node with tsx as an import hook so the sampled PID is the process itself, not a wrapper.
    const proc={role,child:spawn(process.execPath,['--import','tsx',script],{env:this.env(extra),stdio:['ignore',out,out]}),...(port?{port}:{})};
    this.procs.push(proc);return proc;
  }
  live(role:Role):Proc[] {return this.procs.filter(p=>p.role===role&&p.child.exitCode===null&&p.child.signalCode===null);}
  pids(role:Role):number[] {return this.live(role).flatMap(p=>p.child.pid?[p.child.pid]:[]);}
  apiBases():string[] {return this.live('api').map(p=>`http://127.0.0.1:${p.port}/api`);}
  async startGateway():Promise<void> {
    const t=this.topology;if(!t.gateway||this.live('gateway').length) return;
    this.launch('gateway','apps/gateway/src/main.ts',{PTR_GATEWAY_PORT:String(this.gatewayPort),PTR_GATEWAY_TOKEN:this.gatewayToken,
      PTR_GATEWAY_UPSTREAM:t.provider,PTR_GATEWAY_MAX_CONCURRENCY:String(t.gatewayMaxConcurrency),PTR_GATEWAY_MAX_QUEUE:String(t.gatewayMaxQueue),
      // The gateway, not the workers, owns the model and its latency profile.
      ...(t.provider==='selfhosted'?{PTR_SELFHOSTED_BASE_URL:t.selfhostedBaseUrl,PTR_SELFHOSTED_MODEL:t.selfhostedModel}:this.latency?{PTR_FAKE_LATENCY:this.latency}:{})});
    await this.waitHealthy(`http://127.0.0.1:${this.gatewayPort}/healthz`);
  }
  async startApis():Promise<void> {
    for(let i=0;i<this.topology.apis;i++) {
      const port=this.basePort+i;if(this.live('api').some(p=>p.port===port)) continue;
      this.launch('api','apps/api/src/main.ts',{PTR_API_PORT:String(port)},port);
      await this.waitHealthy(`http://127.0.0.1:${port}/api/health`);
    }
  }
  startWorkers():void {for(let i=this.live('worker').length;i<this.topology.workers;i++) this.launch('worker','apps/api/src/worker.ts',{PTR_WORKER_ID:`lt-worker-${randomUUID().slice(0,6)}`});}
  startDispatchers():void {for(let i=this.live('dispatcher').length;i<this.topology.dispatchers;i++) this.launch('dispatcher','apps/api/src/dispatcher.ts',{});}
  async startAll():Promise<void> {await this.startGateway();await this.startApis();this.startWorkers();this.startDispatchers();await sleep(1500);}
  kill(role:Role,signal:NodeJS.Signals,count=Infinity):Promise<void> {
    const targets=this.live(role).slice(0,count);
    return Promise.all(targets.map(p=>new Promise<void>(resolve=>{p.child.once('exit',()=>resolve());p.child.kill(signal);}))).then(()=>undefined);
  }
  async stopAll():Promise<void> {
    // Graceful order: stop intake, let workers drain, then recovery and the model gateway.
    for(const role of ['api','worker','dispatcher','gateway'] as const) await this.kill(role,'SIGTERM');
  }
  private async waitHealthy(url:string):Promise<void> {
    for(let i=0;i<200;i++) {try {if((await fetch(url)).ok) return;} catch {/* starting */}await sleep(100);}
    throw new Error(`process did not become healthy: ${url.replace(/\/\/[^/]+/,'//…')}`);
  }
  async call(base:string,path:string,owner:string,body?:unknown):Promise<{status:number;json:ApiJson;retryAfterMs:number|null}> {
    const response=await fetch(`${base}/${path}`,{method:body===undefined?'GET':'POST',
      headers:{Authorization:`Bearer ${this.apiToken}`,'X-PTR-Owner':owner,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const retryAfter=Number(response.headers.get('retry-after'));
    return {status:response.status,json:await response.json().catch(()=>({})) as ApiJson,retryAfterMs:Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:null};
  }
  async gatewayMetrics():Promise<unknown> {
    if(!this.topology.gateway) return null;
    try {return await (await fetch(`http://127.0.0.1:${this.gatewayPort}/metrics`,{headers:{Authorization:`Bearer ${this.gatewayToken}`}})).json();} catch {return null;}
  }
}

/** Per-second CPU/RSS of every process role, plus database connections. */
function startResourceSampler(fleet:Fleet) {
  const pool=createLocalPool(loadtestUrl());
  type Row={t:number;dbConnections:number|null}&Partial<Record<`${Role}CpuPct`|`${Role}RssMb`,number>>;
  const rows:Row[]=[];const last=new Map<number,{t:number;ticks:number}>();let stopped=false;
  const procStat=async(pid:number)=>{
    const stat=(await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1]!.split(' ');
    const rss=Number((await readFile(`/proc/${pid}/status`,'utf8')).match(/VmRSS:\s+(\d+)/)?.[1]??0)/1024;
    return {ticks:Number(stat[11])+Number(stat[12]),rss};
  };
  const tick=async()=>{
    while(!stopped) {
      const t=Date.now();const row:Row={t,dbConnections:null};
      for(const role of ['api','worker','dispatcher','gateway'] as const) for(const pid of fleet.pids(role)) {
        try {
          const {ticks,rss}=await procStat(pid);const prev=last.get(pid);
          if(prev) row[`${role}CpuPct`]=(row[`${role}CpuPct`]??0)+Math.round((ticks-prev.ticks)/((t-prev.t)/1000)); // 100 ticks/s per core
          row[`${role}RssMb`]=Math.round((row[`${role}RssMb`]??0)+rss);last.set(pid,{t,ticks});
        } catch {last.delete(pid);}
      }
      try {row.dbConnections=Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname='ptr_loadtest'")).rows[0].n);} catch {/* db busy */}
      rows.push(row);await sleep(1000);
    }
  };
  const running=tick();
  return {rows,stop:async()=>{stopped=true;await running;await pool.end();}};
}
/** Database work per stage: transactions, WAL bytes, and churn on the turns table (dead tuples, HOT updates). */
async function dbSnapshot() {
  const pool=createLocalPool(loadtestUrl());
  try {
    const db=(await pool.query("SELECT xact_commit+xact_rollback AS xacts FROM pg_stat_database WHERE datname='ptr_loadtest'")).rows[0];
    const turns=(await pool.query("SELECT n_tup_upd AS upd, n_tup_hot_upd AS hot, n_dead_tup AS dead FROM pg_stat_user_tables WHERE relname='turns'")).rows[0];
    let walLsn:string|null=null;try {walLsn=(await pool.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows[0].lsn;} catch {/* not permitted */}
    return {at:Date.now(),xacts:Number(db?.xacts??0),turnUpdates:Number(turns?.upd??0),turnHotUpdates:Number(turns?.hot??0),turnDeadTuples:Number(turns?.dead??0),walLsn};
  } finally {await pool.end();}
}
async function walBytes(from:string|null,to:string|null):Promise<number|null> {
  if(!from||!to) return null;const pool=createLocalPool(loadtestUrl());
  try {return Number((await pool.query('SELECT pg_wal_lsn_diff($1,$2) AS d',[to,from])).rows[0].d);} catch {return null;} finally {await pool.end();}
}

interface UserOptions {fleet:Fleet;deadline:number;turnTimeoutMs:number;pollMs:number;thinkMs:number;samples:TurnSample[];personaIndex:number;
  /** 0 = one session for the whole stage; N = start a new session every N turns (realistic conversation length). */
  turnsPerSession:number}
/** Follows one turn to its end over SSE, reconnecting (to another API if needed) when a stream breaks. */
async function followSse(o:UserOptions,owner:string,turnId:string,started:number,pickBase:()=>string):Promise<{state:string;errorCode:string|null}> {
  let state='pending',errorCode:string|null=null;
  while(!TERMINAL.includes(state)&&Date.now()-started<o.turnTimeoutMs) {
    const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),Math.max(1,o.turnTimeoutMs-(Date.now()-started)));
    try {
      const response=await fetch(`${pickBase()}/turns/${turnId}/events`,{headers:{Authorization:`Bearer ${o.fleet.apiToken}`,'X-PTR-Owner':owner},signal:controller.signal});
      if(!response.ok||!response.body){await sleep(200);continue;}
      const feed=sseParser();const decoder=new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        for(const frame of feed(decoder.decode(chunk,{stream:true}))) {
          const data=frame.data as {state?:string;errorCode?:string};
          if(data.state) state=data.state;
          if(frame.event==='turn'&&TERMINAL.includes(state)) errorCode=data.errorCode??null;
        }
        if(TERMINAL.includes(state)) break;
      }
    } catch {await sleep(200);/* API down or stream cut: reconnect, possibly elsewhere */}
    finally {clearTimeout(timer);controller.abort();}
  }
  return {state,errorCode};
}
async function virtualUser(o:UserOptions):Promise<void> {
  const owner=`lt-${randomUUID().slice(0,8)}`;let apiIndex=o.personaIndex;
  // Sticky to one API; on a network error move to the next live one (what a load balancer would do).
  const pickBase=()=>{const bases=o.fleet.apiBases();return bases[apiIndex%Math.max(1,bases.length)]??'http://127.0.0.1:1/api';};
  const rotate=()=>{apiIndex++;};
  let session:string|undefined;
  const open=async():Promise<boolean>=>{
    for(let attempt=0;attempt<5;attempt++) {
      try {
        const created=await o.fleet.call(pickBase(),'sessions',owner,{personId:`loadtest-person-${1+o.personaIndex%8}`,retrievalMode:'lexical'});
        if(created.status>=300) {o.samples.push({outcome:'rejected',acceptMs:null,e2eMs:null,errorCode:`SESSION_HTTP_${created.status}`});return false;}
        session=created.json.session!.id;return true;
      } catch {rotate();await sleep(200);}
    }
    o.samples.push({outcome:'rejected',acceptMs:null,e2eMs:null,errorCode:'SESSION_NETWORK'});return false;
  };
  if(!await open()) return;
  let n=0;
  while(Date.now()<o.deadline) {
    if(o.turnsPerSession&&n>0&&n%o.turnsPerSession===0&&!await open()) return;
    const started=Date.now();let acceptMs:number|null=null;
    try {
      const sent=await o.fleet.call(pickBase(),`sessions/${session}/turns`,owner,{clientRequestId:randomUUID(),text:LOADTEST_QUESTIONS[(o.personaIndex+n++)%LOADTEST_QUESTIONS.length]});
      acceptMs=Date.now()-started;
      // Well-behaved client: honor Retry-After with jitter instead of hammering a saturated API.
      if(sent.status>=300) {o.samples.push({outcome:'rejected',acceptMs,e2eMs:null,errorCode:sent.json?.error?.code??`HTTP_${sent.status}`});
        await sleep(sent.retryAfterMs?sent.retryAfterMs+Math.random()*sent.retryAfterMs/2:200);continue;}
      const id=sent.json.turn!.id;let state=sent.json.turn!.state, errorCode:string|null=null;
      if(o.fleet.topology.client==='sse') ({state,errorCode}=await followSse(o,owner,id,started,pickBase));
      else while(!TERMINAL.includes(state)&&Date.now()-started<o.turnTimeoutMs) {
        await sleep(o.pollMs);
        try {const polled=await o.fleet.call(pickBase(),`turns/${id}`,owner);if(polled.status<300){state=polled.json.turn!.state;errorCode=polled.json.turn!.errorCode??null;}}
        catch {rotate();}
      }
      const e2eMs=Date.now()-started;
      o.samples.push(state==='completed'?{outcome:'completed',acceptMs,e2eMs,errorCode:null}
        :TERMINAL.includes(state)?{outcome:'failed',acceptMs,e2eMs,errorCode:errorCode??state.toUpperCase()}
        :{outcome:'stuck',acceptMs,e2eMs:null,errorCode:`STUCK_${String(state).toUpperCase()}`});
    } catch {o.samples.push({outcome:'rejected',acceptMs,e2eMs:null,errorCode:'NETWORK'});rotate();await sleep(200);}
    if(o.thinkMs) await sleep(o.thinkMs);
  }
}
let turnsPerSession=0, thinkMs=0, pollMs=100;
async function runStage(fleet:Fleet,users:number,seconds:number) {
  const samples:TurnSample[]=[];const started=Date.now();const deadline=started+seconds*1000;
  const before=await dbSnapshot();
  await Promise.all(Array.from({length:users},(_,i)=>virtualUser({fleet,deadline,turnTimeoutMs:45_000,pollMs,thinkMs,samples,personaIndex:i,turnsPerSession})));
  const after=await dbSnapshot();const summary=summarizeStage(samples,Date.now()-started);
  const completed=Math.max(1,summary.turns.completed);
  return {users,seconds,...summary,wallSeconds:(Date.now()-started)/1000,
    db:{xactsPerSecond:(after.xacts-before.xacts)/((after.at-before.at)/1000),xactsPerTurn:(after.xacts-before.xacts)/completed,
      walBytesPerTurn:await walBytes(before.walLsn,after.walLsn).then(bytes=>bytes===null?null:bytes/completed),
      turnUpdates:after.turnUpdates-before.turnUpdates,turnHotUpdates:after.turnHotUpdates-before.turnHotUpdates,turnDeadTuplesAfter:after.turnDeadTuples},
    gateway:await fleet.gatewayMetrics()};
}
async function activeTurns(since:Date):Promise<{state:string;n:number}[]> {
  const pool=createLocalPool(loadtestUrl());
  try {return (await pool.query(`SELECT state,count(*)::int AS n FROM turns WHERE state = ANY($1) AND created_at >= $2 GROUP BY state`,[ACTIVE,since])).rows;}
  finally {await pool.end();}
}
const execFileAsync=promisify(execFile);

async function main():Promise<void> {
  const mode=process.argv[2];const options=args();
  const runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${mode}`;
  const directory=join('reports','loadtest',runId);await mkdir(directory,{recursive:true,mode:0o700});
  const runStarted=new Date();
  turnsPerSession=Number(options['turns-per-session']??0);thinkMs=Number(options['think-ms']??0);pollMs=Number(options['poll-ms']??100);
  const seeded=await seed(directory);
  if(mode==='seed') {console.log(JSON.stringify(seeded));return;}
  const provider=options.provider==='selfhosted'?'selfhosted' as const:'fake' as const;
  const latency=options.latency==='none'||provider==='selfhosted'?null:options.latency??DEFAULT_LATENCY;
  const topology:Topology={apis:Number(options.apis??1),workers:Number(options.workers??2),workerConcurrency:Number(options['worker-concurrency']??128),
    dispatchers:Number(options.dispatchers??1),gateway:options.gateway!=='0',gatewayMaxConcurrency:Number(options['gateway-concurrency']??1024),
    gatewayMaxQueue:Number(options['gateway-queue']??4096),queueMax:Number(options['queue-max']??2048),poolMax:Number(options['pool-max']??8),
    leaseMs:Number(options['lease-ms']??5000),provider,selfhostedBaseUrl:options['base-url']??'http://127.0.0.1:18000/v1',selfhostedModel:options.model??'gemma-4-e4b',
    structured:options.structured==='1',client:options.client==='poll'?'poll':'sse'};
  const fleet=new Fleet(Number(options.port??56451),seeded.file,latency,directory,topology);
  const report:Record<string,unknown>={mode,runId,startedAt:new Date().toISOString(),latencyProfile:latency,topology,
    note:'Fake model with injected latency on synthetic data, one host: serving-architecture limits, not LLM throughput.'};
  await fleet.startAll();
  const sampler=startResourceSampler(fleet);
  try {
    if(mode==='ramp') {
      const levels=(options.levels??'1,4,16,64,128,256').split(',').map(Number);const seconds=Number(options['stage-seconds']??45);
      const stages=[];
      for(const users of levels) {
        const stage=await runStage(fleet,users,seconds);stages.push(stage);
        console.log(JSON.stringify({users,completedPerSecond:stage.completedPerSecond.toFixed(2),e2eMs:stage.e2eMs,acceptP95:stage.acceptMs.p95,turns:stage.turns,errors:stage.errors,xactsPerTurn:stage.db.xactsPerTurn.toFixed(1)}));
        await sleep(3000);
      }
      report.stages=stages;
    } else if(mode==='crash') {
      // Kill one part mid-flight, bring it back, and check what happens to in-flight turns.
      const target=(options.target??'workers') as 'workers'|'api'|'redis'|'gateway';const users=Number(options.users??32);
      const stage=runStage(fleet,users,30);
      await sleep(10_000);
      const before=await activeTurns(runStarted);
      if(target==='workers') await fleet.kill('worker','SIGKILL');
      else if(target==='api') await fleet.kill('api','SIGKILL',1); // one of N: clients move to the others
      else if(target==='gateway') await fleet.kill('gateway','SIGKILL');
      else await execFileAsync('docker',['restart','-t','0','ptr_goal2_redis']); // AOF keeps queued jobs; pub/sub notices in flight are lost
      await sleep(2000);
      if(target==='workers') fleet.startWorkers(); else if(target==='api') await fleet.startApis(); else if(target==='gateway') await fleet.startGateway();
      const result=await stage;
      await sleep(Math.max(20_000,topology.leaseMs*3)); // past turn timeout + lease + dispatcher: anything still active now is orphaned
      report.crash={target,users,activeAtKill:before,downtimeMs:2000,stage:result,orphanedActiveTurns:await activeTurns(runStarted)};
      console.log(JSON.stringify(report.crash));
    } else if(mode==='same-session') {
      const owner=`lt-${randomUUID().slice(0,8)}`;const trials=Number(options.trials??30);const outcomes:Record<string,number>={};
      const [a,b]=[fleet.apiBases()[0]!,fleet.apiBases().at(-1)!]; // with two APIs, the pair races across processes
      for(let i=0;i<trials;i++) {
        const session=(await fleet.call(a,'sessions',owner,{personId:'loadtest-person-1',retrievalMode:'lexical'})).json.session!.id;
        const pair=await Promise.all([a,b].map(base=>fleet.call(base,`sessions/${session}/turns`,owner,{clientRequestId:randomUUID(),text:'동시에 보낸 합성 질문'})));
        const key=pair.map(result=>result.status).sort().join('+');outcomes[key]=(outcomes[key]??0)+1;
      }
      report.sameSession={trials,statusPairs:outcomes};console.log(JSON.stringify(report.sameSession));
    } else throw new Error(`unknown mode ${mode}`);
  } finally {
    await sampler.stop();await fleet.stopAll();
    const queue=new BullMqTurnDelivery(redisUrl(),{queueName:QUEUE});await queue.close(true).catch(()=>undefined);
    report.resources=sampler.rows;report.finishedAt=new Date().toISOString();
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,1),{mode:0o600});
    console.log(`report: ${join(directory,'report.json')}`);
  }
}
void main().catch(error=>{console.error('loadtest failed:',error instanceof Error?error.message:'unknown');process.exitCode=1;});
