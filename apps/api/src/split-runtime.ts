import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Queue} from 'bullmq';
import {CoreError,type TurnExecutionStore} from '../../../packages/core/src/ports';
import {WorkerOutboxMaintenance} from '../../../packages/core/src/turn-worker';
import {createLocalPool} from '../../../packages/storage/src/pool';
import {PostgresConversationStore} from '../../../packages/storage/src/conversations';
import {PostgresLlmControl} from '../../../packages/storage/src/llm-control';
import {BullMqTurnDelivery,turnJobId} from '../../../packages/messaging/src/bullmq-delivery';
import {RedisTurnEvents,RedisTurnEventSource} from '../../../packages/messaging/src/turn-events';
import {createRedisConnection,REDIS_PREFIX} from '../../../packages/messaging/src/redis';
import type {ChatSession} from '@ptr/contracts';
import {validateWire,type PersonaProjection,type StartRequest} from '../../../contracts/llm/v1/validate';
import type {CreativeArtifact} from './creative-artifact';
import {SplitChatService} from './split-chat';
import {bounded} from '../../../packages/ops/src/bounded';
export interface SplitApiRuntime {
  kind:'split';chat:SplitChatService;control:PostgresLlmControl;controlToken:string;
  executionStore:TurnExecutionStore;delivery:BullMqTurnDelivery;events:RedisTurnEvents;eventSource:RedisTurnEventSource;
  providerName:string;model:string;billable:boolean;
  listPersonas():Promise<PersonaProjection[]>;saveArtifact(artifact:CreativeArtifact):Promise<void>;
  draftRemote(session:ChatSession,brief:string,requestKey:string,deadlineAt:number,signal:AbortSignal):Promise<{content:string;provider:string;model:string}|{notice:{status:'out_of_scope';content:string;limitations:string[]}}>;
  health():Promise<{database:boolean;redis:boolean}>;close():Promise<void>;
}
const integer=(env:NodeJS.ProcessEnv,key:string,fallback:number,min:number,max:number)=>{const n=Number(env[key]??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw new CoreError('INVALID_INPUT');return n;};
/** Split production composition uses only app-schema storage and queue/control clients. No DDL/provider construction. */
export function createSplitRuntime(env:NodeJS.ProcessEnv=process.env):SplitApiRuntime {
  const databaseUrl=env.PTR_APP_DATABASE_URL??env.DATABASE_URL??'';
  let db:URL;try{db=new URL(databaseUrl);}catch{throw new CoreError('INVALID_INPUT');}
  if(!['ptr_split_test','ptr_split_research'].includes(db.pathname.slice(1))||db.username!=='ptr_split_app')throw new CoreError('INVALID_INPUT');
  const serviceUrl=env.PTR_LLM_SERVICE_URL??'http://127.0.0.1:58442';let url:URL;try{url=new URL(serviceUrl);}catch{throw new CoreError('INVALID_INPUT');}
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new CoreError('INVALID_INPUT');
  const controlToken=env.PTR_LLM_CONTROL_TOKEN??'';if(controlToken.length<24||controlToken.length>512||controlToken===env.PTR_API_TOKEN||controlToken===env.PTR_API_SYNTHETIC_TOKEN)throw new CoreError('INVALID_INPUT');
  const queueName=env.PTR_TURN_QUEUE??'turns',namespace=env.PTR_EVENTS_NAMESPACE??'events';if(!/^[a-z0-9-]{1,40}$/.test(queueName)||!/^[a-z0-9-]{1,40}$/.test(namespace))throw new CoreError('INVALID_INPUT');
  const pool=createLocalPool(databaseUrl,{schema:'app',max:integer(env,'PTR_DB_POOL_MAX',8,1,200)}),store=new PostgresConversationStore(pool),redisUrl=env.PTR_REDIS_URL??'';
  let connection:ReturnType<typeof createRedisConnection>|undefined,queue:Queue|undefined;
  const redis=()=>{if(!connection){connection=createRedisConnection(redisUrl);connection.on('error',()=>undefined);}return connection;};
  const currentQueue=()=>queue??=new Queue(queueName,{connection:redis(),prefix:REDIS_PREFIX});
  const validLock=async(r:StartRequest)=>r.jobId===turnJobId({turnId:r.turnId,seq:r.dispatchSeq})&&await redis().get(`${REDIS_PREFIX}:${queueName}:${r.jobId}:lock`)===r.lockToken;
  const maxQueueMs=integer(env,'PTR_TURN_MAX_QUEUE_MS',60000,1000,3600000),maxAttempts=integer(env,'PTR_MAX_ATTEMPTS',3,1,10);
  const control=new PostgresLlmControl(pool,validLock,{timeoutMs:integer(env,'PTR_TURN_TIMEOUT_MS',30000,1000,300000),maxQueueMs,maxAttempts});
  const delivery=new BullMqTurnDelivery(redisUrl,{queueName,splitWire:true}),events=new RedisTurnEvents(redisUrl,{namespace}),eventSource=new RedisTurnEventSource(redisUrl,{namespace});
  const rpc=async(name:string,path:string,body?:unknown,signal?:AbortSignal)=>{
    try {
      const response=await fetch(new URL(path,url),{method:body===undefined?'GET':'POST',redirect:'error',headers:{Authorization:`Bearer ${controlToken}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:signal??AbortSignal.timeout(3000)});
      if(!response.ok||!response.body)throw new CoreError('TURN_FAILED');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try {for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>1024*1024){await reader.cancel();throw new CoreError('TURN_FAILED');}chunks.push(next.value);}}finally{reader.releaseLock();}
      return validateWire(name,JSON.parse(Buffer.concat(chunks).toString('utf8')));
    }catch{throw new CoreError('TURN_FAILED');}
  };
  const listPersonas=async()=>{const response=await rpc('CatalogueResponse','/internal/llm/personas') as unknown as {personas:PersonaProjection[]};if(new Set(response.personas.map(p=>p.personId)).size!==response.personas.length)throw new CoreError('PERSONA_UNAVAILABLE');return response.personas;};
  const chat=new SplitChatService(store,listPersonas,delivery,events,integer(env,'PTR_QUEUE_MAX_DEPTH',256,1,100000),env.PTR_LLM_SEMANTIC_SEARCH==='1');
  const maintenance=new WorkerOutboxMaintenance({executions:store,delivery,events,state:dispatch=>currentQueue().getJobState(turnJobId(dispatch)),maxQueueMs,maxAttempts,graceMs:integer(env,'PTR_DISPATCH_GRACE_MS',2000,0,600000),intervalMs:integer(env,'PTR_DISPATCH_INTERVAL_MS',1000,50,60000)});
  // API/backend owns outbox reconciliation even when Python/control service is down.
  if(env.PTR_BACKEND_MAINTENANCE!=='0')maintenance.start();
  return {kind:'split',chat,control,controlToken,executionStore:store,delivery,events,eventSource,providerName:env.PTR_CHAT_PROVIDER??'fake',model:env.PTR_MODEL??'synthetic/fake-text-v1',billable:env.PTR_LITELLM_BILLABLE==='1',listPersonas,
    async draftRemote(session,brief,requestKey,deadlineAt,signal) {const payload=validateWire('DraftRequest',{contractVersion:1,session,brief,requestKey,deadlineAt});const result=await rpc('DraftResponse','/internal/llm/draft',payload,signal);const {contractVersion:_,...reply}=result;return reply as {content:string;provider:string;model:string}|{notice:{status:'out_of_scope';content:string;limitations:string[]}};},
    async saveArtifact(artifact) {const directory=join(process.cwd(),'data','generated');await mkdir(directory,{recursive:true,mode:0o700});await writeFile(join(directory,`${artifact.id}.json`),JSON.stringify(artifact,null,2),{flag:'wx',mode:0o600});},
    async health() {const check=async(work:()=>Promise<unknown>)=>{try{await bounded(work,1000);return true;}catch{return false;}};const [database,redisOkay]=await Promise.all([check(()=>pool.query('SELECT 1')),check(()=>redis().ping())]);return {database,redis:redisOkay};},
    async close(){await maintenance.stop();await Promise.allSettled([delivery.close(),events.close(),eventSource.close(),queue?.close()]);connection?.disconnect();await pool.end();},
  };
}
