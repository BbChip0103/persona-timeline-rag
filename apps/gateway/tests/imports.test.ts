import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root=join(__dirname,'../../..');
/** Modules a fresh process loads for `entry` (through tsx, like `pnpm dev:gateway`). */
function loaded(entry:string):string[] {
  const script=`require(${JSON.stringify(entry)});process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
  return JSON.parse(execFileSync(join(root,'node_modules/.bin/tsx'),['-e',script],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH??''}})) as string[];
}

test('the gateway and the upstream agent use the registry subpath: BullMQ is never loaded',()=>{
  for(const entry of ['./apps/gateway/src/main.ts','./scripts/upstream-agent.ts']) {
    const modules=loaded(entry);
    expect(modules.some(file=>file.includes('upstream-registry'))).toBe(true);
    expect(modules.filter(file=>/[\\/]bullmq[\\/]/.test(file))).toEqual([]);
  }
},30000);
