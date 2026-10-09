import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SAFETY_CATEGORIES } from '@ptr/core';
import { ENV_REGISTRY, productionKeys } from '../src/env-registry';

// : every environment name the code, harness and infra files read must be registered.
const ROOT=join(__dirname,'..','..','..');
const SKIP=new Set(['node_modules','.next','.next-synthetic','dist','__pycache__']);
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true})
  .flatMap(entry=>SKIP.has(entry.name)?[]:entry.isDirectory()?walk(join(dir,entry.name)):[join(dir,entry.name)]);
const files=['apps','packages','scripts','e2e','infra'].flatMap(dir=>walk(join(ROOT,dir))).filter(file=>/\.(ts|tsx|mts|cts|mjs|cjs|js|sh|ya?ml)$/.test(file))
  .concat([join(ROOT,'infra','README.md'),join(ROOT,'.env.example')]);
const EVERYWHERE=[
  /\b((?:PTR|GOAL1)_[A-Z0-9_]*[A-Z0-9])\b/g, // prefixed names: string constants, shell and Compose interpolation
  /\bprocess\.env\??\.([A-Z_][A-Z0-9_]*)/g, /\benv\??\.([A-Z_][A-Z0-9_]*)\b/g, /\benv\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\]/g,
  /\\getenv\s+\w+\s+([A-Z_][A-Z0-9_]*)/g, // psql
  /\s-e\s+([A-Z_][A-Z0-9_]*)\b/g, // docker exec -e name
  /\{\s*([A-Z_][A-Z0-9_]*)[^}]*\}\s*=\s*process\.env/g, // destructuring (the first name)
];
const SHELL=[/^\s*export\s+([A-Z_][A-Z0-9_]*)=/gm, /(?:^|[\s;&|'"(])([A-Z_][A-Z0-9_]*)=(?:"[^"\n]*"|'[^'\n]*'|[^\s;'"]+)[ \t]+(?=[a-z])/gm];
// Unprefixed names passed as strings (e.g. a list of URL variables). Error codes share the shape: INVALID_* and the
// codes below are not environment names.
const QUOTED=/['"`]([A-Z][A-Z0-9]*_[A-Z0-9_]*(?:URL|KEY|TOKEN|SECRET|PASSWORD|MODEL|FILE))['"`]/g;
const NOT_ENV=new Set(['SELFHOSTED_BASE_URL_WITH_UPSTREAMS_FILE','UNTRUSTED_IMAGE_URL','HELD_OUT_IMAGE_SECRET']);
const COMPOSE_ENVIRONMENT=/^\s+([A-Z_][A-Z0-9_]*):\s/gm, ENV_FILE=/^([A-Z_][A-Z0-9_]*)=/gm;

function scan():Map<string,string> {
  const found=new Map<string,string>();
  for(const file of files) {
    const text=readFileSync(file,'utf8'), patterns=[...EVERYWHERE];
    if(/\.(sh|ya?ml|md)$/.test(file)) patterns.push(...SHELL);
    if(/\.ya?ml$/.test(file)) patterns.push(COMPOSE_ENVIRONMENT);
    if(file.endsWith('.env.example')) patterns.push(ENV_FILE);
    for(const pattern of patterns) for(const match of text.matchAll(pattern)) if(!found.has(match[1]!)) found.set(match[1]!,relative(ROOT,file));
    // The registry spells gateway names as suffixes; it is not a reader.
    if(!file.endsWith('env-registry.ts')) for(const match of text.matchAll(QUOTED)) {
      const name=match[1]!;if(!name.startsWith('INVALID_')&&!NOT_ENV.has(name)&&!found.has(name)) found.set(name,relative(ROOT,file));
    }
  }
  return found;
}

test('every environment name read anywhere is in the registry',()=>{
  const found=scan();
  // Sanity: the scan reaches the code, the shell/psql/Compose files and the example file.
  for(const name of ['PTR_GATEWAY_ROUTING','DATABASE_URL','PTR_GPU_ROOT','POSTGRES_PASSWORD','PGPASSWORD','REDISCLI_AUTH','PTR_LOADTEST_DB_PASSWORD','NEXT_PHASE'])
    expect(found.has(name)).toBe(true);
  const missing=[...found].filter(([name])=>!ENV_REGISTRY[name]).map(([name,file])=>`${name} (${file})`);
  expect(missing).toEqual([]);
});
test('dynamic safety thresholds are registered for every category',()=>{
  expect(SAFETY_CATEGORIES).toHaveLength(7);
  for(const category of SAFETY_CATEGORIES) expect(ENV_REGISTRY[`PTR_SAFETY_THRESHOLD_${category.toUpperCase()}`]?.class).toBe('D');
});
test('the production profile stays at most 20 names (19 today)',()=>{
  expect(productionKeys()).toHaveLength(19);
  for(const name of productionKeys()) expect(ENV_REGISTRY[name]!.roles!.length).toBeGreaterThan(0);
});
test('aliases point at production names',()=>{
  for(const entry of Object.values(ENV_REGISTRY)) if(entry.rRule==='alias') expect(ENV_REGISTRY[entry.aliasOf!]?.class).toBe('P');
  expect(Object.keys(ENV_REGISTRY).filter(name=>ENV_REGISTRY[name]!.class==='D')).toHaveLength(89);
});
