import { z } from 'zod';
import { databaseUrl, existingFile, liveTrio, oneOf, redisUrl, required, textModel, token, unlessBlank } from './common';

/** API and worker share the chat runtime (createRuntime), so they share its production keys . */
export function chatRuntimeShape(cwd:string) {
  return {DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:unlessBlank('production_provider',value=>value==='gateway'||value==='openrouter'),PTR_MODEL:textModel,
    PTR_GATEWAY_TOKEN:token,PTR_PERSONAS_FILE:existingFile(cwd),PTR_AUTHORED_PERSONAS_FILE:existingFile(cwd),
    PTR_INTENT_CLASSIFIER:oneOf(['off','jev']),PTR_SAFETY_FILTER:oneOf(['off','jev'])};
}
export function chatRuntimeRules(env:NodeJS.ProcessEnv,ctx:z.RefinementCtx):void {
  required(env,ctx,'DATABASE_URL','PTR_REDIS_URL','PTR_CHAT_PROVIDER');
  if(env.PTR_CHAT_PROVIDER==='gateway') required(env,ctx,'PTR_GATEWAY_TOKEN');
  if(env.PTR_CHAT_PROVIDER==='openrouter') required(env,ctx,'PTR_MODEL');
  if(env.PTR_CHAT_PROVIDER==='openrouter'||env.PTR_INTENT_CLASSIFIER==='jev'||env.PTR_SAFETY_FILTER==='jev') liveTrio(env,ctx);
}
export const apiSchema=(cwd:string)=>z.object({...chatRuntimeShape(cwd),PTR_API_TOKEN:token}).catchall(z.string().optional())
  .superRefine((env,ctx)=>{chatRuntimeRules(env,ctx);required(env,ctx,'PTR_API_TOKEN');});
