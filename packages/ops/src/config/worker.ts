import { z } from 'zod';
import { chatRuntimeRules, chatRuntimeShape } from './api';

const concurrency=z.string().refine(value=>/^\d+$/.test(value)&&Number(value)>=1&&Number(value)<=1024,'invalid_value').optional();
export const workerSchema=(cwd:string)=>z.object({...chatRuntimeShape(cwd),PTR_WORKER_CONCURRENCY:concurrency}).catchall(z.string().optional()).superRefine(chatRuntimeRules);
