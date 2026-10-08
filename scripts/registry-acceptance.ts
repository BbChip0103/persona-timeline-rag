/**
 * Acceptance harness for the dynamic upstream set (routing , stage S2: T1–T5, T7, T9). Zero cost: fake
 * engines (in-process HTTP, 12 concurrent sequences each, fixed service time, an engine-side queue beyond that),
 * the real ptr-upstream-agent loop (in-process, so "SIGKILL" = stop without cleanup), the real gateway + UpstreamPool +
 * RedisRegistrySource, and worker clients (OpenAICompatibleTextProvider with the S1 retry settings) as closed-loop users.
 *
 *   pnpm exec tsx scripts/registry-acceptance.ts [--store=redis|memory] [--scenarios=T1,T2,T3,T4,T5,T7,T7b,T9] [--users=24]
 *
 * --store=redis (default) uses the isolated Redis (PTR_REDIS_URL) through a local TCP proxy (so T7 can cut it without
 * touching the shared container), in a dedicated `ptrtest:s2<run>:llm` namespace that is deleted afterwards.
 * --store=memory uses the in-memory registry with the same semantics. Writes reports/registry-acceptance-<run>.json.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect, createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MemoryUpstreamRegistry, RedisUpstreamRegistry, assertLocalRedisUrl, createRedisConnection, type RegistryReader, type RegistryWriter } from '@ptr/messaging';
import { OpenAICompatibleTextProvider, type ProviderError } from '@ptr/providers';
import { createGateway } from '../apps/gateway/src/server';
import { UpstreamPool, type PoolMetrics } from '../apps/gateway/src/pool';
import { RedisRegistrySource, parseUpstreamAllow } from '../apps/gateway/src/sources';
import { drainUpstream, runAgent, type AgentHandle } from './upstream-agent';

const POOL='fake-e4b';
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')];}));

/** vLLM-like fake: at most `capacity` sequences run, the rest wait inside the engine; each takes `serviceMs`. */
class FakeEngine {
  running=0;completed=0;cut=0;startTime=0;port=0;
  private server:Server|undefined;private readonly sockets=new Set<Socket>();private queue:(()=>void)[]=[];
  constructor(readonly name:string,readonly capacity=12,readonly serviceMs=600) {}
  async start(port:number):Promise<void> {
    this.startTime=Date.now()/1000;this.port=port;this.running=0;this.queue=[];
    const server=createServer((req,res)=>this.handle(req,res));
    server.on('connection',socket=>{this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve());});
    this.server=server;
  }
  /** SIGKILL: every connection is reset, the port refuses. */
  kill():void {this.server?.close();for(const socket of this.sockets) socket.destroy();this.server=undefined;this.queue=[];this.running=0;}
  get baseUrl():string {return `http://127.0.0.1:${this.port}/v1`;}
  private handle(req:IncomingMessage,res:ServerResponse):void {
    if(req.url==='/health') {res.writeHead(200);res.end();return;}
    if(req.url==='/metrics') {res.writeHead(200,{'Content-Type':'text/plain'});
      res.end(`vllm:num_requests_running{model_name="${POOL}"} ${this.running}\nvllm:num_requests_waiting{model_name="${POOL}"} ${this.queue.length}\n`
        +`vllm:cache_config_info{block_size="16",num_gpu_blocks="21687"} 1.0\nprocess_start_time_seconds ${this.startTime}\n`);return;}
    req.resume();req.on('end',()=>{
      let state:'queued'|'running'|'done'='queued';
      const run=()=>{
        if(state!=='queued') return;state='running';this.running++;
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        const chunk=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\n`;
        const first=setTimeout(()=>res.write(chunk(`${this.name} `)),30);
        const end=setTimeout(()=>{state='done';this.running--;this.completed++;res.end(`${chunk('응답')}data: [DONE]\n\n`);this.next();},this.serviceMs);
        res.on('close',()=>{if(state==='running'){state='done';clearTimeout(first);clearTimeout(end);this.running--;this.cut++;this.next();}});
      };
      res.on('close',()=>{if(state==='queued'){state='done';this.queue=this.queue.filter(item=>item!==run);}});
      if(this.running<this.capacity) run();else this.queue.push(run);
    });
  }
  private next():void {const run=this.queue.shift();run?.();}
}

/** Loopback TCP proxy in front of Redis: `cut()` refuses and resets everything until `restore()`. */
class RedisProxy {
  port=0;private server:TcpServer|undefined;private readonly sockets=new Set<Socket>();
  constructor(private readonly target:number) {}
  async start(port=0):Promise<void> {
    const server=createTcpServer(client=>{
      const upstream=connect(this.target,'127.0.0.1');
      for(const socket of [client,upstream]) {this.sockets.add(socket);socket.on('close',()=>this.sockets.delete(socket));socket.on('error',()=>{client.destroy();upstream.destroy();});}
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>resolve());});
    this.server=server;this.port=(server.address() as {port:number}).port;
  }
  cut():void {this.server?.close();for(const socket of this.sockets) socket.destroy();this.server=undefined;}
  async restore():Promise<void> {await this.start(this.port);}
  async stop():Promise<void> {this.cut();}
}

interface Turn {start:number;end:number;ok:boolean;code?:string}
interface Sample {t:number;pool:PoolMetrics}
type Store=RegistryReader&RegistryWriter;

/** One scenario's world: registry, gateway, engines, agents, users. */
class World {
  readonly t0=Date.now();
  readonly turns:Turn[]=[];readonly samples:Sample[]=[];readonly events:{t:number;event:string;[key:string]:unknown}[]=[];
  readonly engines=new Map<string,FakeEngine>();readonly agents=new Map<string,AgentHandle>();
  private readonly closers:(()=>Promise<void>|void)[]=[];
  private stopLoad=false;private loadDone:Promise<void>|undefined;private sampler:NodeJS.Timeout|undefined;
  pool!:UpstreamPool;gatewayBase='';private readonly token=randomBytes(24).toString('hex');
  constructor(readonly name:string,readonly backend:Backend) {}
  t():number {return (Date.now()-this.t0)/1000;}
  mark(event:string,extra:Record<string,unknown>={}):void {this.events.push({t:this.t(),event,...extra});}
  async engine(name:string):Promise<FakeEngine> {
    const engine=new FakeEngine(name);
    for(let port=18700+Math.floor(Math.random()*200);;port++) {try {await engine.start(port);break;} catch {if(port>18999) throw new Error('NO_FREE_PORT');}}
    this.engines.set(name,engine);this.closers.push(()=>engine.kill());return engine;
  }
  agent(name:string,engine:FakeEngine):AgentHandle {
    const store=this.backend.store();
    const handle=runAgent(store.store,{pool:POOL,id:name,baseUrl:engine.baseUrl,log:line=>{const parsed=JSON.parse(line) as {event:string};this.mark(`agent ${name}: ${parsed.event}`);}});
    this.agents.set(name,handle);this.closers.push(()=>{handle.kill();return store.close();});
    return handle;
  }
  async gateway():Promise<void> {
    const reader=this.backend.store();
    const source=new RedisRegistrySource(reader.store,{pool:POOL,allow:parseUpstreamAllow(undefined),pollMs:2000,graceMs:10000});
    this.pool=new UpstreamPool({model:POOL,source,slowStartMs:30000,queueTimeoutMs:10000});
    await this.pool.ready(AbortSignal.timeout(5000));
    const {server}=createGateway({token:this.token,upstream:this.pool,limits:{maxConcurrent:256,maxQueue:256,queueTimeoutMs:10000,upstreamTimeoutMs:60000}});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
    this.gatewayBase=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
    this.closers.push(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await this.pool.close();await reader.close();});
    this.sampler=setInterval(()=>this.samples.push({t:this.t(),pool:this.pool.poolMetrics()}),200);
  }
  /** Wait until `count` records are in the registry, so a gateway started now loads them at full capacity. */
  async registered(count:number):Promise<void> {for(let i=0;i<200&&(await this.backend.liveIds()).length<count;i++) await sleep(50);}
  waitForMembers(count:number,ms=15000):Promise<void> {
    return (async()=>{const end=Date.now()+ms;while(Date.now()<end){if(this.pool.poolMetrics().members.active>=count)return;await sleep(50);}throw new Error(`${this.name}: members not ready`);})();
  }
  load(users:number):void {
    const client=new OpenAICompatibleTextProvider({baseUrl:this.gatewayBase,model:'gateway',apiKey:this.token,resetRetries:2,retryMinRemainingMs:5000,timeoutMs:60000});
    const user=async(index:number)=>{
      for(let n=0;!this.stopLoad;n++) {
        const start=Date.now();
        try {await client.generate([{role:'user',content:`synthetic turn ${index}-${n}`}],{signal:AbortSignal.timeout(40000),requestKey:`s2-${this.name}-${index}-${n}`,deadlineAt:start+30000});
          this.turns.push({start,end:Date.now(),ok:true});}
        catch(error) {this.turns.push({start,end:Date.now(),ok:false,code:(error as ProviderError).code??'UNKNOWN'});}
        await sleep(20);
      }
    };
    this.loadDone=Promise.all(Array.from({length:users},(_,index)=>user(index))).then(()=>undefined);
  }
  async until(seconds:number):Promise<void> {const wait=this.t0+seconds*1000-Date.now();if(wait>0) await sleep(wait);}
  async finish():Promise<void> {
    this.stopLoad=true;await this.loadDone;clearInterval(this.sampler);
    for(const close of this.closers.reverse()) await close();
    await this.backend.cleanup();
  }
  /** Completed turns per second over [from, to) seconds (by end time). */
  rate(from:number,to:number):number {
    return this.turns.filter(turn=>turn.ok&&(turn.end-this.t0)/1000>=from&&(turn.end-this.t0)/1000<to).length/(to-from);
  }
  failures():{failed:number;codes:Record<string,number>;turns:number} {
    const codes:Record<string,number>={};
    for(const turn of this.turns) if(!turn.ok) codes[turn.code!]=(codes[turn.code!]??0)+1;
    return {turns:this.turns.length,failed:this.turns.filter(turn=>!turn.ok).length,codes};
  }
  member(sample:Sample,id:string) {return sample.pool.upstreams.find(u=>u.id===id&&u.state!=='gone');}
  firstSample(check:(sample:Sample)=>boolean,after=0):Sample|undefined {return this.samples.find(sample=>sample.t>=after&&check(sample));}
}

interface Backend {
  close?():Promise<void>;
  store():{store:Store;close():Promise<void>};
  cut():Promise<void>|void; restore():Promise<void>|void;
  /** Live records as Redis sees them (bypassing the proxy). */
  liveIds():Promise<string[]>;
  direct():Store;
  cleanup():Promise<void>;
}
async function redisBackend(run:string):Promise<Backend> {
  const url=assertLocalRedisUrl(process.env.PTR_REDIS_URL??'');
  const parsed=new URL(url);
  const prefix=`ptrtest:s2${run}:llm`;
  const proxy=new RedisProxy(Number(parsed.port));await proxy.start();
  const direct=createRedisConnection(url);direct.on('error',()=>undefined);
  const directStore=new RedisUpstreamRegistry(direct,prefix);
  const viaProxy=()=>{
    // The guarded connection's options (fail fast, auth, db), only through the proxy port.
    const redis=direct.duplicate({port:proxy.port,connectionName:'ptrtest'});
    redis.on('error',()=>undefined);
    return {store:new RedisUpstreamRegistry(redis,prefix),close:async()=>{redis.disconnect();}};
  };
  return {
    store:viaProxy,cut:()=>proxy.cut(),restore:()=>proxy.restore(),direct:()=>directStore,
    liveIds:async()=>(await directStore.list(POOL)).records.map(hash=>hash.id!).sort(),
    cleanup:async()=>{
      let cursor='0';
      do {const [next,keys]=await direct.scan(cursor,'MATCH',`${prefix}:*`,'COUNT',1000);cursor=next;if(keys.length) await direct.del(...keys);} while(cursor!=='0');
    },
    close:async()=>{await proxy.stop();direct.disconnect();},
  };
}
function memoryBackend():Backend {
  const store=new MemoryUpstreamRegistry(Date.now);
  return {store:()=>({store,close:async()=>undefined}),cut:()=>{store.down=true;},restore:()=>{store.down=false;},direct:()=>store,
    liveIds:async()=>{const down=store.down;store.down=false;try {return (await store.list(POOL)).records.map(hash=>hash.id!).sort();} finally {store.down=down;}},
    cleanup:async()=>undefined};
}

type Result=Record<string,unknown>&{scenario:string;pass:boolean};
const round=(value:number|undefined|null,digits=2)=>value===undefined||value===null?null:Number(value.toFixed(digits));

async function t1(world:World,users:number):Promise<Result> {
  const a=await world.engine('a');world.agent('a',a);await world.registered(1);await world.gateway();await world.waitForMembers(1);
  world.load(users);await world.until(10);
  const b=await world.engine('b');const agentB=world.agent('b',b);
  await world.until(56);
  const published=agentB.status().firstPublishedAt;
  const seen=world.firstSample(sample=>!!world.member(sample,'b'),10);
  const detectS=published&&seen?seen.t-(published-world.t0)/1000:null;
  const ramp=[0,7.5,15,22.5,30].map(offset=>{const sample=world.firstSample(s=>!!world.member(s,'b'),(seen?.t??0)+offset);const m=sample&&world.member(sample,'b');
    return {atS:offset,limit:m?.limit??null,inFlight:m?.inFlight??null};});
  const before=world.rate(4,10), after=world.rate(46,56);
  const f=world.failures();
  return {scenario:'T1 scale-up',...f,detectS:round(detectS),ramp,rateBefore:round(before),rateAfter:round(after),speedup:round(after/before),
    pass:f.failed===0&&detectS!==null&&detectS<=2&&after/before>=1.8};
}
async function bothUp(world:World,users:number):Promise<[FakeEngine,FakeEngine]> {
  const a=await world.engine('a'),b=await world.engine('b');world.agent('a',a);world.agent('b',b);
  // Register before the gateway starts so both begin at full capacity (no slow start in these scenarios).
  await world.registered(2);
  await world.gateway();await world.waitForMembers(2);world.load(users);
  return [a,b];
}
async function t2(world:World,users:number,backend:Backend):Promise<Result> {
  await bothUp(world,users);await world.until(8);
  const drainAt=world.t();
  const cli=drainUpstream(backend.direct(),POOL,'b',{timeoutMs:60000,pollMs:200});
  const result=await cli;const removedAt=world.t();
  await world.until(Math.max(25,removedAt+3));
  const seenDraining=world.firstSample(sample=>sample.pool.upstreams.some(u=>u.id==='b'&&u.state!=='active'),drainAt);
  const atDrain=seenDraining&&seenDraining.pool.upstreams.find(u=>u.id==='b');
  const last=[...world.samples].reverse().find(sample=>sample.pool.upstreams.some(u=>u.id==='b'));
  const dispatchedAtDrain=atDrain?.dispatched??null, dispatchedFinal=last?.pool.upstreams.find(u=>u.id==='b')?.dispatched??null;
  const gone=world.firstSample(sample=>!sample.pool.upstreams.some(u=>u.id==='b'),drainAt);
  const f=world.failures();
  const stopS=seenDraining?seenDraining.t-drainAt:null;
  return {scenario:'T2 planned drain',...f,cli:result,stopNewDispatchS:round(stopS),inFlightAtDrain:atDrain?.inFlight??null,
    dispatchedAfterDrainSeen:dispatchedFinal!==null&&dispatchedAtDrain!==null?dispatchedFinal-dispatchedAtDrain:null,
    recordDeletedAfterS:round(removedAt-drainAt),goneFromGatewayAfterS:round(gone?gone.t-drainAt:null),
    pass:f.failed===0&&result==='drained'&&stopS!==null&&stopS<=2&&dispatchedFinal===dispatchedAtDrain};
}
async function t3(world:World,users:number):Promise<Result> {
  const [,b]=await bothUp(world,users);await world.until(8);
  const killAt=world.t();const inFlight=b.running;
  world.agents.get('b')!.kill();b.kill();world.mark('SIGKILL engine b + agent b');
  await world.until(30);
  const gone=world.firstSample(sample=>!sample.pool.upstreams.some(u=>u.id==='b'),killAt);
  const f=world.failures();const last=world.samples.at(-1)!.pool;
  return {scenario:'T3 engine+agent SIGKILL',...f,engineInFlightAtKill:inFlight,streamsCut:b.cut,retriedOnOtherPrimary:last.retriedOnOtherPrimary,
    removedAfterS:round(gone?gone.t-killAt:null),pass:f.failed===0&&!!gone&&gone.t-killAt<=12};
}
async function t4(world:World,users:number):Promise<Result> {
  const [,b]=await bothUp(world,users);await world.until(8);
  const epochBefore=world.agents.get('b')!.status().epoch;const killAt=world.t();
  world.agents.get('b')!.kill();world.mark('SIGKILL agent b (engine alive)');
  await world.until(24);
  const gone=world.firstSample(sample=>!sample.pool.upstreams.some(u=>u.id==='b'),killAt);
  const restartAt=world.t();const agent=world.agent('b',b);
  await world.until(40);
  const back=world.firstSample(sample=>!!world.member(sample,'b'),restartAt);
  const reduced=world.rate((gone?.t??20)+1,24), full=world.rate(3,8);
  const f=world.failures();
  return {scenario:'T4 agent-only crash',...f,removedAfterS:round(gone?gone.t-killAt:null),rateBefore:round(full),rateWhileGone:round(reduced),
    sameEpoch:agent.status().epoch===epochBefore,backAfterRestartS:round(back?back.t-restartAt:null),limitOnReturn:back?world.member(back,'b')?.limit:null,
    pass:f.failed===0&&agent.status().epoch===epochBefore&&!!back};
}
async function t5(world:World,users:number):Promise<Result> {
  const a=await world.engine('a'),b=await world.engine('b');world.agent('a',a);
  await world.registered(1);await world.gateway();await world.waitForMembers(1);world.load(users);
  const reAdds:{t:number;limit:number|null;maxInFlight2s:number}[]=[];
  let handle=world.agent('b',b);
  for(let cycle=0;cycle<4;cycle++) {
    // Agent stalls: no heartbeat → the record expires after the TTL; it comes back 12 s after the stall began.
    await sleep(2000);handle.kill();world.mark(`flap ${cycle}: agent b stalls`);
    await sleep(12000);handle=world.agent('b',b);
  }
  await sleep(4000);
  const before=world.pool.poolMetrics().events;
  for(let i=1;i<world.samples.length;i++) {
    const was=world.member(world.samples[i-1]!,'b'), now=world.member(world.samples[i]!,'b');
    if(!was&&now) {
      const window=world.samples.filter(s=>s.t>=world.samples[i]!.t&&s.t<world.samples[i]!.t+2);
      reAdds.push({t:round(world.samples[i]!.t)!,limit:now.limit,maxInFlight2s:Math.max(...window.map(s=>world.member(s,'b')?.inFlight??0))});
    }
  }
  const f=world.failures();
  return {scenario:'T5 flapping',...f,adds:before.added,removes:before.removed,reAdds,
    pass:f.failed===0&&reAdds.every(add=>add.maxInFlight2s<=2)};
}
async function t7(world:World,users:number,backend:Backend,outageMs:number):Promise<Result> {
  await bothUp(world,users);await world.until(8);
  const removedBefore=world.pool.poolMetrics().events.removed;const cutAt=world.t();
  await backend.cut();world.mark('redis cut');
  await sleep(outageMs);
  const liveAtRestore=await backend.liveIds();
  await backend.restore();const restoreAt=world.t();world.mark('redis restored');
  await world.until(restoreAt+14);
  const staleSeen=world.firstSample(sample=>!!sample.pool.registry?.stale,cutAt);
  const staleEnd=world.firstSample(sample=>!sample.pool.registry?.stale,cutAt+0.5);
  const removedDuring=world.pool.poolMetrics().events.removed-removedBefore;
  const membersMin=Math.min(...world.samples.filter(s=>s.t>=cutAt).map(s=>s.pool.members.active));
  const f=world.failures();
  return {scenario:`T7 Redis ${outageMs/1000}s outage`,...f,staleDetectedAfterS:round(staleSeen?staleSeen.t-cutAt:null),
    staleClearedAfterRestoreS:round(staleEnd?staleEnd.t-restoreAt:null),recordsLeftInRedisAtRestore:liveAtRestore.length,
    wrongRemovals:removedDuring,minActiveMembers:membersMin,graceRemainingAtEnd:world.samples.at(-1)!.pool.registry?.graceRemainingMs??null,
    pass:f.failed===0&&removedDuring===0&&membersMin===2};
}
async function t9(world:World,users:number,backend:Backend):Promise<Result> {
  const a=await world.engine('a');world.agent('a',a);await world.registered(1);await world.gateway();await world.waitForMembers(1);world.load(users);
  // A listener on the rogue port proves nothing connects to it.
  let rogueConnections=0;const rogue=createTcpServer(socket=>{rogueConnections++;socket.destroy();});
  const roguePort=await new Promise<number>(resolve=>{rogue.once('error',()=>resolve(0));rogue.listen(19999,'127.0.0.1',()=>resolve(19999));});
  const before=world.pool.poolMetrics().registry!.rejected;
  const store=backend.direct();
  const base={pool:POOL,maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active' as const,epoch:'rogue',seq:0};
  for(let beat=0;beat<5;beat++) {
    await store.heartbeat({...base,id:'rogue-port',baseUrl:'http://127.0.0.1:19999/v1',seq:beat},10000);
    await store.heartbeat({...base,id:'rogue-remote',baseUrl:'http://10.0.0.5:18001/v1',seq:beat},10000);
    await sleep(2000);
  }
  const metrics=world.pool.poolMetrics();
  rogue.close();
  const f=world.failures();
  return {scenario:'T9 allowlist',...f,rejectedDelta:metrics.registry!.rejected-before,rejectedReasons:metrics.registry!.rejectedReasons,
    members:metrics.upstreams.map(u=>u.id),rogueConnections,rogueListener:roguePort!==0,
    pass:f.failed===0&&metrics.registry!.rejected-before===2&&rogueConnections===0&&metrics.upstreams.every(u=>u.id==='a')};
}

async function main():Promise<void> {
  const run=`${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const storeKind=args.store??'redis', users=Number(args.users??24);
  const scenarios=(args.scenarios??'T1,T2,T3,T4,T5,T7,T7b,T9').split(',');
  const results:Result[]=[];
  for(const scenario of scenarios) {
    const backend=storeKind==='memory'?memoryBackend():await redisBackend(`${run}${scenario.toLowerCase()}`);
    const world=new World(scenario,backend);
    process.stderr.write(`${scenario} …\n`);
    try {
      const result=scenario==='T1'?await t1(world,users):scenario==='T2'?await t2(world,users,backend):scenario==='T3'?await t3(world,users)
        :scenario==='T4'?await t4(world,users):scenario==='T5'?await t5(world,users):scenario==='T7'?await t7(world,users,backend,10000)
        :scenario==='T7b'?await t7(world,users,backend,12000):scenario==='T9'?await t9(world,8,backend):undefined;
      if(!result) throw new Error(`unknown scenario ${scenario}`);
      results.push({...result,events:world.events});
      process.stderr.write(`${scenario}: ${result.pass?'PASS':'FAIL'} failed=${String(result.failed)}\n`);
    } finally {
      await world.finish();await backend.close?.();
    }
  }
  const directory=join(process.cwd(),'reports');await mkdir(directory,{recursive:true});
  const file=join(directory,`registry-acceptance-${run}.json`);
  await writeFile(file,JSON.stringify({run,store:storeKind,users,results},null,2));
  process.stdout.write(`${JSON.stringify({file,store:storeKind,users,summary:results.map(({events:_events,...rest})=>rest)},null,2)}\n`);
}
if(require.main===module) void main().catch(error=>{process.stderr.write(`REGISTRY_ACCEPTANCE_FAILED ${(error as Error).message}\n`);process.exitCode=1;});
