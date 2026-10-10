import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SAFETY_CATEGORIES } from '@ptr/core';
import { ENV_REGISTRY, ROLES, productionKeys } from '../src/env-registry';

// Registry scope is active framework/web startup, not every historical string or research/infra knob in the repository.
const ROOT=join(__dirname,'../../..');
const skip=new Set(['node_modules','.next','.next-synthetic','dist','test','tests','__pycache__']);
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(entry=>skip.has(entry.name)?[]:
  entry.isDirectory()?walk(join(dir,entry.name)):[join(dir,entry.name)]);
const files=['apps/api/src','apps/web','packages/ops/src'].flatMap(dir=>walk(join(ROOT,dir))).filter(file=>/\.tsx?$/u.test(file)&&!file.endsWith('env-registry.ts'));
const patterns=[/\b(?:process\.)?env\??\.([A-Z_][A-Z0-9_]*)/gu,
  /\benv\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/gu,
  /\b((?:PTR|GOAL1)_[A-Z0-9_]+):/gu];

test('active framework/web environment reads have registry entries',()=>{
  const found=new Map<string,string>();
  for(const file of files)for(const pattern of patterns)for(const match of readFileSync(file,'utf8').matchAll(pattern))found.set(match[1]!,relative(ROOT,file));
  for(const name of ['PTR_LITELLM_BASE_URL','PTR_GUARDRAILS_URL','PTR_REDIS_URL','LANGFUSE_BASE_URL','PTR_UI_PASSWORD','NEXT_PHASE'])expect(found.has(name)).toBe(true);
  expect([...found].filter(([name])=>!ENV_REGISTRY[name]).map(([name,file])=>`${name} (${file})`)).toEqual([]);
});
test('safety threshold controls are production controls, not a demo-only bypass',()=>{
  for(const category of SAFETY_CATEGORIES)expect(ENV_REGISTRY[`PTR_SAFETY_THRESHOLD_${category.toUpperCase()}`]).toMatchObject({class:'P',roles:['api','worker']});
});
test('production keys have framework roles and no retired fleet/capacity defaults',()=>{
  expect(ROLES).toEqual(['api','worker','web']);
  for(const name of productionKeys()) {expect(ENV_REGISTRY[name]!.roles!.length).toBeGreaterThan(0);expect(name).not.toMatch(/^PTR_(?:GATEWAY|CAPACITY|UPSTREAM|REGISTRY)_/u);}
  expect(ENV_REGISTRY.PTR_DEMO_SCALING).toMatchObject({class:'R',rRule:'removed'});
});
