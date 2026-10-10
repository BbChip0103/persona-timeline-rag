import { isAbsolute } from 'node:path';
import { ENV_REGISTRY, GATED_PREFIX } from '../env-registry';
import { apiUrlProblem } from './web';

/** A key and stable rule code only, never rejected values, paths or credential-bearing URLs. */
export interface Problem {key:string;rule:string}
export interface Problems {errors:Problem[];warnings:Problem[]}

export function envProblems(env:NodeJS.ProcessEnv):Problems {
  const errors:Problem[]=[],warnings:Problem[]=[];
  for(const key of Object.keys(env).filter(name=>env[name]!==undefined)) {
    const entry=ENV_REGISTRY[key];
    if(/^PTR_(?:GATEWAY|CAPACITY|UPSTREAM|REGISTRY)_/.test(key)||entry?.rRule==='removed') {
      errors.push({key,rule:'retired_setting'});continue;
    }
    if(GATED_PREFIX.test(key)&&!entry) {errors.push({key,rule:'unknown_key'});continue;}
    if(entry?.rRule==='api_url') {
      const problem=apiUrlProblem(env)!;(problem.level==='error'?errors:warnings).push(problem.problem);
    }
    if(entry?.rRule==='alias'&&env[entry.aliasOf!]===undefined)warnings.push({key,rule:'renamed_key'});
  }
  return {errors,warnings};
}

/** Operator-only warning: deployment mounts must preserve explicit persona paths. Nothing is read here. */
export function composeProblems(env:NodeJS.ProcessEnv):Problem[] {
  return ['PTR_PERSONAS_FILE','PTR_AUTHORED_PERSONAS_FILE'].filter(key=>env[key]&&isAbsolute(env[key]!))
    .map(key=>({key,rule:'path_not_repo_relative'}));
}
