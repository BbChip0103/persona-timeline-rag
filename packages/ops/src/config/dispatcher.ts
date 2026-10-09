import { z } from 'zod';
import { databaseUrl, redisUrl, required } from './common';

/** Recovery only (leases, outbox, queue): no provider keys . */
export const dispatcherSchema=()=>z.object({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl}).catchall(z.string().optional())
  .superRefine((env,ctx)=>required(env,ctx,'DATABASE_URL','PTR_REDIS_URL'));
