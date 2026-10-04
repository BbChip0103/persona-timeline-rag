/**
 * Goal2 load / failure harness. Synthetic data on the isolated ptr_loadtest database, fake (optionally
 * latency-injected) model only: it measures the serving architecture, never real LLM throughput.
 *
 *   pnpm exec tsx scripts/loadtest.ts seed
 *   pnpm exec tsx scripts/loadtest.ts ramp --levels=1,4,16,64 --stage-seconds=45
 *   pnpm exec tsx scripts/loadtest.ts crash | faults | same-session
 *
 * Requires PTR_LOADTEST_DATABASE_URL (guarded: ptr_loadtest/ptr_loadtester only).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertLocalDatabaseUrl, createLocalPool, PostgresPersonaRepository, PostgresSourceRepository } from '@ptr/storage';
import { FakeEmbeddingProvider } from '@ptr/providers';
import { LOADTEST_QUESTIONS, summarizeStage, syntheticCorpus, type TurnSample } from './loadtest-lib';

const ACTIVE=['pending','retrieving','generating','validating'];
const TERMINAL=['completed','failed','cancelled'];
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
// Goal1 live Gemini 3 turns (77 fresh): p50 2061ms / p95 3838ms end to end; model share approximated below.
const DEFAULT_LATENCY='{"medianMs":1900,"p95Ms":3600,"seed":7}';

function loadtestUrl():string {
  const url=process.env.PTR_LOADTEST_DATABASE_URL??'';
  assertLocalDatabaseUrl(url);
  if(new URL(url).pathname!=='/ptr_loadtest') throw new Error('Load tests run only against ptr_loadtest');
  return url;
}
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

interface ApiJson {session?:{id:string};turn?:{id:string;state:string;errorCode?:string|null};error?:{code?:string}}
class Api {
  private child?:ChildProcess;
  readonly token=randomBytes(24).toString('hex');
  constructor(readonly port:number,private readonly personasFile:string,private readonly latency:string|null,private readonly log:string) {}
  get base() {return `http://127.0.0.1:${this.port}/api`;}
  get pid() {return this.child?.pid;}
  async start():Promise<void> {
    // Explicit env: never inherit research/live credentials (runtime prefers GOAL1_DATABASE_URL).
    const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',DATABASE_URL:loadtestUrl(),
      PTR_API_TOKEN:this.token,PTR_API_PORT:String(this.port),PTR_PERSONAS_FILE:this.personasFile,PTR_CHAT_PROVIDER:'fake',
      ...(this.latency?{PTR_FAKE_LATENCY:this.latency}:{})};
    const {openSync}=await import('node:fs');const out=openSync(this.log,'a');
    this.child=spawn(join('node_modules','.bin','tsx'),['apps/api/src/main.ts'],{env,stdio:['ignore',out,out]});
    for(let i=0;i<200;i++) {
      try {if((await fetch(`${this.base}/health`)).ok) return;} catch {/* starting */}
      await sleep(100);
    }
    throw new Error('API did not become healthy');
  }
  kill(signal:NodeJS.Signals='SIGTERM'):Promise<void> {
    const child=this.child;if(!child||child.exitCode!==null) return Promise.resolve();
    return new Promise(resolve=>{child.once('exit',()=>resolve());child.kill(signal);});
  }
  async call(path:string,owner:string,body?:unknown):Promise<{status:number;json:ApiJson}> {
    const response=await fetch(`${this.base}/${path}`,{method:body===undefined?'GET':'POST',
      headers:{Authorization:`Bearer ${this.token}`,'X-PTR-Owner':owner,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,json:await response.json().catch(()=>({})) as ApiJson};
  }
}

/** /proc sampling of the API process plus database connection count, once per second. */
function startResourceSampler(api:Api) {
  const pool=createLocalPool(loadtestUrl());
  const rows:{t:number;cpuPct:number|null;rssMb:number|null;dbConnections:number|null}[]=[];
  let last:{t:number;ticks:number}|undefined;let stopped=false;
  const tick=async()=>{
    while(!stopped) {
      const t=Date.now();let cpuPct:number|null=null, rssMb:number|null=null, dbConnections:number|null=null;
      try {
        const pid=api.pid;
        if(pid) {
          const stat=(await readFile(`/proc/${pid}/stat`,'utf8')).split(') ')[1]!.split(' ');
          const ticks=Number(stat[11])+Number(stat[12]);
          if(last) cpuPct=Math.round((ticks-last.ticks)/((t-last.t)/1000)); // 100 ticks/s per core
          last={t,ticks};
          rssMb=Math.round(Number((await readFile(`/proc/${pid}/status`,'utf8')).match(/VmRSS:\s+(\d+)/)?.[1]??0)/1024);
        }
      } catch {last=undefined;}
      try {dbConnections=Number((await pool.query("SELECT count(*) AS n FROM pg_stat_activity WHERE datname='ptr_loadtest'")).rows[0].n);} catch {/* db busy */}
      rows.push({t,cpuPct,rssMb,dbConnections});
      await sleep(1000);
    }
  };
  const running=tick();
  return {rows,stop:async()=>{stopped=true;await running;await pool.end();}};
}

interface UserOptions {api:Api;deadline:number;turnTimeoutMs:number;pollMs:number;thinkMs:number;samples:TurnSample[];personaIndex:number}
async function virtualUser(o:UserOptions):Promise<void> {
  const owner=`lt-${randomUUID().slice(0,8)}`;
  let session:string|undefined;
  try {
    const created=await o.api.call('sessions',owner,{personId:`loadtest-person-${1+o.personaIndex%8}`,retrievalMode:'lexical'});
    if(created.status>=300) {o.samples.push({outcome:'rejected',acceptMs:null,e2eMs:null,errorCode:`SESSION_HTTP_${created.status}`});return;}
    session=created.json.session!.id;
  } catch {o.samples.push({outcome:'rejected',acceptMs:null,e2eMs:null,errorCode:'SESSION_NETWORK'});return;}
  let n=0;
  while(Date.now()<o.deadline) {
    const started=Date.now();let acceptMs:number|null=null;
    try {
      const sent=await o.api.call(`sessions/${session}/turns`,owner,{clientRequestId:randomUUID(),text:LOADTEST_QUESTIONS[(o.personaIndex+n++)%LOADTEST_QUESTIONS.length]});
      acceptMs=Date.now()-started;
      if(sent.status>=300) {o.samples.push({outcome:'rejected',acceptMs,e2eMs:null,errorCode:sent.json?.error?.code??`HTTP_${sent.status}`});await sleep(200);continue;}
      const id=sent.json.turn!.id;let state=sent.json.turn!.state, errorCode:string|null=null;
      while(!TERMINAL.includes(state) && Date.now()-started<o.turnTimeoutMs) {
        await sleep(o.pollMs);
        try {const polled=await o.api.call(`turns/${id}`,owner);if(polled.status<300){state=polled.json.turn!.state;errorCode=polled.json.turn!.errorCode??null;}}
        catch {/* API down: keep polling until the turn deadline */}
      }
      const e2eMs=Date.now()-started;
      o.samples.push(state==='completed'?{outcome:'completed',acceptMs,e2eMs,errorCode:null}
        :TERMINAL.includes(state)?{outcome:'failed',acceptMs,e2eMs,errorCode:errorCode??state.toUpperCase()}
        :{outcome:'stuck',acceptMs,e2eMs:null,errorCode:`STUCK_${String(state).toUpperCase()}`});
    } catch {o.samples.push({outcome:'rejected',acceptMs,e2eMs:null,errorCode:'NETWORK'});await sleep(200);}
    if(o.thinkMs) await sleep(o.thinkMs);
  }
}
async function runStage(api:Api,users:number,seconds:number,extra:Partial<UserOptions>={}) {
  const samples:TurnSample[]=[];const started=Date.now();const deadline=started+seconds*1000;
  await Promise.all(Array.from({length:users},(_,i)=>virtualUser({api,deadline,turnTimeoutMs:45_000,pollMs:100,thinkMs:0,samples,personaIndex:i,...extra})));
  return {users,seconds,...summarizeStage(samples,Date.now()-started),wallSeconds:(Date.now()-started)/1000};
}
async function activeTurns():Promise<{state:string;n:number}[]> {
  const pool=createLocalPool(loadtestUrl());
  try {return (await pool.query(`SELECT state,count(*)::int AS n FROM turns WHERE state = ANY($1) GROUP BY state`,[ACTIVE])).rows;}
  finally {await pool.end();}
}

async function main():Promise<void> {
  const mode=process.argv[2];const options=args();
  const runId=`${new Date().toISOString().replace(/[:.]/g,'-')}-${mode}`;
  const directory=join('reports','loadtest',runId);await mkdir(directory,{recursive:true,mode:0o700});
  const seeded=await seed(directory);
  if(mode==='seed') {console.log(JSON.stringify(seeded));return;}
  const latency=options.latency==='none'?null:options.latency??DEFAULT_LATENCY;
  const api=new Api(Number(options.port??56451),seeded.file,latency,join(directory,'api.log'));
  const report:Record<string,unknown>={mode,runId,startedAt:new Date().toISOString(),latencyProfile:latency,dbPoolMax:8,
    note:'Fake model with injected latency on synthetic data: serving-architecture limits, not LLM throughput.'};
  await api.start();
  const sampler=startResourceSampler(api);
  try {
    if(mode==='ramp') {
      const levels=(options.levels??'1,4,16,64,128,256').split(',').map(Number);const seconds=Number(options['stage-seconds']??45);
      const stages=[];
      for(const users of levels) {
        const stage=await runStage(api,users,seconds);stages.push(stage);
        console.log(JSON.stringify({users,completedPerSecond:stage.completedPerSecond.toFixed(2),e2eMs:stage.e2eMs,acceptP95:stage.acceptMs.p95,turns:stage.turns,errors:stage.errors}));
        await sleep(3000);
      }
      report.stages=stages;
    } else if(mode==='crash') {
      // Kill the API mid-flight, restart it, and see what happens to in-flight turns and their sessions.
      const users=Number(options.users??16);
      const stage=runStage(api,users,30);
      await sleep(10_000);
      const before=await activeTurns();
      await api.kill('SIGKILL');const killedAt=Date.now();
      await sleep(2000);await api.start();
      const result=await stage;
      await sleep(50_000); // longer than any turn timeout: anything still active now is orphaned
      report.crash={users,activeAtKill:before,restartAfterMs:Date.now()-killedAt,stage:result,orphanedActiveTurns:await activeTurns()};
      console.log(JSON.stringify(report.crash));
    } else if(mode==='faults') {
      report.faults=await runStage(api,Number(options.users??16),Number(options['stage-seconds']??60));
      console.log(JSON.stringify(report.faults));
    } else if(mode==='same-session') {
      const owner=`lt-${randomUUID().slice(0,8)}`;const trials=Number(options.trials??30);const outcomes:Record<string,number>={};
      for(let i=0;i<trials;i++) {
        const session=(await api.call('sessions',owner,{personId:'loadtest-person-1',retrievalMode:'lexical'})).json.session!.id;
        const pair=await Promise.all([0,1].map(()=>api.call(`sessions/${session}/turns`,owner,{clientRequestId:randomUUID(),text:'동시에 보낸 합성 질문'})));
        const key=pair.map(result=>result.status).sort().join('+');outcomes[key]=(outcomes[key]??0)+1;
      }
      report.sameSession={trials,statusPairs:outcomes};console.log(JSON.stringify(report.sameSession));
    } else throw new Error(`unknown mode ${mode}`);
  } finally {
    await sampler.stop();await api.kill();
    report.resources=sampler.rows;report.finishedAt=new Date().toISOString();
    await writeFile(join(directory,'report.json'),JSON.stringify(report,null,1),{mode:0o600});
    console.log(`report: ${join(directory,'report.json')}`);
  }
}
void main().catch(error=>{console.error('loadtest failed:',error instanceof Error?error.message:'unknown');process.exitCode=1;});
