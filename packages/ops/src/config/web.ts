import { z } from 'zod';

/**
 * Web configuration, imported by the web as `@ptr/ops/web` and validated once by
 * apps/web/instrumentation.ts `register()`; `pnpm ops:check-env --roles web` runs the same rules. Dependency-free (zod
 * only) so the Next.js bundle does not pull in the database, Redis or provider packages. Problems name the key and a
 * rule id, never a value.
 */
export interface ConfigProblem {key:string;rule:string}
/** The proxy target is fixed for local mode and explicitly pinned to a service in cluster mode. */
const clusterMode=(env:NodeJS.ProcessEnv)=>env.PTR_NETWORK_MODE==='cluster'&&!!env.KUBERNETES_SERVICE_HOST;
const dnsLabel=/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const clusterApiHost=(namespace:string)=>`ptr-api.${namespace}.svc`;
const clusterApiUrl=(env:NodeJS.ProcessEnv):string|undefined=>{
  const raw=env.PTR_CLUSTER_API_URL, namespace=env.PTR_CLUSTER_API_NAMESPACE;
  if(!raw||!namespace||!dnsLabel.test(namespace))return;
  try {
    const url=new URL(raw);
    const host=clusterApiHost(namespace);
    if(url.protocol!=='http:'||(url.hostname!==host&&url.hostname!==`${host}.cluster.local`)||!url.port||url.username||url.password||url.pathname!=='/'||url.search||url.hash)return;
    return `${url.protocol}//${url.host}`;
  }catch{return;}
};
export const apiUrl=(env:NodeJS.ProcessEnv=process.env)=>{
  if(clusterMode(env)){
    const target=clusterApiUrl(env);
    if(!target)throw new Error('INVALID_CLUSTER_API_URL');
    return target;
  }
  return env.PTR_SYNTHETIC_UI==='1'?'http://127.0.0.1:56449':'http://127.0.0.1:56441';
};
export const blank=(value:string|undefined)=>!value?.trim();
const REQUIRED=['PTR_API_TOKEN','PTR_SESSION_SECRET','PTR_UI_PASSWORD'] as const;
const schema=z.object({
  PTR_API_TOKEN:z.string().refine(value=>blank(value)||(value.length>=24&&value.length<=512),'token_length').optional(),
  PTR_SESSION_SECRET:z.string().refine(value=>blank(value)||value.length>=32,'secret_length').optional(),
  // The login route answers AUTH_UNAVAILABLE below 12 characters (app/api/auth/route.ts); startup says so first.
  PTR_UI_PASSWORD:z.string().refine(value=>blank(value)||value.length>=12,'password_length').optional(),
}).superRefine((env,ctx)=>{for(const key of REQUIRED) if(blank(env[key])) ctx.addIssue({code:'custom',path:[key],message:'missing'});});
/** PTR_API_TOKEN, PTR_SESSION_SECRET, PTR_UI_PASSWORD. */
export function webSchemaProblems(env:NodeJS.ProcessEnv):ConfigProblem[] {
  const result=schema.safeParse(env);
  return result.success?[]:result.error.issues.map(issue=>({key:String(issue.path[0]),rule:issue.message}));
}
/** PTR_API_URL is no longer read: the constant is used. The same value is a warning, a different one an error. */
export function apiUrlProblem(env:NodeJS.ProcessEnv):{level:'error'|'warning';problem:ConfigProblem}|undefined {
  if(env.PTR_API_URL===undefined) return;
  return env.PTR_API_URL===(clusterMode(env)?clusterApiUrl(env):apiUrl(env))?{level:'warning',problem:{key:'PTR_API_URL',rule:'constant_ignored'}}
    :{level:'error',problem:{key:'PTR_API_URL',rule:'api_url_constant'}};
}
export function checkWebConfig(env:NodeJS.ProcessEnv):{errors:ConfigProblem[];warnings:ConfigProblem[]} {
  const url=apiUrlProblem(env);
  return {errors:[...(url?.level==='error'?[url.problem]:[]),...(clusterMode(env)&&!clusterApiUrl(env)?[{key:'PTR_CLUSTER_API_URL',rule:'cluster_service_required'}]:[]),...webSchemaProblems(env)],warnings:url?.level==='warning'?[url.problem]:[]};
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
