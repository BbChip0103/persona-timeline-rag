import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
// The registry subpath: the gateway imports this package and must never load BullMQ (apps/gateway/tests/imports.test.ts).
import { assertLocalRedisUrl } from '@ptr/messaging/registry';
import { isAllowedTextModel } from '@ptr/providers';
import { assertLocalDatabaseUrl } from '@ptr/storage';
import { ENV_REGISTRY, GATED_PREFIX } from '../env-registry';
import { apiUrlProblem, blank } from './web';

/** A problem names the key and a rule id, never a value (values can be secrets or URLs with passwords). */
export interface Problem {key:string;rule:string}
export interface Problems {errors:Problem[];warnings:Problem[]}
export const demoScaling=(env:NodeJS.ProcessEnv)=>env.PTR_DEMO_SCALING==='1';

/**
 * Environment-wide steps of , the same for every role: 1 unknown PTR_/GOAL1_ names, 3 demo keys without the
 * switch, 4 R rules, 5 aliases. Step 2 (other roles' keys, H/I/S) is "ignore", so nothing is reported for them.
 */
export function envProblems(env:NodeJS.ProcessEnv):Problems {
  const names=Object.keys(env).filter(name=>env[name]!==undefined);
  const demo=demoScaling(env);
  const unknown=names.filter(name=>GATED_PREFIX.test(name)&&!ENV_REGISTRY[name]).map(key=>({key,rule:'unknown_key'}));
  const switchValue=env.PTR_DEMO_SCALING!==undefined&&!['0','1'].includes(env.PTR_DEMO_SCALING)?[{key:'PTR_DEMO_SCALING',rule:'invalid_value'}]:[];
  const demoKeys=demo?[]:names.filter(name=>ENV_REGISTRY[name]?.class==='D').map(key=>({key,rule:'demo_key'}));
  const errors:Problem[]=[...unknown,...switchValue,...demoKeys], warnings:Problem[]=[], aliases:Problem[]=[];
  for(const key of names) {
    const entry=ENV_REGISTRY[key];if(entry?.class!=='R') continue;
    if(entry.rRule==='removed') errors.push({key,rule:'removed_key'});
    else if(entry.rRule==='unused') warnings.push({key,rule:'unused_key'});
    else if(entry.rRule==='api_url') {const url=apiUrlProblem(env)!;(url.level==='error'?errors:warnings).push(url.problem);}
    else if(entry.rRule==='alias') {
      // Same value under the new name (or the new name unset): a warning for one release (D6). Different: an error.
      const target=env[entry.aliasOf!]??aliasTargets(env)[entry.aliasOf!];
      aliases.push({key,rule:target===env[key]?'renamed_key':'alias_conflict'});
    }
  }
  return {errors:[...errors,...aliases.filter(problem=>problem.rule==='alias_conflict')],warnings:[...warnings,...aliases.filter(problem=>problem.rule==='renamed_key')]};
}
/** The value each production name gets from its old names when unset (same precedence as the code). */
function aliasTargets(env:NodeJS.ProcessEnv):Record<string,string|undefined> {
  return {DATABASE_URL:env.GOAL1_DATABASE_URL,PTR_MODEL:env.GOAL1_TEXT_MODEL??env.TEXT_MODEL};
}
/** The environment the role schemas see: production names filled from their aliases. */
export function withAliases(env:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
  const targets=aliasTargets(env), result={...env};
  for(const [key,value] of Object.entries(targets)) if(result[key]===undefined&&value!==undefined) result[key]=value;
  return result;
}

// Value rules shared by the role schemas .
export { blank };
const passes=(check:(value:string)=>unknown)=>(value:string)=>{try {check(value);return true;} catch {return false;}};
/** A blank value of a required key is reported once, as `missing` (see required()), not also as a format error. */
export const unlessBlank=(rule:string,check:(value:string)=>boolean)=>z.string().refine(value=>blank(value)||check(value),rule).optional();
export const databaseUrl=unlessBlank('database_url_guard',passes(assertLocalDatabaseUrl));
/** The loopback guard, then the ACL app user `ptr` (the default user is off). */
export const redisUrl=z.string().superRefine((value,ctx)=>{
  if(blank(value)) return;
  const rule=!passes(assertLocalRedisUrl)(value)?'redis_url_guard':new URL(value).username!=='ptr'?'redis_username_ptr':undefined;
  if(rule) ctx.addIssue({code:'custom',message:rule});
}).optional();
export const token=unlessBlank('token_length',value=>value.length>=24&&value.length<=512);
/** Optional keys: a blank value is invalid too (the code would refuse it). */
export const oneOf=(values:readonly string[])=>z.string().refine(value=>values.includes(value),'invalid_value').optional();
/** A regular file (a blank value resolves to the current directory, which is not one). */
export const existingFile=(cwd:string)=>z.string().refine(path=>!blank(path)&&statSync(resolve(cwd,path),{throwIfNoEntry:false})?.isFile()===true,'file_missing').optional();
/** OpenRouter chat models: the providers allowlist itself (nothing is constructed or connected). */
export const textModel=unlessBlank('model_allowlist',isAllowedTextModel);
export type Refinement=z.RefinementCtx;
export const report=(ctx:Refinement,key:string,rule:string)=>ctx.addIssue({code:'custom',path:[key],message:rule});
/** OpenRouter (chat, Jev helpers, failover) needs all three live keys; the client would fail with LIVE_DISABLED. */
export function liveTrio(env:NodeJS.ProcessEnv,ctx:Refinement):void {
  if(env.GOAL1_LIVE_ENABLED!=='true') report(ctx,'GOAL1_LIVE_ENABLED','live_trio');
  if(env.GOAL1_ALLOW_EXTERNAL_DATA!=='true') report(ctx,'GOAL1_ALLOW_EXTERNAL_DATA','live_trio');
  if(blank(env.OPENROUTER_API_KEY)) report(ctx,'OPENROUTER_API_KEY','live_trio');
}
export function required(env:NodeJS.ProcessEnv,ctx:Refinement,...keys:string[]):void {
  for(const key of keys) if(blank(env[key])) report(ctx,key,'missing');
}
export function issues(result:z.SafeParseReturnType<unknown,unknown>):Problem[] {
  return result.success?[]:result.error.issues.map(issue=>({key:String(issue.path[0]),rule:issue.message}));
}
/**
 * Compose runs the roles from the repo root inside the container : only repo-relative persona and upstreams
 * file paths resolve to the same file there (infra/compose.app.yml mounts the upstreams file at the same relative path).
 * Reported by `ops:check-env` only.
 */
export function composeProblems(env:NodeJS.ProcessEnv):Problem[] {
  return ['PTR_PERSONAS_FILE','PTR_AUTHORED_PERSONAS_FILE','PTR_GATEWAY_UPSTREAMS_FILE'].filter(key=>env[key]&&isAbsolute(env[key]!)).map(key=>({key,rule:'path_not_repo_relative'}));
}
