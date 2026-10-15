import { z } from 'zod';
import { assertLocalDatabaseUrl } from '@ptr/storage';
import { assertLocalRedisUrl } from '@ptr/messaging';
import { validateLangfuseConfig, type FrameworkTelemetryConfig } from './langfuse';

export type FrameworkRole='api'|'worker';
const token=z.string().min(24).max(512);
// Empty unused placeholders are absent; required/provider-specific checks remain strict.
const optional=<T extends z.ZodTypeAny>(value:T)=>z.preprocess(input=>input===''?undefined:input,value.optional());
const integer=(fallback:number,min:number,max:number)=>z.coerce.number().int().min(min).max(max).default(fallback);
const schema=z.object({
  DATABASE_URL:z.string().min(1),PTR_REDIS_URL:z.string().min(1),PTR_CHAT_PROVIDER:z.enum(['fake','local']),
  PTR_PERSONAS_FILE:z.string().min(1),PTR_API_TOKEN:token,PTR_API_SYNTHETIC_TOKEN:optional(token),
  PTR_API_PORT:integer(56441,1024,65535),PTR_WORKER_CONCURRENCY:integer(32,1,1024),
  PTR_QUEUE_MAX_DEPTH:integer(256,1,100000),PTR_TURN_MAX_QUEUE_MS:integer(60000,1000,3600000),
  PTR_TURN_QUEUE:z.string().regex(/^[a-z0-9-]{1,40}$/).default('turns'),
  PTR_EVENTS_NAMESPACE:z.string().regex(/^[a-z0-9-]{1,40}$/).default('events'),
  PTR_LLM_LOCAL_BASE_URL:optional(z.string().url()),PTR_LLM_LOCAL_MODEL:optional(z.string().min(1)),PTR_LLM_LOCAL_API_KEY:optional(z.string().min(16).max(512)),
  PTR_MODEL:z.string().min(1).default('primary'),PTR_PAID_SPILLOVER:z.enum(['0','1']).default('0'),
  PTR_GUARDRAILS_URL:z.string().url().optional(),PTR_GUARDRAILS_TOKEN:z.string().min(16).optional(),
  PTR_GUARDRAILS_TIMEOUT_MS:integer(2500,50,10000),
  PTR_DB_POOL_MAX:integer(32,1,1024),PTR_MAX_ATTEMPTS:integer(3,1,10),
  PTR_QUEUE_LOCK_MS:integer(30000,300,600000),PTR_DISPATCH_GRACE_MS:integer(2000,0,600000),
  PTR_DISPATCH_INTERVAL_MS:integer(1000,50,60000),
  PTR_INTENT_CLASSIFIER:z.enum(['jev','off']).default('off'),PTR_SAFETY_FILTER:z.enum(['jev','off']).default('off'),
  PTR_JEV_MODEL:z.literal('typesafe/jev-1.13').default('typesafe/jev-1.13'),
  PTR_JEV_TIMEOUT_MS:integer(1500,50,10000),PTR_SAFETY_TIMEOUT_MS:integer(2500,50,10000),
  PTR_JEV_MIN_CONFIDENCE:z.coerce.number().gt(0).lte(1).default(0.6),
  PTR_LANGFUSE_ENABLED:z.enum(['0','1']).default('0'),PTR_ENVIRONMENT:z.enum(['development','test','production']).default('development'),

});

export class FrameworkConfigError extends Error {
  readonly code='FRAMEWORK_CONFIG_INVALID';
  constructor(readonly problems:readonly {key:string;rule:string}[]) {super('FRAMEWORK_CONFIG_INVALID');}
}

export function frameworkTelemetryConfig(env:NodeJS.ProcessEnv):FrameworkTelemetryConfig {
  return {enabled:env.PTR_LANGFUSE_ENABLED==='1',baseUrl:env.LANGFUSE_BASE_URL,
    publicKey:env.LANGFUSE_PUBLIC_KEY,secretKey:env.LANGFUSE_SECRET_KEY,
    environment:env.PTR_ENVIRONMENT??'development',release:env.PTR_RELEASE??'framework-migration',
    captureContent:env.PTR_LANGFUSE_CAPTURE_CONTENT==='1',allowInsecureLocal:env.PTR_LANGFUSE_LOCAL==='1',timeoutMs:2000};
}

/** Validation prints only keys/rule codes; never connection URLs or rejected values. */
export function loadFrameworkConfig(role:FrameworkRole,env:NodeJS.ProcessEnv=process.env) {
  if(env.DATABASE_URL&&env.GOAL1_DATABASE_URL&&env.DATABASE_URL!==env.GOAL1_DATABASE_URL)throw new FrameworkConfigError([{key:'DATABASE_URL',rule:'conflicting_alias'}]);
  const parsed=schema.safeParse({...env,DATABASE_URL:env.DATABASE_URL??env.GOAL1_DATABASE_URL});
  if(!parsed.success)throw new FrameworkConfigError(parsed.error.issues.map(issue=>({key:issue.path.join('.'),rule:issue.code})));
  const config=parsed.data;const problems:{key:string;rule:string}[]=[];
  for(const [key,value,guard] of [['DATABASE_URL',config.DATABASE_URL,assertLocalDatabaseUrl],['PTR_REDIS_URL',config.PTR_REDIS_URL,assertLocalRedisUrl]] as const) {
    try{guard(value);}catch{problems.push({key,rule:'isolated_target'});}
  }
  if(config.PTR_API_SYNTHETIC_TOKEN===config.PTR_API_TOKEN)problems.push({key:'PTR_API_SYNTHETIC_TOKEN',rule:'token_reuse'});
  for(const key of ['PTR_GUARDRAILS_URL','PTR_GUARDRAILS_TOKEN'] as const)if(!config[key])problems.push({key,rule:'required_validator'});
  if(config.PTR_CHAT_PROVIDER==='local') {
    for(const key of ['PTR_LLM_LOCAL_BASE_URL','PTR_LLM_LOCAL_MODEL','PTR_GUARDRAILS_URL','PTR_GUARDRAILS_TOKEN'] as const)
      if(!config[key])problems.push({key,rule:'required_for_local'});
  }
  // The split API only reports billable drafts; the Python worker owns paid gates and its ledger.
  const splitApi=role==='api'&&env.PTR_LLM_SERVICE_MODE==='split';
  if(!splitApi&&config.PTR_PAID_SPILLOVER==='1'&&(env.GOAL1_LIVE_ENABLED!=='true'||env.GOAL1_ALLOW_EXTERNAL_DATA!=='true'))problems.push({key:'GOAL1_LIVE_ENABLED',rule:'paid_transfer_not_enabled'});
  if(!splitApi&&config.PTR_CHAT_PROVIDER==='local'&&config.PTR_PAID_SPILLOVER==='1')problems.push({key:'PTR_PAID_SPILLOVER',rule:'local_has_no_spillover_ledger'});
  if(config.PTR_ENVIRONMENT==='production'&&(config.PTR_LANGFUSE_ENABLED!=='1'||!config.PTR_GUARDRAILS_URL||!config.PTR_GUARDRAILS_TOKEN))
    problems.push({key:'PTR_ENVIRONMENT',rule:'production_observability_and_validation_required'});
  if(config.PTR_INTENT_CLASSIFIER==='jev'||config.PTR_SAFETY_FILTER==='jev') {
    if(env.GOAL1_LIVE_ENABLED!=='true'||env.GOAL1_ALLOW_EXTERNAL_DATA!=='true'||!env.OPENROUTER_API_KEY)
      problems.push({key:'PTR_SAFETY_FILTER',rule:'paid_jev_not_enabled'});
  }
  for(const key of Object.keys(env))if(key.startsWith('PTR_GATEWAY_')||key.startsWith('PTR_CAPACITY_')||key.startsWith('PTR_LITELLM_')||key==='PTR_EXECUTION')
    problems.push({key,rule:'retired_setting'});
  if(['LANGSMITH_TRACING' ,'LANGCHAIN_TRACING_V2'].some(key=>env[key]==='true'||env[key]==='1'))
    problems.push({key:'LANGSMITH_TRACING',rule:'unapproved_external_trace'});
  try{validateLangfuseConfig(frameworkTelemetryConfig(env));}catch{problems.push({key:'PTR_LANGFUSE_ENABLED',rule:'invalid_selfhost_configuration'});}
  if(problems.length)throw new FrameworkConfigError(problems);
  return {role,...config};
}
