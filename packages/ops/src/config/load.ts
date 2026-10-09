import type { EnvRole } from '../env-registry';
import { apiSchema } from './api';
import { blank, demoScaling, envProblems, issues, withAliases, type Problem } from './common';
import { dispatcherSchema } from './dispatcher';
import { gatewaySchema, upstreamsFilePool } from './gateway';
import { webSchemaProblems } from './web';
import { workerSchema } from './worker';

export interface ConfigReport {
  role:EnvRole;
  /** PTR_DEMO_SCALING=1: demo keys allowed and the production value rules (step 6) skipped, except an explicit provider for api/worker. */
  demo:boolean;
  errors:Problem[];warnings:Problem[];
  /** Production gateway: the single pool of PTR_GATEWAY_UPSTREAMS_FILE (its name is the served model). */
  pool?:string;
}
export class ConfigError extends Error {
  constructor(readonly report:ConfigReport) {super('config_invalid');this.name='ConfigError';}
}
/**
 * Step 6 of : the role's production keys (formats and cross rules). With PTR_DEMO_SCALING=1 they are
 * skipped, but api and worker still need an explicit provider, so a missing PTR_CHAT_PROVIDER never falls back to the
 * fake model unnoticed (D25).
 */
export function roleProblems(role:EnvRole,env:NodeJS.ProcessEnv,cwd=process.cwd()):Problem[] {
  if(demoScaling(env)) return (role==='api'||role==='worker')&&blank(env.PTR_CHAT_PROVIDER)?[{key:'PTR_CHAT_PROVIDER',rule:'missing'}]:[];
  const normalized=withAliases(env);
  if(role==='web') return webSchemaProblems(normalized);
  const schema=role==='api'?apiSchema(cwd):role==='worker'?workerSchema(cwd):role==='dispatcher'?dispatcherSchema():gatewaySchema(cwd);
  return issues(schema.safeParse(normalized));
}
/** All steps for one role; nothing is printed. */
export function checkRole(role:EnvRole,env:NodeJS.ProcessEnv,cwd=process.cwd()):ConfigReport {
  const demo=demoScaling(env), shared=envProblems(env);
  const errors=[...shared.errors,...roleProblems(role,env,cwd)];
  // D10: the harness token (demo layer) has the token length and never doubles as the production token; checked with
  // the switch on as well (createApiApplication refuses both too).
  const harness=env.PTR_API_SYNTHETIC_TOKEN;
  if(role==='api'&&harness!==undefined&&!(harness.length>=24&&harness.length<=512)) errors.push({key:'PTR_API_SYNTHETIC_TOKEN',rule:'token_length'});
  else if(role==='api'&&!blank(harness)&&harness===env.PTR_API_TOKEN) errors.push({key:'PTR_API_SYNTHETIC_TOKEN',rule:'synthetic_token_reuse'});
  const report:ConfigReport={role,demo,errors,warnings:shared.warnings};
  if(role==='gateway'&&!demo&&!errors.length) {
    const result=upstreamsFilePool(env.PTR_GATEWAY_UPSTREAMS_FILE!,cwd);
    if('pool' in result) report.pool=result.pool;
  }
  return report;
}
/**
 * Called first by every entry point. Warnings and errors are one JSON line each (keys and rule ids only); any error
 * throws, so the process exits 1 before it opens a connection. Tests calling createRuntime(env) directly are not gated.
 */
export function loadConfig(role:EnvRole,env:NodeJS.ProcessEnv=process.env,write:(line:string)=>void=line=>process.stderr.write(`${line}\n`)):ConfigReport {
  const report=checkRole(role,env);
  if(report.warnings.length) write(JSON.stringify({event:'config_warning',role,problems:report.warnings}));
  if(report.errors.length) {
    write(JSON.stringify({event:'config_invalid',role,problems:report.errors}));
    throw new ConfigError(report);
  }
  return report;
}
