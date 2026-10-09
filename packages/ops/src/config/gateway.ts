import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { blank, databaseUrl, liveTrio, oneOf, required, token } from './common';

/**
 * The production gateway serves exactly one pool from PTR_GATEWAY_UPSTREAMS_FILE, whose name is the served model
 * . Entries are validated by the gateway itself at startup (sources.ts).
 */
export function upstreamsFilePool(path:string,cwd:string):{pool:string}|{rule:'file_missing'|'upstreams_file_invalid'|'upstreams_pool_count'} {
  let text:string;
  try {text=readFileSync(resolve(cwd,path),'utf8');} catch {return {rule:'file_missing'};}
  let pools:unknown;
  try {pools=(JSON.parse(text) as {pools?:unknown})?.pools;} catch {return {rule:'upstreams_file_invalid'};}
  if(!pools||typeof pools!=='object'||Array.isArray(pools)) return {rule:'upstreams_file_invalid'};
  const names=Object.keys(pools);
  return names.length===1?{pool:names[0]!}:{rule:'upstreams_pool_count'};
}
export const gatewaySchema=(cwd:string)=>z.object({
  PTR_GATEWAY_TOKEN:token,PTR_GATEWAY_FAILOVER:oneOf(['off','openrouter']),DATABASE_URL:databaseUrl,
  PTR_GATEWAY_UPSTREAMS_FILE:z.string().superRefine((path,ctx)=>{
    const result=upstreamsFilePool(path,cwd);if(!blank(path)&&'rule' in result) ctx.addIssue({code:'custom',message:result.rule});
  }).optional(),
}).catchall(z.string().optional()).superRefine((env,ctx)=>{
  required(env,ctx,'PTR_GATEWAY_TOKEN','PTR_GATEWAY_UPSTREAMS_FILE');
  // The OpenRouter failover secondary bills through the shared ledger (DATABASE_URL) and needs the live keys.
  if(env.PTR_GATEWAY_FAILOVER==='openrouter') {required(env,ctx,'DATABASE_URL');liveTrio(env,ctx);}
});
