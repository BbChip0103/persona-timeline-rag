import { replyText } from '../packages/core/src/reply-texts';
import { operationalConfig, parseNativeMetrics, privateMetadata, validateManifest, validateSignal, completedProof, AdmissionBudget, validateModelPolicy, validRagOffLimitations } from './operational-smoke';
const env = {
  PTR_OPERATIONAL_OWNER_NONCE:'synthetic-owner-20261011', PTR_OPERATIONAL_BACKEND_URL:'http://127.0.0.1:56441',
  PTR_OPERATIONAL_WORKER_URL:'http://127.0.0.1:58442', PTR_OPERATIONAL_GATEWAY_URL:'http://127.0.0.1:59990',
  PTR_OPERATIONAL_API_TOKEN:'synthetic-api-token-123456789', PTR_OPERATIONAL_MODEL_METRICS_URL:'http://127.0.0.1:59991/metrics',
  PTR_OPERATIONAL_MODEL_METRICS_TOKEN:'synthetic-metrics-token', PTR_OPERATIONAL_MODEL_CALL_CAP:'12',PTR_OPERATIONAL_MAX_OUTPUT_TOKENS:'512',
  PTR_OPERATIONAL_APP_DATABASE_URL:'postgresql://ptr_split_app:synthetic@127.0.0.1:58432/ptr_split_research',
  PTR_OPERATIONAL_LLM_DATABASE_URL:'postgresql://ptr_split_llm:synthetic@127.0.0.1:58432/ptr_split_research',
  PTR_OPERATIONAL_DEPLOYMENT_MANIFEST:'/tmp/ptr-operational-cutover-20261011/synthetic-manifest.json',
};
it('defaults to no model execution and locks approved exact local roles/caps',()=>{
  expect(operationalConfig(env).execute).toBe(false);
  expect(operationalConfig(env,true,env.PTR_OPERATIONAL_OWNER_NONCE).execute).toBe(true);
  for(const patch of [{PTR_OPERATIONAL_MODEL_CALL_CAP:'13'},{PTR_OPERATIONAL_MAX_OUTPUT_TOKENS:'513'},
    {PTR_OPERATIONAL_BACKEND_URL:'http://example.com'}, {PTR_OPERATIONAL_APP_DATABASE_URL:env.PTR_OPERATIONAL_LLM_DATABASE_URL},
    {PTR_OPERATIONAL_APP_DATABASE_URL:env.PTR_OPERATIONAL_APP_DATABASE_URL.replace('ptr_split_research','ptr_split_test')}])
    expect(()=>operationalConfig({...env,...patch})).toThrow();
  expect(()=>operationalConfig(env,true,'wrong-nonce')).toThrow('OWNER_NONCE_MISMATCH');
});
it('sums genuine native success labels; missing error counter is null, never invented admission',()=>{
  const result=parseNativeMetrics('vllm:request_success_total{finish_reason="stop"} 3\nvllm:request_success_total{finish_reason="length"} 2\nvllm:num_requests_running 0\nvllm:num_requests_waiting 0\nvllm:prompt_tokens_total 40\nvllm:generation_tokens_total 12');
  expect(result).toMatchObject({successes:5,errors:null,running:0,waiting:0,promptTokens:40,generationTokens:12});
  expect(()=>parseNativeMetrics('vllm:num_requests_running 0')).toThrow('NATIVE_SUCCESS_METRIC_MISSING');
});
it('metadata cannot contain corpus IDs/content or enumerable plain hashes',()=>{
  const value=privateMetadata('synthetic-secret-id','synthetic private reply',env.PTR_OPERATIONAL_OWNER_NONCE);
  expect(value.bytes).toBe(Buffer.byteLength('synthetic private reply'));
  expect(JSON.stringify(value)).not.toMatch(/synthetic-secret-id|synthetic private reply/);
  expect(value).not.toEqual(privateMetadata('synthetic-secret-id','synthetic private reply','other-key'));
});
it('requires exact deployment/signal owner and all three service identities',()=>{
  const manifest={ownerNonce:env.PTR_OPERATIONAL_OWNER_NONCE,project:'synthetic-ops',services:['api','worker','model-gateway'].map(name=>({name,id:`synthetic-${name}`,image:'synthetic-image',ownerLabel:env.PTR_OPERATIONAL_OWNER_NONCE}))};
  expect(validateManifest(manifest,env.PTR_OPERATIONAL_OWNER_NONCE).services).toHaveLength(3);
  expect(()=>validateManifest({...manifest,ownerNonce:'other'},env.PTR_OPERATIONAL_OWNER_NONCE)).toThrow();
  expect(()=>validateSignal({ownerNonce:'other',phase:'worker-paused'},env.PTR_OPERATIONAL_OWNER_NONCE,'worker-paused')).toThrow();
  expect(validateSignal({ownerNonce:env.PTR_OPERATIONAL_OWNER_NONCE,phase:'worker-paused'},env.PTR_OPERATIONAL_OWNER_NONCE,'worker-paused')).toBe(true);
});
it('exactly-once means one assistant, drained outbox, one durable acknowledged receipt',()=>{
  expect(completedProof({state:'completed',assistants:1,outbox:0,grants:1,acknowledged:1})).toBe(true);
  for(const patch of [{assistants:2},{outbox:1},{acknowledged:0},{grants:2},{state:'failed'}]) expect(completedProof({state:'completed',assistants:1,outbox:0,grants:1,acknowledged:1,...patch})).toBe(false);
});
it('bounds local submissions independently of unsupported provider admission counters',()=>{
  const budget=new AdmissionBudget(2);budget.reserve();budget.reserve();expect(budget.submissions).toBe(2);expect(()=>budget.reserve()).toThrow('LOCAL_SUBMISSION_CAP');
});

import { operationalSmoke } from './operational-smoke';
import type { Pool } from 'pg';
it('default preflight contacts readiness/denial/metrics only, never catalogue, model, or DB corpus rows',async()=>{
  const urls:string[]=[],queries:string[]=[],artifacts:unknown[]=[];
  const pool=(role:string)=>({query:async(sql:string)=>{queries.push(sql);return {rows:[{db:'ptr_split_research',role}]};},end:async()=>undefined}) as unknown as Pool;
  const mockFetch:typeof fetch=async input=>{const url=String(input);urls.push(url);if(url.endsWith('/api/personas'))return new Response('{}',{status:403});if(url.endsWith('/metrics'))return new Response('vllm:request_success_total 0\nvllm:num_requests_running 0\nvllm:num_requests_waiting 0');return new Response('{}');};
  const report=await operationalSmoke(operationalConfig(env),{fetch:mockFetch,app:pool('ptr_split_app'),llm:pool('ptr_split_llm'),verifyOwnership:async()=>({servicesVerified:3}),persist:async(_path,body)=>{artifacts.push(body);}});
  expect(report.passed).toBe(true);expect(report.localDistinctTurnSubmissions).toBe(0);expect(urls).toHaveLength(5);expect(urls).not.toContain(expect.stringMatching(/chat\/completions|\/health$/));expect(queries.every(sql=>sql==='SELECT current_database() AS db,current_user AS role')).toBe(true);expect(artifacts).toHaveLength(1);
});
it('preserves failed metadata and closes both connections without raw response/errors',async()=>{
  let closed=0;const artifacts:unknown[]=[];const pool={query:async()=>({rows:[{db:'wrong',role:'wrong'}]}),end:async()=>{closed++;}} as unknown as Pool;
  await expect(operationalSmoke(operationalConfig(env),{app:pool,llm:pool,verifyOwnership:async()=>undefined,persist:async(_path,body)=>{artifacts.push(body);}})).rejects.toThrow('ACTUAL_DATABASE_IDENTITY');
  expect(closed).toBe(2);expect(artifacts).toMatchObject([{passed:false,localDistinctTurnSubmissions:0}]);
});
it('rejects a stale parent marker even when deployment owner matches',()=>{
  expect(()=>validateSignal({ownerNonce:env.PTR_OPERATIONAL_OWNER_NONCE,phase:'worker-paused',requestNonce:'old'},env.PTR_OPERATIONAL_OWNER_NONCE,'worker-paused','fresh')).toThrow('PARENT_SIGNAL_MISMATCH');
});
async function syntheticProtocol(providerRowsAfter=0){
  type Turn={id:string;state:string;client:string};const turns:Turn[]=[];let paused=false,successes=0,firstOwner='',sessions=0,sessionCountAtPause=0;const artifacts:unknown[]=[];
  const app={query:async(sql:string,args?:string[])=>{
    if(sql.startsWith('SELECT current_database'))return {rows:[{db:'ptr_split_research',role:'ptr_split_app'}]};
    const turn=turns.find(t=>t.id===args?.[0])!;
    if(sql.startsWith('SELECT execution_id'))return {rows:turn.state==='completed'?[{execution_id:'synthetic-execution'}]:[],rowCount:turn.state==='completed'?1:0};
    return {rows:[{state:turn.state,assistants:turn.state==='completed'?1:0,outbox:turn.state==='pending'?1:0}]};
  },end:async()=>undefined} as unknown as Pool;
  let paidReads=0;const llm={query:async(sql:string,args?:string[][])=>{
    if(sql.startsWith('SELECT current_database'))return {rows:[{db:'ptr_split_research',role:'ptr_split_llm'}]};
    if(sql.includes('llm.ptr_provider_requests'))return {rows:[{total:String(paidReads++===0?0:providerRowsAfter),embeddings:'0',committed:'0'}]};
    return {rows:[{count:args?.[0]?.length??0}]};
  },end:async()=>undefined} as unknown as Pool;
  const fake:typeof fetch=async(input,options)=>{
    const url=new URL(String(input)),headers=new Headers(options?.headers);const actor=headers.get('X-PTR-Owner')??'';let body:unknown={};let status=200;
    if(url.pathname==='/metrics')return new Response(`vllm:request_success_total ${successes}\nvllm:num_requests_running 0\nvllm:num_requests_waiting 0`);
    if(url.pathname==='/api/personas'){if(!headers.has('Authorization'))return new Response('{}',{status:403});firstOwner=actor;body={personas:[{personId:'synthetic-published-person',reviewStatus:'human_reviewed',language:'ko'}]};}
    else if(url.pathname==='/api/sessions'){if(paused)return new Response('{}',{status:503});body={session:{id:`synthetic-session-${++sessions}`}};}
    else if(url.pathname.endsWith('/turns')){const data=JSON.parse(String(options?.body)) as {clientRequestId:string};let turn=turns.find(t=>t.client===data.clientRequestId);if(!turn){turn={id:`synthetic-turn-${turns.length}`,client:data.clientRequestId,state:paused?'pending':'completed'};turns.push(turn);if(!paused)successes++;}body={turn};}
    else if(url.pathname.includes('/api/turns/')){const id=url.pathname.split('/')[3],turn=turns.find(t=>t.id===id)!;if(actor!==firstOwner)status=404;else if(url.pathname.endsWith('/cancel')){turn.state='cancelled';body={cancelled:true};}else body={turn:{...turn,...(turn.state==='completed'?{reply:{status:'answered',content:'synthetic reply only',evidence:[],limitations:['RETRIEVAL_OFF','UNVERIFIED_MODEL_RESPONSE',replyText('limitation_unverified_model','ko'),replyText('limitation_posted_date','ko')]}}:{})}};}
    return new Response(JSON.stringify(body),{status});
  };
  const report=await operationalSmoke(operationalConfig(env,true,env.PTR_OPERATIONAL_OWNER_NONCE),{app,llm,fetch:fake,verifyOwnership:async()=>undefined,persist:async(_path,body)=>{artifacts.push(body);},delay:async()=>undefined,parentSignal:async(phase,requestNonce)=>{if(phase==='worker-paused'){sessionCountAtPause=sessions;paused=true;}if(phase==='worker-resumed'){paused=false;for(const t of turns)if(t.state==='pending'){t.state='completed';successes++;}}return {ownerNonce:env.PTR_OPERATIONAL_OWNER_NONCE,phase,requestNonce};}});
  return {report,turns,artifacts,sessionCountAtPause,sessions};
}
it('runs the complete synthetic protocol with exactly-once ACK, owner denial, idempotence and staged recovery',async()=>{
  const {report,turns,artifacts,sessionCountAtPause,sessions}=await syntheticProtocol();
  expect(sessionCountAtPause).toBe(3);expect(sessions).toBe(3);
  expect(report).toMatchObject({passed:true,localDistinctTurnSubmissions:3,modelCallCreditsReserved:9,paid:{embeddingRowsDelta:0,committedMicrousdDelta:0},nativeCounters:{successDelta:2,admissions:null,errorDelta:null}});
  expect(turns).toHaveLength(3);expect((report.stages as unknown[])).toHaveLength(4);expect(JSON.stringify(artifacts)).not.toMatch(/synthetic-published-person|synthetic reply only|synthetic-turn-/);
});

it('rejects every new auxiliary provider row even when zero-cost and non-embedding',async()=>{
  await expect(syntheticProtocol(1)).rejects.toThrow('RAG_OFF_AUXILIARY_SUBMISSION');
});
it('rejects malformed/nonfinite used metrics, never silently drops a bad label sample',()=>{
  const good='vllm:request_success_total{finish_reason="stop"} 3\nvllm:num_requests_running 0\nvllm:num_requests_waiting 0';
  for(const family of ['request_success_total','request_failure_total','num_requests_running','num_requests_waiting','prompt_tokens_total','generation_tokens_total'])
    for(const bad of ['NaN','+Inf','-Inf','1e999','garbage','-1','1 2 3'])expect(()=>parseNativeMetrics(`${good}\nvllm:${family}{model_name="synthetic"} ${bad}`)).toThrow('INVALID_NATIVE_METRIC');
  expect(()=>parseNativeMetrics(`${good}\nvllm:request_success_total{broken} 2`)).toThrow('INVALID_NATIVE_METRIC');
  expect(parseNativeMetrics(`${good}\n# ignored comment\nvllm:time_to_first_token_seconds_bucket{le="+Inf"} NaN`)).toMatchObject({successes:3});
});
it('forbids a fourth distinct turn and proves 3 bounded model attempts with no gateway or SDK retry',()=>{
  expect(()=>new AdmissionBudget(4)).toThrow('DISTINCT_TURN_CAP');
  const policy={qualificationCallCap:12,providerAdmissionHardCap:null,maxOutputTokens:512,primaryOnly:true,automaticRetries:0,maxModelAttemptsPerTurn:3,gatewayRetries:0};
  expect(validateModelPolicy(policy,12,512)).toBe(true);
  for(const patch of [{maxModelAttemptsPerTurn:4},{gatewayRetries:1},{automaticRetries:1},{maxModelAttemptsPerTurn:undefined}])expect(()=>validateModelPolicy({...policy,...patch},12,512)).toThrow('DEPLOYMENT_MODEL_POLICY_PROOF_REQUIRED');
});

it('accepts only the native benign RAG-off disclosures (or explicitly synthetic empty fixture)',()=>{
  for(const language of ['ko','en']){
    const expected=['RETRIEVAL_OFF','UNVERIFIED_MODEL_RESPONSE',replyText('limitation_unverified_model',language),replyText('limitation_posted_date',language)];
    expect(validRagOffLimitations(expected,language)).toBe(true);expect(validRagOffLimitations([...expected].reverse(),language)).toBe(true);
    for(const extra of ['INVALID_MODEL_EVIDENCE','GUARDRAILS_INPUT_UNAVAILABLE','AGENT_TOOL_UNAVAILABLE','MODEL_FALLBACK','arbitrary limitation'])expect(validRagOffLimitations([...expected,extra],language)).toBe(false);
    expect(validRagOffLimitations(expected.slice(1),language)).toBe(false);expect(validRagOffLimitations([...expected,expected[0]],language)).toBe(false);expect(validRagOffLimitations(expected,language==='ko'?'en':'ko')).toBe(false);
  }
  expect(validRagOffLimitations([],'ko',true)).toBe(true);expect(validRagOffLimitations([],'ko')).toBe(false);expect(validRagOffLimitations('RETRIEVAL_OFF','ko')).toBe(false);
});
