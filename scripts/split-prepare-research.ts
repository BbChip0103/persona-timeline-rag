/** Explicit split-owner source preparation. No serving imports, DDL, embeddings or models. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { parsePersonaList } from '@ptr/core';
import { assertLocalDatabaseUrl } from '@ptr/storage';
import { importablePersonas, prepare } from './prepare-research';

export interface PreparationArgs {
  posts:string; targets:string; authoredList:string; output:string; approval:string;
  previousGeneratedList?:string; execute:boolean; synthetic:boolean; confirmDatabase?:string;
}
export interface PreparationPlan extends ReturnType<typeof prepare> {
  authored:Persona[]; previousGenerated:Persona[]; origin:'licensed_source'|'synthetic_fixture';
  inputHashes?:Record<string,string>;
}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail=(code:string):never=>{throw new Error(code);};
const fileLimit=16*1024*1024;

export function assertSplitPreparationTarget(raw:string):string {
  assertLocalDatabaseUrl(raw);
  const url=new URL(raw),database=url.pathname.slice(1);
  if(url.username!=='ptr_split_owner'||!['ptr_split_test','ptr_split_research'].includes(database))fail('SPLIT_PREPARATION_OWNER_REQUIRED');
  return database;
}
export function parsePreparationArgs(argv:string[]):PreparationArgs {
  const names:Record<string,string>={'--posts':'posts','--targets':'targets','--authored-list':'authoredList','--previous-generated-list':'previousGeneratedList','--output':'output','--approval':'approval','--confirm-database':'confirmDatabase'};
  const values:Record<string,string|boolean>={execute:false,synthetic:false};
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i]!;
    if(flag==='--execute'||flag==='--synthetic'){values[flag.slice(2)]=true;continue;}
    const key=names[flag],value=argv[++i];
    if(!key||!value||value.startsWith('--')||key in values)fail('SPLIT_PREPARATION_ARGUMENT_INVALID');
    values[key]=value;
  }
  if(!['posts','targets','authoredList','output','approval'].every(k=>typeof values[k]==='string')
    ||values.approval!=='approved-licensed-source-import'||values.execute&&!values.confirmDatabase)fail('SPLIT_PREPARATION_ARGUMENT_INVALID');
  return values as unknown as PreparationArgs;
}
async function privateBytes(path:string):Promise<Buffer> {
  let handle;
  try {
    handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=await handle.stat();
    if(!stat.isFile()||stat.mode&0o077||stat.uid!==process.getuid?.()||stat.nlink!==1||stat.size>fileLimit)fail('SPLIT_PREPARATION_PRIVATE_FILE_REQUIRED');
    const bytes=await handle.readFile();
    if(bytes.length>fileLimit)fail('SPLIT_PREPARATION_PRIVATE_FILE_REQUIRED');
    return bytes;
  } finally {await handle?.close();}
}
const decode=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true}).decode(bytes);
const Raw=z.object({person_id:z.string().min(1).max(100),post_id:z.string().min(1).max(100),caption:z.string().max(32768),posted_at:z.string().min(1),source_url:z.string().url(),event_date:z.string().nullable()}).passthrough();
const Target=z.object({username:z.string().min(1).max(100),display_name:z.string().max(200),category:z.string().min(1).max(200),cohort:z.string().min(1).max(100)}).passthrough();
export async function loadPreparation(args:PreparationArgs,database:string):Promise<PreparationPlan> {
  if(args.approval!=='approved-licensed-source-import'||args.synthetic&&database!=='ptr_split_test')fail('SPLIT_PREPARATION_APPROVAL_REQUIRED');
  const bytes=await privateBytes(args.posts),targetBytes=await privateBytes(args.targets),authoredBytes=await privateBytes(args.authoredList);
  const lines=decode(bytes).trim().split('\n');
  if(!lines[0]||lines.length>10000)fail('SPLIT_PREPARATION_INPUT_LIMIT');
  const raw=lines.map(line=>{
    const row=JSON.parse(line);
    Raw.parse(row);
    if(row.fictional===true||row.generated===true||row.origin!==undefined&&row.origin!==(args.synthetic?'synthetic_fixture':'licensed_source'))fail('SPLIT_PREPARATION_GENERATED_SOURCE_FORBIDDEN');
    return row as Parameters<typeof prepare>[0][number];
  });
  const manifest=JSON.parse(decode(targetBytes)),targets=manifest.people;
  z.array(Target).min(1).max(100).parse(targets);
  if(new Set(targets.map((t:{username:string})=>t.username)).size!==targets.length)fail('SPLIT_PREPARATION_DUPLICATE_TARGET');
  const authored=parsePersonaList(JSON.parse(decode(authoredBytes)));
  if(authored.database!==database||new Set(authored.personas.map(p=>p.personId)).size!==authored.personas.length)fail('SPLIT_PREPARATION_AUTHORED_BINDING_REQUIRED');
  const previousBytes=args.previousGeneratedList?await privateBytes(args.previousGeneratedList):undefined;
  const previous=previousBytes?parsePersonaList(JSON.parse(decode(previousBytes))):{personas:[]};
  if(previous.database!==undefined&&previous.database!==database)fail('SPLIT_PREPARATION_PREVIOUS_BINDING_REQUIRED');
  return {...prepare(raw,targets),authored:authored.personas,previousGenerated:previous.personas,
    origin:args.synthetic?'synthetic_fixture':'licensed_source',inputHashes:{
      posts:createHash('sha256').update(bytes).digest('hex'),targets:createHash('sha256').update(targetBytes).digest('hex'),authored:createHash('sha256').update(authoredBytes).digest('hex'),
      ...(previousBytes?{previousGenerated:createHash('sha256').update(previousBytes).digest('hex')}:{})}};
}
async function importPersona(client:PoolClient,input:Persona):Promise<void> {
  const p=PersonaSchema.parse(input),hash=digest(p);
  await client.query('SELECT current_revision FROM llm.personas WHERE id=$1 FOR UPDATE',[p.id]);
  await client.query('INSERT INTO llm.personas(id,person_id,current_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[p.id,p.personId,p.revision]);
  const binding=await client.query('SELECT person_id FROM llm.personas WHERE id=$1 FOR UPDATE',[p.id]);
  if(binding.rows[0]?.person_id!==p.personId)fail('SPLIT_PREPARATION_PERSONA_CONFLICT');
  const existing=await client.query('SELECT content_hash FROM llm.persona_versions WHERE persona_id=$1 AND revision=$2',[p.id,p.revision]);
  if(existing.rowCount&&existing.rows[0].content_hash!==hash)fail('SPLIT_PREPARATION_PERSONA_CONFLICT');
  if(!existing.rowCount) {
    await client.query('INSERT INTO llm.persona_versions(persona_id,revision,document,content_hash) VALUES($1,$2,$3,$4)',[p.id,p.revision,p,hash]);
    await client.query('UPDATE llm.personas SET current_revision=$2 WHERE id=$1',[p.id,p.revision]);
  }
}
/** All sources/personas commit together; generated and paid-ledger stores are never touched. */
export async function importPreparation(pool:Pool,database:string,plan:PreparationPlan) {
  if(!['ptr_split_test','ptr_split_research'].includes(database)||!['licensed_source','synthetic_fixture'].includes(plan.origin)
    ||plan.origin==='synthetic_fixture'&&database!=='ptr_split_test')fail('SPLIT_PREPARATION_OWNER_REQUIRED');
  const client=await pool.connect(),deadline=Date.now()+60000;
  const check=()=>{if(Date.now()>deadline)fail('SPLIT_PREPARATION_DEADLINE');};
  try {
    await client.query('BEGIN');
    const identity=await client.query('SELECT current_database() AS db,current_user AS username');
    if(identity.rows[0]?.db!==database||identity.rows[0]?.username!=='ptr_split_owner')fail('SPLIT_PREPARATION_IDENTITY_REQUIRED');
    const readiness=await client.query("SELECT (to_regclass('llm.source_posts') IS NOT NULL AND to_regclass('llm.personas') IS NOT NULL AND to_regclass('llm.persona_versions') IS NOT NULL) AS ready");
    if(!readiness.rows[0]?.ready)fail('SPLIT_PREPARATION_SCHEMA_REQUIRED');
    await client.query("SET LOCAL lock_timeout='1s'; SET LOCAL statement_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='30s'");
    // Block concurrent publication/import writes during current-pointer checks; ordinary reads continue.
    await client.query('LOCK TABLE llm.source_posts,llm.personas,llm.persona_versions IN SHARE ROW EXCLUSIVE MODE');
    const {importable,skipped}=importablePersonas(plan.personas,plan.authored);
    const current=await client.query('SELECT p.id,p.person_id,p.current_revision,v.document FROM llm.personas p JOIN llm.persona_versions v ON v.persona_id=p.id AND v.revision=p.current_revision WHERE p.person_id=ANY($1::text[]) FOR UPDATE OF p',[importable.map(p=>p.personId)]);
    for(const row of current.rows) {
      const p=PersonaSchema.parse(row.document),candidate=importable.find(x=>x.id===p.id&&x.personId===p.personId);
      if(!candidate||digest(p)!==digest(candidate)&&!plan.previousGenerated.some(previous=>previous.id===p.id&&previous.personId===p.personId&&digest(previous)===digest(p)))fail('SPLIT_PREPARATION_CURRENT_NOT_GENERATED');
    }
    let inserted=0,existing=0;
    for(const p of plan.sources) {
      check();
      if(p.imageAnnotations!==undefined)fail('SPLIT_PREPARATION_GENERATED_SOURCE_FORBIDDEN');
      const hash=digest({post:p,origin:plan.origin});
      const result=await client.query(`INSERT INTO llm.source_posts(id,person_id,posted_at,event_date,caption,unsafe,source_url,snapshot,source_hash,content_hash,origin,document)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING RETURNING id`,[p.id,p.personId,p.postedAt,p.eventDate,p.caption,p.unsafe,p.sourceUrl,p.snapshot,p.hash,hash,plan.origin,p]);
      if(result.rowCount)inserted++;
      else {
        const previous=await client.query('SELECT content_hash FROM llm.source_posts WHERE id=$1',[p.id]);
        if(previous.rows[0]?.content_hash!==hash)fail('SPLIT_PREPARATION_SOURCE_CONFLICT');
        existing++;
      }
    }
    for(const p of importable){check();await importPersona(client,p);}
    check();await client.query('COMMIT');
    return {inserted,existing,personasImported:importable.length,authoredSkipped:skipped.length};
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
}
async function artifact(directory:string,name:string,value:unknown):Promise<void> {
  await writeFile(join(directory,name),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
}
export async function preparationMain(argv=process.argv.slice(2),env:NodeJS.ProcessEnv=process.env) {
  const args=parsePreparationArgs(argv),url=env.PTR_LLM_MAINTENANCE_DATABASE_URL??'',database=assertSplitPreparationTarget(url);
  if(args.execute&&args.confirmDatabase!==database)fail('SPLIT_PREPARATION_CONFIRMATION_REQUIRED');
  const plan=await loadPreparation(args,database),output=resolve(args.output),parent=await lstat(dirname(output));
  if(!parent.isDirectory()||parent.mode&0o077||parent.uid!==process.getuid?.())fail('SPLIT_PREPARATION_PRIVATE_OUTPUT_REQUIRED');
  await mkdir(output,{mode:0o700});
  await artifact(output,'sources.json',plan.sources);await artifact(output,'personas.json',plan.personas);await artifact(output,'split.json',plan.split);
  await artifact(output,'manifest.json',{revision:'split-preparation-v1',database,origin:plan.origin,inputHashes:plan.inputHashes,modelCalls:0,embeddingCalls:0});
  let result={inserted:0,existing:0,personasImported:0,authoredSkipped:importablePersonas(plan.personas,plan.authored).skipped.length};
  if(args.execute) {
    const pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:3000,query_timeout:6000});
    try{result=await importPreparation(pool,database,plan);}finally{await pool.end();}
  }
  const report={executed:args.execute,posts:plan.sources.length,personas:plan.personas.length,excluded:plan.sources.filter(p=>p.unsafe).length,
    dev:Object.values(plan.split).filter(x=>x==='dev').length,test:Object.values(plan.split).filter(x=>x==='test').length,
    ...result,modelCalls:0,embeddingCalls:0,reviewStatus:'silver',splitMethod:'per-person UTC calendar-day 70/30 chronological proxy; not verified same-event grouping',screening:'Conservative regex heuristic, not privacy/injection guarantee'};
  await artifact(output,'preparation.json',report);
  return report;
}
if(require.main===module)void preparationMain().then(report=>{console.log(JSON.stringify(report));},()=>{console.error('SPLIT_PREPARATION_FAILED private details withheld');process.exitCode=1;});
