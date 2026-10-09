/**
 * pnpm ops:check-env [--file <path>] [--roles api,worker,…]   (§3.5)
 *
 * Checks an env file (default `.env.local`, parsed like `node --env-file`) against the role schemas without starting
 * anything. Prints key names and rule ids only, never values. Default roles: api, worker, dispatcher, web, plus gateway
 * when PTR_CHAT_PROVIDER=gateway; `--roles` replaces the list. Exit 0 = no errors, 1 = errors, 2 = usage.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ROLES, composeProblems, demoScaling, envProblems, roleProblems, type EnvRole, type Problem } from '../src';

const DEFAULT_ROLES:EnvRole[]=['api','worker','dispatcher','web'];
export function runCheckEnv(argv:string[],options:{cwd?:string;write?:(line:string)=>void}={}):number {
  const cwd=options.cwd??process.cwd(), write=options.write??(line=>process.stdout.write(`${line}\n`));
  let file='.env.local', named:string[]|undefined;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i]!;
    if(arg==='--file') file=argv[++i]??'';
    else if(arg==='--roles'||arg==='--role') named=[...(named??[]),...(argv[++i]??'').split(',').map(role=>role.trim()).filter(Boolean)];
    else {write(`unknown argument: ${arg.startsWith('--')?arg:'(positional)'}`);return 2;}
  }
  if(named&&!named.length) {write(`no roles given (roles: ${ROLES.join(',')})`);return 2;}
  const unknown=named?.filter(role=>!(ROLES as readonly string[]).includes(role));
  if(unknown?.length) {write(`unknown role: ${unknown.join(',')} (roles: ${ROLES.join(',')})`);return 2;}
  if(!file||!existsSync(resolve(cwd,file))) {write(`env file not found: ${file}`);return 2;}
  const env=parseEnv(readFileSync(resolve(cwd,file),'utf8')) as NodeJS.ProcessEnv;
  const roles=named?[...new Set(named)] as EnvRole[]:[...DEFAULT_ROLES,...(env.PTR_CHAT_PROVIDER==='gateway'?['gateway' as const]:[])];
  // Environment-wide problems are the same for every role: printed once, as `all`. Role problems: one line per role.
  const shared=envProblems(env), demo=demoScaling(env);
  const warnings:[string,Problem][]=[...shared.warnings,...composeProblems(env)].map(problem=>['all',problem]);
  const errors:[string,Problem][]=shared.errors.map(problem=>['all',problem]);
  // With the demo switch on, the production value rules are skipped, as at startup (roleProblems).
  for(const role of roles) for(const problem of roleProblems(role,env,cwd)) errors.push([role,problem]);
  write(`roles ${roles.join(',')} (demo ${demo?'on':'off'})`);
  for(const [scope,{key,rule}] of warnings) write(`warning ${scope} ${rule} ${key}`);
  for(const [scope,{key,rule}] of errors) write(`error ${scope} ${rule} ${key}`);
  write(`errors ${errors.length} warnings ${warnings.length}`);
  return errors.length?1:0;
}
if(require.main===module) process.exitCode=runCheckEnv(process.argv.slice(2));
