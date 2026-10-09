import { SAFETY_CATEGORIES } from '@ptr/core';

/**
 * Every environment variable name the code, harness, infra files and the example file read .
 * - P: production. `roles` read it; the role schemas (config/*.ts) validate it.
 * - D: demo/harness layer read by the roles; refused unless PTR_DEMO_SCALING=1 (ranges stay in the existing parsers).
 * - H: tests, harness and research scripts outside the role schemas (ignored by the gate).
 * - R: derived or removed: `rRule` says what the gate does.
 * - I: infra and tools only (Compose, psql, redis-cli); the roles never read them.
 * - S: system.
 * A scan test (test/env-scan.test.ts) fails when any file reads a name that is not listed here.
 */
export type EnvRole='api'|'worker'|'dispatcher'|'gateway'|'web';
export const ROLES:readonly EnvRole[]=['api','worker','dispatcher','gateway','web'];
export type EnvClass='P'|'D'|'H'|'R'|'I'|'S';
/** removed: startup error. api_url: D7. alias: a renamed key (D6). unused: from the old example file, warn and ignore. */
export type RRule='removed'|'api_url'|'alias'|'unused';
export interface EnvEntry {class:EnvClass;roles?:readonly EnvRole[];aliasOf?:string;rRule?:RRule}

const P=(...roles:EnvRole[]):EnvEntry=>({class:'P',roles});
const D:EnvEntry={class:'D'}, H:EnvEntry={class:'H'}, I:EnvEntry={class:'I'}, S:EnvEntry={class:'S'};
const R=(rRule:RRule,aliasOf?:string):EnvEntry=>({class:'R',rRule,...(aliasOf?{aliasOf}:{})});
const each=(names:readonly string[],entry:EnvEntry)=>Object.fromEntries(names.map(name=>[name,entry]));

const GATEWAY_DEMO=['ADVERTISE_URL','AFFINITY','AFFINITY_MIN_TOKENS','AFFINITY_SLACK','ALLOW','BREAKER_COOLDOWN_MS','BREAKER_FAILURES',
  'BREAKER_PROBE_TIMEOUT_MS','BREAKER_TIMEOUTS','BYTES_PER_TOKEN','DISCOVERY','DRR_QUANTUM_TOKENS','ENGINE_KV_HIGH','ENGINE_WAITING_MAX',
  'FAILOVER_MAX_PER_MINUTE','FAILOVER_ON_CLOSE','FAIRNESS','ID','KV_OVERCOMMIT','LOOKAHEAD','MAX_CONCURRENCY','MAX_QUEUE','METRICS_INTERVAL_MS',
  'METRICS_TIMEOUT_MS','POOL','PORT','PREFIX_TTL_MS','PRIMARY_ATTEMPTS','PRIMARY_HEADERS_TIMEOUT_MS','QUEUE_TIMEOUT_MS','REGISTRY','REGISTRY_GRACE_MS',
  'REGISTRY_POLL_MS','REJECT_SATURATED','RESET_RETRIES','RETRY_MIN_REMAINING_MS','ROUTE_LOG_SAMPLE','ROUTING','SHUTDOWN_MS','SLOW_START_MS',
  'STARVATION_MS','STRUCTURED','TTFT_PENALTY_MS','UPSTREAM','UPSTREAM_ALLOW','UPSTREAM_TIMEOUT_MS','URL','URLS'].map(name=>`PTR_GATEWAY_${name}`);

export const ENV_REGISTRY:Readonly<Record<string,EnvEntry>>={
  // P: the production profile (19).
  DATABASE_URL:P('api','worker','dispatcher','gateway'),
  PTR_REDIS_URL:P('api','worker','dispatcher'),
  PTR_CHAT_PROVIDER:P('api','worker'),
  PTR_MODEL:P('api','worker'),
  PTR_API_TOKEN:P('api','web'),
  PTR_SESSION_SECRET:P('web'),
  PTR_UI_PASSWORD:P('web'),
  PTR_GATEWAY_TOKEN:P('gateway','api','worker'),
  PTR_GATEWAY_UPSTREAMS_FILE:P('gateway'),
  PTR_GATEWAY_FAILOVER:P('gateway'),
  PTR_WORKER_CONCURRENCY:P('worker'),
  PTR_PERSONAS_FILE:P('api','worker'),
  PTR_AUTHORED_PERSONAS_FILE:P('api','worker'),
  PTR_INTENT_CLASSIFIER:P('api','worker'),
  PTR_SAFETY_FILTER:P('api','worker'),
  GOAL1_LIVE_ENABLED:P('api','worker','gateway'),
  GOAL1_ALLOW_EXTERNAL_DATA:P('api','worker','gateway'),
  OPENROUTER_API_KEY:P('api','worker','gateway'),
  PTR_DEMO_SCALING:P('api','worker','dispatcher','gateway','web'),
  // D: demo and harness layer (89).
  ...each(GATEWAY_DEMO,D),
  ...each(['PTR_CAPACITY_CONTROLLER','PTR_CAPACITY_FLOOR','PTR_CAPACITY_HEADROOM','PTR_CAPACITY_INTERVAL_MS','PTR_CAPACITY_POOL'],D),
  ...each(['PTR_UPSTREAM_DRAIN_MAX_MS','PTR_UPSTREAM_DRAIN_SETTLE_MS','PTR_UPSTREAM_HEALTH_TIMEOUT_MS','PTR_UPSTREAM_HEARTBEAT_MS','PTR_UPSTREAM_TTL_MS'],D),
  ...each(['PTR_REGISTRY_PREFIX','PTR_SELFHOSTED_BASE_URL','PTR_SELFHOSTED_MODEL','PTR_SELFHOSTED_STRUCTURED'],D),
  ...each(['PTR_JEV_MIN_CONFIDENCE','PTR_JEV_MODEL','PTR_JEV_RESERVED_CALL_FRACTION','PTR_JEV_TIMEOUT_MS','PTR_SAFETY_TIMEOUT_MS'],D),
  // Dynamic names: PTR_SAFETY_THRESHOLD_<CATEGORY> (apps/api/src/runtime.ts).
  ...each(SAFETY_CATEGORIES.map(category=>`PTR_SAFETY_THRESHOLD_${category.toUpperCase()}`),D),
  ...each(['PTR_LEASE_MS','PTR_LEASE_RECONCILE_INTERVAL_MS','PTR_DISPATCH_GRACE_MS','PTR_DISPATCH_INTERVAL_MS','PTR_MAX_ATTEMPTS','PTR_TURN_MAX_QUEUE_MS',
    'PTR_QUEUE_MAX_DEPTH','PTR_DB_POOL_MAX','PTR_TURN_QUEUE','PTR_EVENTS_NAMESPACE','PTR_WORKER_ID','PTR_WORKER_REPLICAS_HINT','PTR_API_PORT',
    'PTR_METRICS_PORT','PTR_API_SYNTHETIC_TOKEN'],D),
  // H: tests, harness and research scripts.
  ...each(['RUN_REDIS_TESTS','RUN_STORAGE_DB_TESTS','GOAL1_TEST_DATABASE_URL','GOAL1_TEST_BUDGET_DB','PTR_LOADTEST_DATABASE_URL','PTR_LOADTEST_DB_PASSWORD',
    'PTR_TEST_OPENROUTER_REDIRECT','PTR_FAKE_LATENCY','PTR_SYNTHETIC_UI','PTR_DATABASE_URL','PTR_IMAGE_READ_ONLY','PTR_EXTERNAL_IMAGE_COOKIE_FILE',
    'PTR_PERSONA_BASELINE_FILE','PTR_PERSONA_PUBLISH_LOG','PTR_PERSONA_SOURCES_FILE','PTR_RESEARCH_SOURCES_FILE','PTR_RESEARCH_SPLIT_FILE','PTR_GPU_ROOT',
    'HF_HUB_ENABLE_HF_TRANSFER','PTR_EVAL_TARGETS_FILE'],H),
  // R: derived, renamed or removed.
  PTR_EXECUTION:R('removed'),
  PTR_API_URL:R('api_url'),
  GOAL1_DATABASE_URL:R('alias','DATABASE_URL'),
  GOAL1_TEXT_MODEL:R('alias','PTR_MODEL'),
  TEXT_MODEL:R('alias','PTR_MODEL'),
  ...each(['GOAL1_BUDGET_USD','PTR_EMBEDDING_MODEL','REPLICATE_API_TOKEN','INSTAGRAM_DATASET_FOLDER_URL'],R('unused')),
  // I: infra and tools.
  ...each(['PTR_DB_PASSWORD','PTR_REDIS_PASSWORD','POSTGRES_PASSWORD','POSTGRES_DB','POSTGRES_USER','PGPASSWORD','REDISCLI_AUTH','PTR_UID','PTR_GID'],I),
  // S: system.
  ...each(['HOME','PATH','NODE_ENV','VIRTUAL_ENV','NEXT_PHASE'],S),
};
/** Names the gate refuses when the registry does not know them (step 1). */
export const GATED_PREFIX=/^(?:PTR|GOAL1)_/;
export const productionKeys=():string[]=>Object.keys(ENV_REGISTRY).filter(name=>ENV_REGISTRY[name]!.class==='P');
