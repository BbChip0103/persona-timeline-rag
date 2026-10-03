import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonaSchema } from '@ptr/contracts';
import { ImageRunError, PrivateImageLedger, External imageFreeClient, imageTask, resumeFreeImage, submitFreeImage } from '../packages/images/src';
/** Uses only independently authored fictional still-life prompts, never source photos or actual names. */
async function executeImages(env:NodeJS.ProcessEnv) {
  const file=env.PTR_EXTERNAL_IMAGE_COOKIE_FILE;if(!file)throw new ImageRunError('AUTH_COOKIE_PATH_REQUIRED');
  const client=await External imageFreeClient.fromCookieFile(file);await client.authenticate();
  const directory=join(process.cwd(),'data','generated','images');await mkdir(directory,{recursive:true,mode:0o700});
  const proof=await client.eligibility();await writeFile(join(directory,'eligibility.private.json'),JSON.stringify(proof,null,2),{mode:0o600});
  if(!proof.available)throw new ImageRunError(proof.reasonCode);
  if(env.PTR_IMAGE_READ_ONLY==='true')return {status:'entitlement_verified',completed:0};
  const raw:unknown=JSON.parse(await readFile(join(process.cwd(),'data','research','personas.json'),'utf8'));
  if(!Array.isArray(raw)||raw.length!==4)throw new ImageRunError('FOUR_PRIVATE_PERSONAS_REQUIRED');
  const personas=raw.map(p=>PersonaSchema.parse(p));
  const themes=['an imaginary painting studio with colorful brushes and blank canvases','an imaginary design desk with abstract objects and a blank notebook','a fictional coastal nature still life with seashells and a small potted plant','an imaginary creative workshop with clay sculptures and warm sunlight'];
  const ledger=new PrivateImageLedger(join(directory,'tasks'));
  let tasks=[] as Awaited<ReturnType<typeof submitFreeImage>>[];
  // Submit each distinct image once, then read the free queue round-robin. Never wait for
  // the first image before establishing the other private tasks.
  for(const [i,persona] of personas.entries()) {
    const input=imageTask(persona.personId,persona.revision,themes[i]!);
    const existing=await ledger.get(input.key);
    const credits=await client.balance();
    if(existing?.baselineCredits!==undefined && credits<existing.baselineCredits)throw new ImageRunError('CREDITS_CHANGED_STOP');
    tasks.push(await submitFreeImage(client,ledger,input));
  }
  for(let poll=0;poll<120&&tasks.some(task=>task.state==='submitted');poll++) {
    const resumed=[] as typeof tasks;
    for(const task of tasks)resumed.push(await resumeFreeImage(client,ledger,task,directory));
    tasks=resumed;
    if(tasks.some(task=>task.state==='failed'))throw new ImageRunError('IMAGE_TASK_FAILED');
    if(tasks.some(task=>task.state==='submitted'))await new Promise(resolve=>setTimeout(resolve,30000));
  }
  const completed=tasks.filter(task=>task.state==='completed').length;
  if(completed!==4)throw new ImageRunError('IMAGE_PENDING_RESUME');
  return {status:'completed',completed};
}
export async function generateImages(env:NodeJS.ProcessEnv=process.env) {
  const directory=join(process.cwd(),'data','generated','images');await mkdir(directory,{recursive:true,mode:0o700});
  const lock=join(directory,'run.lock');
  try {const handle=await open(lock,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();}
  catch(error) {
    if(!error || typeof error!=='object' || !('code' in error) || error.code!=='EEXIST')throw new ImageRunError('IMAGE_LOCK_FAILED');
    const pid=Number(await readFile(lock,'utf8'));if(!Number.isInteger(pid)||pid<1)throw new ImageRunError('IMAGE_RUN_LOCK_UNVERIFIED');
    let alive=true;try {process.kill(pid,0);}catch(e){if(e && typeof e==='object' && 'code' in e && e.code==='ESRCH')alive=false;}
    if(alive)throw new ImageRunError('IMAGE_RUN_ALREADY_ACTIVE');
    await unlink(lock);
    // Competing recovery attempts are resolved by another exclusive creation.
    const handle=await open(lock,'wx',0o600);await handle.writeFile(String(process.pid));await handle.close();
  }
  try {return await executeImages(env);}finally {await unlink(lock);}
}
if(require.main===module)void generateImages().then(result=>process.stdout.write(`${JSON.stringify(result)}\n`)).catch(error=>{process.stderr.write(`${JSON.stringify({code:error instanceof ImageRunError?error.code:'IMAGE_RUN_FAILED'})}\n`);process.exitCode=1;});
