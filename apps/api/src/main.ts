import { createApiApplication } from './app';
import { createRuntime } from './runtime';
async function main() {
  const runtime=createRuntime();
  const app=await createApiApplication(runtime,process.env.PTR_API_TOKEN??'');
  const port=Number(process.env.PTR_API_PORT??56441);
  if(!Number.isInteger(port) || port<1024 || port>65535) throw new Error('INVALID_PORT');
  await app.listen(port,'127.0.0.1');
  // No secrets, connection URLs, actual persona data or upstream errors in startup output.
  process.stdout.write(`Local research API listening on 127.0.0.1:${port}\n`);
  const shutdown=()=>{void app.close().then(()=>runtime.close?.()).finally(()=>process.exit(0));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
void main().catch(()=>{process.stderr.write('API_STARTUP_FAILED\n');process.exitCode=1;});
