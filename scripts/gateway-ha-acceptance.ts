/**
 * Gateway HA acceptance (routing  C/D/E and §13 T6, stage S6). Zero cost: real gateway processes
 * (`apps/gateway/src/main.ts`, pool mode, gateway registry on) in front of in-process fake engines (scripts/fake-engine.ts),
 * and closed-loop worker clients (OpenAICompatibleTextProvider with the S1 retry settings, request keys, the gateway list
 * from GatewayDirectory over the Redis gateway registry, two directories = two worker processes).
 *
 *   pnpm exec tsx scripts/gateway-ha-acceptance.ts [--scenarios=C,D,E,T6] [--users=16] [--seconds=30]
 *
 * C  two gateways, the leader SIGKILLed at 10 s, no restart                     → 0 failed
 * D  primary engines down, fake OpenRouter secondary behind the real ledger,     → no double billing; unresolved refusals counted
 *    the leader SIGKILLed at 10 s while secondary calls are in flight
 * E  SIGTERM drain of the leader at 10 s with requests queued in its pool        → 0 failed, queued requests served by the standby
 * T6 leader SIGKILLed at 10 s, a new gateway registers at 15 s                   → workers switch, lists update, Q follows, 0 failed
 *
 * Redis: the isolated PTR_REDIS_URL, namespace `ptrtest:s6<run>:llm` (deleted afterwards). D's ledger: the synthetic
 * ptr_loadtest database (PTR_LOADTEST_DATABASE_URL); the ledger tables are created there for the run and dropped
 * afterwards when the run created them (else only this run's rows are deleted). D never reaches openrouter.ai: the
 * gateways load scripts/ha-openrouter-redirect.ts (fetches to openrouter.ai go to the harness's fake, any other
 * non-loopback fetch is refused) and get a synthetic API key. Report: reports/gateway-ha-acceptance-<run>.json.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CapacityController, GatewayDirectory, MemoryCapacityStore, MemoryUpstreamRegistry, RedisGatewayRegistry, assertLocalRedisUrl, createRedisConnection,
  parseGatewayAllow, parseUpstreamAllow, type CapacityQueue } from '@ptr/messaging';
import { OpenAICompatibleTextProvider, PostgresBudgetLedger, type CallMetrics } from '@ptr/providers';
import { assertLocalDatabaseUrl, createLocalPool } from '@ptr/storage';
import { FakeEngine } from './fake-engine';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')];}));
const RUN=randomBytes(4).toString('hex');
const PREFIX=`ptrtest:s6${RUN}:llm`;
const POOL='fake-e4b';
const BASE_PORT=Number(args['base-port']??56531);
const ALLOW=`127.0.0.1:${BASE_PORT}-${BASE_PORT+8}`;
const TOKEN=randomBytes(24).toString('hex');
const USERS=Number(args.users??16), SECONDS=Number(args.seconds??30), KILL_AT=10_000;
const DIR=join('reports');

interface Gw {name:string;port:number;child:ChildProcess;lines:string[];exit:Promise<{code:number|null;signal:NodeJS.Signals|null;at:number}>}
async function waitHealthy(port:number):Promise<void> {
  for(let i=0;i<300;i++) {try {if((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return;} catch {/* starting */}await sleep(100);}
  throw new Error(`gateway on ${port} did not become healthy`);
}
/** One gateway process with an explicit environment (no inherited credentials). */
async function startGateway(name:string,port:number,env:NodeJS.ProcessEnv,preload?:string):Promise<Gw> {
  const child=spawn(process.execPath,['--import','tsx',...(preload?['--import',preload]:[]),'apps/gateway/src/main.ts'],{stdio:['ignore','pipe','pipe'],
    env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',PTR_GATEWAY_PORT:String(port),PTR_GATEWAY_TOKEN:TOKEN,PTR_GATEWAY_ID:name,
      PTR_GATEWAY_REGISTRY:'on',PTR_REDIS_URL:process.env.PTR_REDIS_URL,PTR_REGISTRY_PREFIX:PREFIX,PTR_GATEWAY_ALLOW:ALLOW,PTR_GATEWAY_ROUTE_LOG_SAMPLE:'0',
      PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_GATEWAY_POOL:POOL,...env}});
  const lines:string[]=[];
  for(const stream of [child.stdout!,child.stderr!]) stream.on('data',(chunk:Buffer)=>{for(const line of chunk.toString('utf8').split('\n')) if(line.trim()) lines.push(`${Date.now()} ${line}`);});
  const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null;at:number}>(resolve=>child.once('exit',(code,signal)=>resolve({code,signal,at:Date.now()})));
  await waitHealthy(port);
  return {name,port,child,lines,exit};
}
async function gatewayMetrics(gw:Gw):Promise<Record<string,unknown>|null> {
  try {return await (await fetch(`http://127.0.0.1:${gw.port}/metrics`,{headers:{Authorization:`Bearer ${TOKEN}`},signal:AbortSignal.timeout(1000)})).json() as Record<string,unknown>;}
  catch {return null;}
}
interface Sample {ok:boolean;code:string|null;startedAt:number;ms:number;attempts:number}
const quantile=(values:number[],p:number)=>{if(!values.length) return null;const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)]!;};
function summarize(samples:Sample[],from:number,to:number) {
  const window=samples.filter(s=>s.startedAt>=from&&s.startedAt<to);
  const codes:Record<string,number>={};for(const s of window) if(!s.ok) codes[s.code??'UNKNOWN']=(codes[s.code??'UNKNOWN']??0)+1;
  return {calls:window.length,ok:window.filter(s=>s.ok).length,failed:window.filter(s=>!s.ok).length,codes,
    e2eMs:{p50:quantile(window.filter(s=>s.ok).map(s=>s.ms),0.5),p95:quantile(window.filter(s=>s.ok).map(s=>s.ms),0.95)},
    retried:window.filter(s=>s.attempts>1).length};
}

/** HTTP requests of the last call (read through a function: the holder is reset before each call). */
const attemptsOf=(holder:{last?:CallMetrics})=>holder.last?.attempts??1;
/** Closed-loop users: each its own client (attempts per call), sharing one of two directories (two worker processes). */
function runUsers(directories:GatewayDirectory[],scenario:string,deadline:number,samples:Sample[],users=USERS):Promise<void> {
  return Promise.all(Array.from({length:users},async(_,i)=>{
    const directory=directories[i%directories.length]!;const seen:{last?:CallMetrics}={};
    const client=new OpenAICompatibleTextProvider({baseUrl:()=>directory.urls(),model:'gateway',apiKey:TOKEN,maxOutputTokens:512,timeoutMs:60000,
      resetRetries:2,retryMinRemainingMs:5000,onMetrics:metrics=>{seen.last=metrics;}});
    for(let n=0;Date.now()<deadline;n++) {
      const key=`ha-${RUN}-${scenario}-${i}-${n}`, startedAt=Date.now();seen.last=undefined;
      try {
        await client.generate([{role:'system',content:'P'.repeat(4000)},{role:'user',content:`synthetic ${key}`}],{signal:AbortSignal.timeout(35000),requestKey:key,deadlineAt:startedAt+30000});
        samples.push({ok:true,code:null,startedAt,ms:Date.now()-startedAt,attempts:attemptsOf(seen)});
      } catch(error) {
        samples.push({ok:false,code:(error as {code?:string}).code??'UNKNOWN',startedAt,ms:Date.now()-startedAt,attempts:attemptsOf(seen)});
      }
    }
  })).then(()=>undefined);
}
/** Gateway list as worker 0 sees it (names by port) and the leader, recorded on every change. */
function listSampler(directory:GatewayDirectory,names:Map<number,string>,t0:number) {
  const events:{t:number;list:string[];leader:string|null;registryActive:number;stale:boolean}[]=[];let key='';
  const timer=setInterval(()=>{
    const list=directory.urls().map(url=>names.get(Number(new URL(url).port))??`seed:${new URL(url).port}`), metrics=directory.metrics();
    const next=`${list.join(',')}|${metrics.leader}|${metrics.active}|${metrics.stale}`;
    if(next!==key) {key=next;events.push({t:Date.now()-t0,list,leader:metrics.leader,registryActive:metrics.active,stale:metrics.stale});}
  },100);
  return {events,stop:()=>clearInterval(timer)};
}
async function engines(count:number) {
  const list:FakeEngine[]=[];
  for(let i=0;i<count;i++) {
    const engine=new FakeEngine({name:`e${i}`,slots:12,prefillTokensPerSec:20000,tpotMs:8,kvCapacityTokens:400000});
    await engine.start();list.push(engine);
  }
  return list;
}
async function upstreamsFile(entries:{id:string;port:number;maxSeqs:number}[]):Promise<string> {
  const file=join(DIR,`gateway-ha-${RUN}-upstreams.json`);
  await writeFile(file,JSON.stringify({pools:{[POOL]:{upstreams:entries.map(e=>({id:e.id,baseUrl:`http://127.0.0.1:${e.port}/v1`,maxSeqs:e.maxSeqs}))}}}),{mode:0o600});
  return file;
}

async function killScenario(name:'C'|'E'|'T6',redis:ReturnType<typeof createRedisConnection>) {
  const fakes=await engines(2);
  // E: 6 credit per engine (12 per gateway) for 24 users, so the leader has requests queued in its pool when it drains.
  const users=name==='E'?Math.max(USERS,24):USERS, maxSeqs=name==='E'?6:12;
  const file=await upstreamsFile(fakes.map((engine,i)=>({id:`e${i}`,port:engine.port,maxSeqs})));
  const env={PTR_GATEWAY_UPSTREAMS_FILE:file};
  const gws:Gw[]=[];
  const directories:GatewayDirectory[]=[];
  try {
    gws.push(await startGateway('gw-1',BASE_PORT,env));
    await sleep(300); // gw-1 takes the leader hint and is the oldest
    gws.push(await startGateway('gw-2',BASE_PORT+1,env));
    const names=new Map([[BASE_PORT,'gw-1'],[BASE_PORT+1,'gw-2'],[BASE_PORT+2,'gw-3']]);
    const allow=parseGatewayAllow(ALLOW);
    // Seed = the static list a worker would carry (both gateways), as in S1.
    for(let i=0;i<2;i++) {const d=new GatewayDirectory(new RedisGatewayRegistry(redis,PREFIX),{seed:[`http://127.0.0.1:${BASE_PORT}/v1`,`http://127.0.0.1:${BASE_PORT+1}/v1`],allow,log:()=>undefined});await d.start();directories.push(d);}
    const t0=Date.now(), samples:Sample[]=[];
    const sampler=listSampler(directories[0]!,names,t0);
    // Capacity controller Q from the gateway registry (one upstream record of 12 so S_live is fixed; headroom 100 so G = S + Q shows Q).
    const upstreams=new MemoryUpstreamRegistry();await upstreams.heartbeat({pool:POOL,id:'e0',baseUrl:'http://127.0.0.1:18000/v1',maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'x',seq:0},1e9);
    let g:number|null=null;const queue:CapacityQueue={getGlobalConcurrency:async()=>g,setGlobalConcurrency:async(n)=>{g=n;},getJobCounts:async()=>({active:0,wait:0})};
    const controller=new CapacityController({registry:upstreams,gateways:new RedisGatewayRegistry(redis,PREFIX),gatewayAllow:allow,queue,store:new MemoryCapacityStore(),pool:POOL,
      allow:parseUpstreamAllow(undefined),id:'ha',q:256,headroom:100,log:()=>undefined});
    const qEvents:{t:number;q:number;source:string}[]=[];let lastQ='';
    const qTimer=setInterval(()=>void controller.tick().then(status=>{const k=`${status.q}|${status.qSource}`;if(k!==lastQ){lastQ=k;qEvents.push({t:Date.now()-t0,q:status.q,source:status.qSource});}}),1000);
    const load=runUsers(directories,name,t0+SECONDS*1000,samples,users);
    await sleep(KILL_AT);
    const before=await gatewayMetrics(gws[0]!);
    const killedAt=Date.now();
    gws[0]!.child.kill(name==='E'?'SIGTERM':'SIGKILL');
    let added:number|null=null;
    if(name==='T6') {await sleep(15_000-KILL_AT);gws.push(await startGateway('gw-3',BASE_PORT+2,env));added=Date.now()-t0;}
    await load;
    const exit=await gws[0]!.exit;
    sampler.stop();clearInterval(qTimer);
    const ok=samples.filter(s=>s.ok).length;
    const engineRequests=fakes.reduce((sum,engine)=>sum+engine.stats.requests,0), cancelled=fakes.reduce((sum,engine)=>sum+engine.stats.cancelled,0);
    const survivors=await Promise.all(gws.slice(1).map(async gw=>({name:gw.name,metrics:await gatewayMetrics(gw)})));
    const accepted=survivors.map(s=>({name:s.name,accepted:(s.metrics as {accepted?:number}|null)?.accepted??null,rejected:(s.metrics as {rejected?:unknown}|null)?.rejected??null}));
    // gw-1's record left the registry (it may stay in the list as a seed URL, last).
    // The registry part of a list is its first `registryActive` entries; seed URLs follow.
    const firstListWithout=sampler.events.find(e=>e.t>=killedAt-t0&&!e.list.slice(0,e.registryActive).includes('gw-1'));
    const leaderMoved=sampler.events.find(e=>e.t>=killedAt-t0&&e.leader&&e.leader!=='gw-1');
    const gw3Listed=added===null?null:sampler.events.find(e=>e.list.includes('gw-3'));
    return {scenario:name,users,seconds:SECONDS,killAtMs:killedAt-t0,signal:name==='E'?'SIGTERM':'SIGKILL',
      leaderBeforeKill:{inFlight:(before as {inFlight?:number}|null)?.inFlight??null,queued:(before as {queued?:number}|null)?.queued??null},
      killedExit:{code:exit.code,signal:exit.signal,afterKillMs:exit.at-killedAt},
      drainLog:gws[0]!.lines.filter(line=>/gateway drain/.test(line)).map(line=>line.replace(/^\d+ /,'')),
      total:summarize(samples,0,Infinity),beforeKill:summarize(samples,t0,killedAt),killWindow:summarize(samples,killedAt,killedAt+10_000),afterWindow:summarize(samples,killedAt+10_000,Infinity),
      engines:{requests:engineRequests,cancelled,duplicateGenerations:engineRequests-ok},survivors:accepted,
      listTimeline:sampler.events,listDropsKilledAfterMs:firstListWithout?firstListWithout.t-(killedAt-t0):null,
      leaderMovedAfterMs:leaderMoved?leaderMoved.t-(killedAt-t0):null,leaderAfter:sampler.events.at(-1)?.leader??null,
      gw3:added===null?null:{startedAtMs:added,listedAtMs:gw3Listed?.t??null},qTimeline:qEvents};
  } finally {
    for(const d of directories) await d.close();
    for(const gw of gws) if(gw.child.exitCode===null&&gw.child.signalCode===null) {gw.child.kill('SIGKILL');await gw.exit;}
    for(const engine of fakes) await engine.stop();
    await rm(join(DIR,`gateway-ha-${RUN}-upstreams.json`),{force:true});
  }
}

/** Fake OpenRouter: catalog prices within the client's ceilings, chat completions after `latencyMs`, counted per body hash. */
async function fakeOpenRouter(latencyMs:number) {
  const posts=new Map<string,number>();let total=0;
  const server:Server=createServer((req,res)=>{
    let raw='';req.on('data',chunk=>raw+=chunk);req.on('end',()=>{
      const json=(status:number,body:unknown)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));};
      if(req.method==='GET'&&req.url==='/api/v1/models') return json(200,{data:[{id:'google/gemma-4-26b-a4b-it',supported_parameters:['structured_outputs'],pricing:{prompt:'0.00000008',completion:'0.00000029'}}]});
      if(req.method==='GET'&&req.url==='/api/v1/embeddings/models') return json(200,{data:[{id:'openai/text-embedding-3-small',pricing:{prompt:'0.00000001',completion:'0'}}]});
      if(req.method==='POST'&&req.url==='/api/v1/chat/completions') {
        const hash=createHash('sha256').update(raw).digest('hex');posts.set(hash,(posts.get(hash)??0)+1);total++;
        setTimeout(()=>json(200,{id:`gen-${hash.slice(0,12)}`,model:'google/gemma-4-26b-a4b-it',choices:[{message:{role:'assistant',content:'synthetic secondary answer'}}],
          usage:{prompt_tokens:1000,completion_tokens:10,cost:0.00001}}),latencyMs);
        return;
      }
      json(404,{});
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:(server.address() as AddressInfo).port,posts,total:()=>total,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}

async function scenarioD(redis:ReturnType<typeof createRedisConnection>) {
  const databaseUrl=assertLocalDatabaseUrl(process.env.PTR_LOADTEST_DATABASE_URL??'');
  if(new URL(databaseUrl).pathname!=='/ptr_loadtest') throw new Error('scenario D runs its ledger only in ptr_loadtest');
  const db=createLocalPool(databaseUrl);
  const existed=(await db.query("SELECT to_regclass('ptr_provider_requests') IS NOT NULL AS r, to_regclass('ptr_provider_budget') IS NOT NULL AS b")).rows[0] as {r:boolean;b:boolean};
  const runStart=(await db.query('SELECT now() AS t')).rows[0].t as Date;
  await new PostgresBudgetLedger(db,databaseUrl).initialize();
  const fake=await fakeOpenRouter(1500);
  // Primary engines down: the file lists a closed loopback port, so every call fails over (breaker_open after 3 refusals).
  const closed=await new Promise<number>(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=(s.address() as AddressInfo).port;s.close(()=>resolve(p));});});
  const file=await upstreamsFile([{id:'dead',port:closed,maxSeqs:12}]);
  const env={PTR_GATEWAY_UPSTREAMS_FILE:file,PTR_GATEWAY_FAILOVER:'openrouter',PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE:'100000',GOAL1_DATABASE_URL:databaseUrl,
    GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true',OPENROUTER_API_KEY:'synthetic-no-network-key',PTR_TEST_OPENROUTER_REDIRECT:`http://127.0.0.1:${fake.port}`};
  const gws:Gw[]=[];const directories:GatewayDirectory[]=[];
  try {
    gws.push(await startGateway('gw-1',BASE_PORT,env,'./scripts/ha-openrouter-redirect.ts'));
    await sleep(300);
    gws.push(await startGateway('gw-2',BASE_PORT+1,env,'./scripts/ha-openrouter-redirect.ts'));
    const allow=parseGatewayAllow(ALLOW);
    for(let i=0;i<2;i++) {const d=new GatewayDirectory(new RedisGatewayRegistry(redis,PREFIX),{seed:[`http://127.0.0.1:${BASE_PORT}/v1`],allow,log:()=>undefined});await d.start();directories.push(d);}
    const t0=Date.now(), samples:Sample[]=[];
    const load=runUsers(directories,'D',t0+SECONDS*1000,samples);
    await sleep(KILL_AT);
    const postsBefore=fake.total();const killedAt=Date.now();
    gws[0]!.child.kill('SIGKILL');
    await load;await gws[0]!.exit;
    await sleep(2000); // the fake answers the dead gateway's last calls (they are billed once, never settled)
    const standby=await gatewayMetrics(gws[1]!);
    const ledger=(await db.query('SELECT state, count(*)::int AS n FROM ptr_provider_requests WHERE created_at >= $1 GROUP BY state ORDER BY state',[runStart])).rows;
    const counts=[...fake.posts.values()];
    return {scenario:'D',users:USERS,seconds:SECONDS,killAtMs:killedAt-t0,fakeLatencyMs:1500,
      total:summarize(samples,0,Infinity),beforeKill:summarize(samples,t0,killedAt),killWindow:summarize(samples,killedAt,killedAt+10_000),afterWindow:summarize(samples,killedAt+10_000,Infinity),
      billing:{secondaryPosts:fake.total(),distinctBodies:fake.posts.size,bodiesPostedTwiceOrMore:counts.filter(n=>n>1).length,postsBeforeKill:postsBefore,
        okTurns:samples.filter(s=>s.ok).length},
      unresolvedRefusals:samples.filter(s=>s.code==='PROVIDER_HTTP_502').length,
      standbyFailover:(standby as {failover?:unknown}|null)?.failover??null,ledgerRowsByState:ledger};
  } finally {
    for(const d of directories) await d.close();
    for(const gw of gws) if(gw.child.exitCode===null&&gw.child.signalCode===null) {gw.child.kill('SIGKILL');await gw.exit;}
    await fake.close();
    await rm(join(DIR,`gateway-ha-${RUN}-upstreams.json`),{force:true});
    // Leave ptr_loadtest as found: drop the ledger tables this run created, else delete only this run's rows.
    if(!existed.r&&!existed.b) await db.query('DROP TABLE IF EXISTS ptr_provider_requests; DROP TABLE IF EXISTS ptr_provider_budget');
    else await db.query('DELETE FROM ptr_provider_requests WHERE created_at >= $1',[runStart]);
    await db.end();
  }
}

async function main():Promise<void> {
  const redis=createRedisConnection(assertLocalRedisUrl(process.env.PTR_REDIS_URL??''));redis.on('error',()=>undefined);
  const scenarios=(args.scenarios??'C,E,T6,D').split(',');
  const report:Record<string,unknown>={run:RUN,prefix:PREFIX,startedAt:new Date().toISOString(),note:'Fake engines and a fake OpenRouter on loopback; no paid calls.',results:[] as unknown[]};
  await mkdir(DIR,{recursive:true});
  try {
    for(const scenario of scenarios) {
      const result=scenario==='D'?await scenarioD(redis):await killScenario(scenario as 'C'|'E'|'T6',redis);
      (report.results as unknown[]).push(result);
      const r=result as {total:{calls:number;failed:number;codes:unknown}};
      console.log(JSON.stringify({scenario,calls:r.total.calls,failed:r.total.failed,codes:r.total.codes}));
      // Let the dead gateways' records expire between scenarios (same names are reused).
      for(const key of await redis.keys(`${PREFIX}:*`)) await redis.del(key);
    }
  } finally {
    const keys=await redis.keys(`${PREFIX}:*`);if(keys.length) await redis.del(...keys);
    redis.disconnect();
    report.finishedAt=new Date().toISOString();
    const out=join(DIR,`gateway-ha-acceptance-${RUN}.json`);
    await writeFile(out,JSON.stringify(report,null,1),{mode:0o600});
    console.log(`report: ${out}`);
  }
}
void main().catch(error=>{console.error('gateway HA acceptance failed:',error instanceof Error?error.message:'unknown');process.exitCode=1;});
