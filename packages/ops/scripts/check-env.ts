/** Explicit-file, read-only framework configuration check. Never auto-loads .env files or starts a service. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { ROLES, checkRole, composeProblems, type EnvRole } from '../src';

export function runCheckEnv(argv:string[],options:{cwd?:string;write?:(line:string)=>void}={}):number {
  const cwd=options.cwd??process.cwd(),write=options.write??(line=>process.stdout.write(`${line}\n`));
  let file:string|undefined;let named:string[]|undefined;
  for(let index=0;index<argv.length;index++) {
    const flag=argv[index];
    if(flag==='--file') {if(file!==undefined||!argv[index+1]||argv[index+1]!.startsWith('--')) {write('usage explicit_file_required');return 2;}file=argv[++index];}
    else if(flag==='--roles'||flag==='--role') {
      const roles=argv[++index];if(!roles||roles.startsWith('--')) {write('usage invalid_roles');return 2;}
      named=[...(named??[]),...roles.split(',').map(role=>role.trim()).filter(Boolean)];
    } else {write('usage unknown_argument');return 2;}
  }
  if(!file) {write('usage explicit_file_required');return 2;}
  if(named&&(!named.length||named.some(role=>!(ROLES as readonly string[]).includes(role)))) {write('usage invalid_roles');return 2;}
  let env:NodeJS.ProcessEnv;
  try {env=parseEnv(readFileSync(resolve(cwd,file),'utf8')) as NodeJS.ProcessEnv;}
  catch {write('usage env_file_unreadable');return 2;}
  const roles=named?[...new Set(named)] as EnvRole[]:[...ROLES];
  const errors=new Set<string>(),warnings=new Set<string>();
  for(const role of roles) {
    const report=checkRole(role,env);
    for(const problem of report.errors)errors.add(`error ${role} ${problem.rule} ${problem.key}`);
    for(const problem of report.warnings)warnings.add(`warning all ${problem.rule} ${problem.key}`);
  }
  for(const problem of composeProblems(env))warnings.add(`warning all ${problem.rule} ${problem.key}`);
  write(`roles ${roles.join(',')}`);
  for(const warning of warnings)write(warning);
  for(const error of errors)write(error);
  write(`errors ${errors.size} warnings ${warnings.size}`);
  return errors.size?1:0;
}
if(require.main===module)process.exitCode=runCheckEnv(process.argv.slice(2));
