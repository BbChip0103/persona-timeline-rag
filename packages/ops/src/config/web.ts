import { z } from 'zod';

/**
 * Web configuration , imported by the web as `@ptr/ops/web` and validated once by
 * apps/web/instrumentation.ts `register()`; `pnpm ops:check-env --roles web` runs the same rules. Dependency-free (zod
 * only) so the Next.js bundle does not pull in the database, Redis or provider packages. Problems name the key and a
 * rule id, never a value.
 */
export interface ConfigProblem {key:string;rule:string}
/** The proxy's only API target (D7). The synthetic UI (e2e) has its own port, like HOST in auth.ts. */
export const apiUrl=(env:NodeJS.ProcessEnv=process.env)=>env.PTR_SYNTHETIC_UI==='1'?'http://127.0.0.1:56449':'http://127.0.0.1:56441';
export const blank=(value:string|undefined)=>!value?.trim();
const REQUIRED=['PTR_API_TOKEN','PTR_SESSION_SECRET','PTR_UI_PASSWORD'] as const;
const schema=z.object({
  PTR_API_TOKEN:z.string().refine(value=>blank(value)||(value.length>=24&&value.length<=512),'token_length').optional(),
  PTR_SESSION_SECRET:z.string().refine(value=>blank(value)||value.length>=32,'secret_length').optional(),
  PTR_UI_PASSWORD:z.string().optional(),
}).superRefine((env,ctx)=>{for(const key of REQUIRED) if(blank(env[key])) ctx.addIssue({code:'custom',path:[key],message:'missing'});});
/** PTR_API_TOKEN, PTR_SESSION_SECRET, PTR_UI_PASSWORD. */
export function webSchemaProblems(env:NodeJS.ProcessEnv):ConfigProblem[] {
  const result=schema.safeParse(env);
  return result.success?[]:result.error.issues.map(issue=>({key:String(issue.path[0]),rule:issue.message}));
}
/** PTR_API_URL is no longer read: the constant is used. The same value is a warning, a different one an error (D7). */
export function apiUrlProblem(env:NodeJS.ProcessEnv):{level:'error'|'warning';problem:ConfigProblem}|undefined {
  if(env.PTR_API_URL===undefined) return;
  return env.PTR_API_URL===apiUrl(env)?{level:'warning',problem:{key:'PTR_API_URL',rule:'constant_ignored'}}
    :{level:'error',problem:{key:'PTR_API_URL',rule:'api_url_constant'}};
}
export function checkWebConfig(env:NodeJS.ProcessEnv):{errors:ConfigProblem[];warnings:ConfigProblem[]} {
  const url=apiUrlProblem(env);
  return {errors:[...(url?.level==='error'?[url.problem]:[]),...webSchemaProblems(env)],warnings:url?.level==='warning'?[url.problem]:[]};
}
/** Startup check; skipped while `next build` runs (no secrets there). Throws after one `config_invalid` line. */
export function registerWebConfig(env:NodeJS.ProcessEnv=process.env,write:(line:string)=>void=line=>console.error(line)):void {
  if(env.NEXT_PHASE==='phase-production-build') return;
  const {errors,warnings}=checkWebConfig(env);
  if(warnings.length) write(JSON.stringify({event:'config_warning',role:'web',problems:warnings}));
  if(errors.length) {
    write(JSON.stringify({event:'config_invalid',role:'web',problems:errors}));
    throw new Error('config_invalid');
  }
}
