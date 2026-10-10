import { createApiApplication } from './app';
import {createSplitRuntime} from './split-runtime';
async function main() {
  if(process.env.PTR_LLM_SERVICE_MODE==='legacy')(await import('../../../packages/ops/src/framework-config')).loadFrameworkConfig('api',process.env);
  else if(process.env.PTR_LLM_SERVICE_MODE!==undefined&&process.env.PTR_LLM_SERVICE_MODE!=='split')throw new Error('INVALID_SERVICE_MODE');
  const runtime=process.env.PTR_LLM_SERVICE_MODE==='legacy'?(await import('./runtime')).createRuntime():createSplitRuntime();
  const app=await createApiApplication(runtime,process.env.PTR_API_TOKEN??'',{syntheticToken:process.env.PTR_API_SYNTHETIC_TOKEN||undefined});
  const port=Number(process.env.PTR_API_PORT??56441);
  if(!Number.isInteger(port) || port<1024 || port>65535) throw new Error('INVALID_PORT');
  await app.listen(port,'127.0.0.1');
  // No secrets, connection URLs, actual persona data or upstream errors in startup output.
  process.stdout.write(`Local research API listening on 127.0.0.1:${port}\n`);
  const shutdown=()=>{void app.close().finally(()=>process.exit(0));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
// Only a bare error code (e.g. EADDRINUSE) is printed: messages can carry connection strings.
const safeCode=(error:unknown)=>{const code=(error as {code?:unknown})?.code;return typeof code==='string'&&/^[A-Z_]{1,40}$/.test(code)?` ${code}`:'';};
void main().catch(error=>{process.stderr.write(`API_STARTUP_FAILED${safeCode(error)}\n`);process.exitCode=1;});
