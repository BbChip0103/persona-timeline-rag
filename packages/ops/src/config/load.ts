import type { EnvRole } from '../env-registry';
import { FrameworkConfigError, loadFrameworkConfig } from '../framework-config';
import { envProblems, type Problem } from './common';
import { webSchemaProblems } from './web';

export interface ConfigReport {role:EnvRole;errors:Problem[];warnings:Problem[]}
export class ConfigError extends Error {
  constructor(readonly report:ConfigReport) {super('config_invalid');this.name='ConfigError';}
}

/** One production validator: operator tooling calls the same framework loader as API/worker startup. */
export function roleProblems(role:EnvRole,env:NodeJS.ProcessEnv):Problem[] {
  if(role==='web') return webSchemaProblems(env);
  try {loadFrameworkConfig(role,env);return [];}
  catch(error) {return error instanceof FrameworkConfigError?[...error.problems]:[{key:role,rule:'validation_failed'}];}
}
export function checkRole(role:EnvRole,env:NodeJS.ProcessEnv):ConfigReport {
  const shared=envProblems(env);
  const unique=new Map([...shared.errors,...roleProblems(role,env)].map(problem=>[`${problem.key}:${problem.rule}`,problem]));
  return {role,errors:[...unique.values()],warnings:shared.warnings};
}
/** Operator-only reporting wrapper; production API/worker directly use loadFrameworkConfig. */
export function loadConfig(role:EnvRole,env:NodeJS.ProcessEnv=process.env,write:(line:string)=>void=line=>process.stderr.write(`${line}\n`)):ConfigReport {
  const report=checkRole(role,env);
  if(report.warnings.length)write(JSON.stringify({event:'config_warning',role,problems:report.warnings}));
  if(report.errors.length) {write(JSON.stringify({event:'config_invalid',role,problems:report.errors}));throw new ConfigError(report);}
  return report;
}
