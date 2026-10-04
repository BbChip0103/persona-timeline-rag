import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { createLocalPool, transaction } from '@ptr/storage';
import { refinePersonas } from './refine-personas';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Atomically publish only new persona versions; never rewrite old versions, sessions or corpus. */
export async function activateRefinement(pool:Pool,originals:Persona[],refined:Persona[]):Promise<{personas:number;inserted:number}> {
  const old=originals.map(p=>PersonaSchema.parse(p)),next=refined.map(p=>PersonaSchema.parse(p));
  if(old.length!==4||next.length!==4||new Set(old.map(p=>p.id)).size!==4||new Set(next.map(p=>p.id)).size!==4)throw new Error('Invalid four-person bundle');
  for(const p of next) {
    const prior=old.find(o=>o.id===p.id);
    if(!prior||prior.personId!==p.personId||prior.language!==p.language||prior.identity!==p.identity||prior.greeting!==p.greeting||hash(prior.boundaries)!==hash(p.boundaries)||p.revision===prior.revision||p.reviewStatus!=='silver')throw new Error('Invalid immutable persona binding');
  }
  return transaction(pool,async client=>{
    let inserted=0;
    for(const p of [...next].sort((a,b)=>a.id.localeCompare(b.id,'en'))) {
      const prior=old.find(o=>o.id===p.id)!;
      const binding=await client.query('SELECT person_id,current_revision FROM personas WHERE id=$1 FOR UPDATE',[p.id]);
      if(binding.rows[0]?.person_id!==p.personId||![prior.revision,p.revision].includes(binding.rows[0]?.current_revision))throw new Error('Unexpected active persona binding');
      const original=await client.query('SELECT document FROM persona_versions WHERE persona_id=$1 AND revision=$2',[prior.id,prior.revision]);
      if(!original.rows[0]||hash(PersonaSchema.parse(original.rows[0].document))!==hash(prior))throw new Error('Original version mismatch');
      const existing=await client.query('SELECT content_hash FROM persona_versions WHERE persona_id=$1 AND revision=$2',[p.id,p.revision]);
      const contentHash=hash(p);
      if(existing.rows.length&&existing.rows[0].content_hash!==contentHash)throw new Error('Immutable new version conflict');
      if(!existing.rows.length){await client.query('INSERT INTO persona_versions(persona_id,revision,document,content_hash) VALUES($1,$2,$3,$4)',[p.id,p.revision,p,contentHash]);inserted++;}
      await client.query('UPDATE personas SET current_revision=$2 WHERE id=$1',[p.id,p.revision]);
    }
    return {personas:next.length,inserted};
  });
}
async function main():Promise<void> {
  const [flag,bundle,...extra]=process.argv.slice(2);
  if(flag!=='--activate'||!bundle||!/^[a-f0-9]{64}$/.test(bundle)||extra.length)throw new Error('Use --activate <frozen bundle hash>');
  const inputs={personas:JSON.parse(await readFile('data/research/personas.json','utf8')),
    sources:JSON.parse(await readFile('data/research/sources.json','utf8')),split:JSON.parse(await readFile('data/research/split.json','utf8')),
    targets:JSON.parse(await readFile('data/manifests/targets.json','utf8')).people};
  const prepared=refinePersonas(inputs);
  const frozen=JSON.parse(await readFile(`data/research/persona-variants/${bundle}/personas.json`,'utf8')).map((p:unknown)=>PersonaSchema.parse(p));
  if(prepared.bundleRevision!==bundle||hash(frozen)!==hash(prepared.personas))throw new Error('Frozen development bundle mismatch');
  // Guard validates the exact independent host/port/database/user BEFORE any DB connection.
  const pool=createLocalPool(process.env.GOAL1_DATABASE_URL??process.env.DATABASE_URL??'');
  try {console.log(JSON.stringify({...await activateRefinement(pool,inputs.personas,frozen),providerCalls:0,
    registry:`data/research/persona-variants/${bundle}/personas.json`,oldVersionsPreserved:true}));}finally{await pool.end();}
}
if(require.main===module)void main().catch(()=>{console.error('Local persona activation failed; transaction rolled back, no private details printed.');process.exitCode=1;});
