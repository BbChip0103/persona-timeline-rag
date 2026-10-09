/**
 * Persona authoring CLI . JSON in, fail-closed checks, then an explicit publish.
 *
 *   validate <file>                                    publish-time checks only; no database, nothing written
 *   publish  <file> --target research_db|loadtest_db   dry run (prints the target database); writes nothing
 *   publish  <file> --target … --confirm               import (and make current) → authored list → publish log
 *
 * <file> holds one persona or an array. The revision is computed (`${reviewStatus}-<sha256 16>`); any input revision
 * is ignored. Private inputs have no defaults (N3): a flag wins over its env var, and a missing value or file fails.
 *   --sources-doc    PTR_PERSONA_SOURCES_FILE    private source document (`web:<n>` entries)
 *   --split-file     PTR_RESEARCH_SPLIT_FILE     split.json (id → dev|test)
 *   --captions-file  PTR_RESEARCH_SOURCES_FILE   sources.json (licensed captions; leak check and licensed refs)
 *   --generated-list PTR_PERSONAS_FILE           optional: prepare-research personas (leak-check exemption)
 *   --authored-list  PTR_AUTHORED_PERSONAS_FILE  publish only: authored list the API reads (created on first publish)
 *   --publish-log    PTR_PERSONA_PUBLISH_LOG     publish only: JSONL log (created on first publish)
 * Output carries indexes, revisions, paths and rule names only: never names, persona text or source content.
 * After a confirmed publish restart the API (the catalogue is read once per process). Deploy order and rollback:
 * docs/persona-authoring.md.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, appendFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { userInfo } from 'node:os';
import type { Pool } from 'pg';
import { z, ZodError } from 'zod';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { AuthoredPersonaListSchema, CoreError, PERSONA_LINT_REVISION, personaRevision, validatePersonaForPublish, type PersonaPublishReport } from '@ptr/core';
import { createLocalPool, PostgresPersonaRepository } from '@ptr/storage';

/** Errors whose message is safe to print (no paths' contents, names or values). */
class CliError extends Error {}
const PATH_FLAGS={'sources-doc':'PTR_PERSONA_SOURCES_FILE','split-file':'PTR_RESEARCH_SPLIT_FILE','captions-file':'PTR_RESEARCH_SOURCES_FILE',
  'generated-list':'PTR_PERSONAS_FILE','authored-list':'PTR_AUTHORED_PERSONAS_FILE','publish-log':'PTR_PERSONA_PUBLISH_LOG'} as const;
type PathFlag=keyof typeof PATH_FLAGS;
export const TARGETS={research_db:{database:'ptr_research',urlEnv:['GOAL1_DATABASE_URL','DATABASE_URL']},loadtest_db:{database:'ptr_loadtest',urlEnv:['PTR_LOADTEST_DATABASE_URL']}} as const;
export type PublishTarget=keyof typeof TARGETS;
export interface PersonaPaths { sourcesDoc:string; splitFile:string; captionsFile:string; generatedList?:string; authoredList?:string; publishLog?:string }

export function parseCliArgs(argv:string[]):{command:'validate'|'publish';file:string;flags:Record<string,string|true>} {
  const [command,file,...rest]=argv;
  if((command!=='validate'&&command!=='publish')||!file||file.startsWith('--')) throw new CliError('Usage: persona.ts validate|publish <file> [flags]');
  const flags:Record<string,string|true>={};
  for(let i=0;i<rest.length;i++) {
    const name=rest[i]!.replace(/^--/,'');
    if(!rest[i]!.startsWith('--')) throw new CliError(`Unexpected argument at position ${i+3}`);
    if(name==='confirm') {flags.confirm=true;continue;}
    if(!(name in PATH_FLAGS)&&name!=='target') throw new CliError(`Unknown flag --${name}`);
    const value=rest[++i];
    if(value===undefined||value.startsWith('--')) throw new CliError(`Flag --${name} needs a value`);
    flags[name]=value;
  }
  return {command,file,flags};
}
export function resolvePaths(command:'validate'|'publish',flags:Record<string,string|true>,env:NodeJS.ProcessEnv):PersonaPaths {
  const value=(flag:PathFlag)=>{const raw=flags[flag];return typeof raw==='string'&&raw?raw:env[PATH_FLAGS[flag]]||undefined;};
  const required=(flag:PathFlag)=>{const found=value(flag);if(!found)throw new CliError(`Missing --${flag} (or ${PATH_FLAGS[flag]}); there is no default`);return found;};
  const generatedList=value('generated-list');
  return {sourcesDoc:required('sources-doc'),splitFile:required('split-file'),captionsFile:required('captions-file'),...(generatedList?{generatedList}:{}),
    ...(command==='publish'?{authoredList:required('authored-list'),publishLog:required('publish-log')}:{})};
}

const codePoints=(text:string)=>[...text].length;
/**  entry; extra keys (draft duplicates such as accessedAt/claim) are allowed and ignored. */
export const SourceDocEntrySchema=z.object({
  id:z.string().regex(/^web:\d+$/),personId:z.string().trim().min(1),
  url:z.string().url().refine(url=>['https:','http:'].includes(new URL(url).protocol)),title:z.string().trim().min(1),publisher:z.string().trim().min(1),
  kind:z.enum(['official_channel','own_site','interview','media']).optional(),retrievedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  paraphrase:z.string().trim().min(1).refine(text=>codePoints(text)<=300),usedBy:z.array(z.string()).optional(),
}).passthrough();
export type SourceDocEntry=z.infer<typeof SourceDocEntrySchema>;
const CaptionSchema=z.object({id:z.string().min(1),personId:z.string().min(1),caption:z.string()}).passthrough();
export interface ValidationInputs {
  sources:SourceDocEntry[];sourceDocSha256:string;
  captions:{id:string;personId:string;caption:string}[];split:Record<string,string>;generated:Persona[];
}
async function readRequired(path:string,what:string):Promise<string> {
  if(!existsSync(path)) throw new CliError(`Missing file for ${what}`);
  return readFile(path,'utf8');
}
const parseJson=(text:string,what:string):unknown=>{try {return JSON.parse(text);} catch {throw new CliError(`Invalid JSON in ${what}`);}};
export async function loadInputs(paths:PersonaPaths):Promise<ValidationInputs> {
  const sourceText=await readRequired(paths.sourcesDoc,'--sources-doc');
  const rawSources=parseJson(sourceText,'--sources-doc');
  if(!Array.isArray(rawSources)) throw new CliError('The private source document must be an array');
  const sources=rawSources.map((entry,index)=>{
    const parsed=SourceDocEntrySchema.safeParse(entry);
    if(!parsed.success) throw new CliError(`Invalid private source document entry ${index}: ${[...new Set(parsed.error.issues.map(issue=>String(issue.path[0]??'(entry)')))].join(',')}`);
    return parsed.data;
  });
  const keys=sources.map(entry=>`${entry.personId}\u0000${entry.id}`);
  if(new Set(keys).size!==keys.length) throw new CliError('Duplicate web:<n> id for one person in the private source document');
  const split=parseJson(await readRequired(paths.splitFile,'--split-file'),'--split-file');
  if(!split||typeof split!=='object'||Array.isArray(split)||Object.values(split).some(value=>value!=='dev'&&value!=='test')) throw new CliError('Invalid --split-file');
  const rawCaptions=parseJson(await readRequired(paths.captionsFile,'--captions-file'),'--captions-file');
  const captions=z.array(CaptionSchema).safeParse(rawCaptions);
  if(!captions.success) throw new CliError('Invalid --captions-file');
  let generated:Persona[]=[];
  if(paths.generatedList) {
    const raw=parseJson(await readRequired(paths.generatedList,'--generated-list'),'--generated-list');
    const parsed=z.array(PersonaSchema).safeParse(raw);
    if(!parsed.success) throw new CliError('Invalid --generated-list');
    generated=parsed.data;
  }
  return {sources,sourceDocSha256:createHash('sha256').update(sourceText).digest('hex'),
    captions:captions.data.map(({id,personId,caption})=>({id,personId,caption})),split:split as Record<string,string>,generated};
}

export interface DocumentResult { index:number; revision?:string; report:PersonaPublishReport }
/** Checks each document as it would be published (with its computed revision). Licensed refs: `licensedExists` or the captions file. */
export async function validateDocuments(docs:unknown[],inputs:ValidationInputs,licensedExists?:(id:string,personId:string)=>Promise<boolean>):Promise<DocumentResult[]> {
  const results:DocumentResult[]=[];const seen=new Set<string>();
  for(const [index,doc] of docs.entries()) {
    let revision:string|undefined;
    try {revision=personaRevision(doc);} catch {revision=undefined;}
    const candidate=revision&&doc&&typeof doc==='object'?{...doc,revision}:doc;
    const personId=typeof (doc as {personId?:unknown})?.personId==='string'?(doc as {personId:string}).personId:'';
    const report=await validatePersonaForPublish(candidate,{
      testCaptions:inputs.captions.filter(caption=>caption.personId===personId&&inputs.split[caption.id]==='test').map(caption=>caption.caption),
      ...(inputs.generated.some(persona=>persona.personId===personId)?{generated:inputs.generated.find(persona=>persona.personId===personId)!}:{}),
      sourceRefExists:async(ref,owner)=>/^web:\d+$/.test(ref)?inputs.sources.some(entry=>entry.id===ref&&entry.personId===owner)
        :licensedExists?licensedExists(ref,owner):inputs.captions.some(caption=>caption.id===ref&&caption.personId===owner),
    });
    if(personId&&seen.has(personId)) {report.issues.push({path:'personId',rule:'duplicate_person',severity:'error'});report.ok=false;}
    seen.add(personId);
    results.push({index,...(revision?{revision}:{}),report});
  }
  return results;
}

export interface PublishStore {
  readonly databaseName:string;
  licensedPostExists(id:string,personId:string):Promise<boolean>;
  /** All personas in one transaction: every one is imported (and made current), or none. */
  importPersonas(personas:Persona[],options:{setCurrent:true}):Promise<{inserted:boolean;previousRevision:string|null}[]>;
}
export interface PublishResult {
  ok:boolean;dryRun:boolean;target:PublishTarget;database:string;reports:PersonaPublishReport[];
  results:{index:number;revision?:string;inserted?:boolean;previousRevision?:string|null}[];
}
/** Write to a temporary sibling, then rename; the temporary file is removed when the rename fails. */
export async function writeFileAtomic(path:string,text:string):Promise<void> {
  const temporary=`${path}.tmp-${process.pid}`;
  await writeFile(temporary,text,{mode:0o600});
  try {await rename(temporary,path);}
  catch(error) {await unlink(temporary).catch(()=>undefined);throw error;}
}
async function writableDirectory(path:string):Promise<boolean> {
  try {await access(dirname(path),constants.W_OK);return (await stat(dirname(path))).isDirectory();} catch {return false;}
}
/**
 * Everything that can be checked before the database is touched: the authored list parses as `{database, personas}`
 * for this target's database (a list is bound to the database it was published to), and both files are writable.
 */
async function preflight(paths:Required<Pick<PersonaPaths,'authoredList'|'publishLog'>>,database:string):Promise<Persona[]> {
  let list:Persona[]=[];
  if(existsSync(paths.authoredList)) {
    const parsed=AuthoredPersonaListSchema.safeParse(parseJson(await readFile(paths.authoredList,'utf8'),'--authored-list'));
    if(!parsed.success) throw new CliError('--authored-list is not a {database, personas} list written by this CLI');
    if(parsed.data.database!==database) throw new CliError(`--authored-list belongs to ${parsed.data.database}, not ${database}`);
    list=parsed.data.personas;
  } else if(!await writableDirectory(paths.authoredList)) throw new CliError('--authored-list: the directory is missing or not writable');
  if(existsSync(paths.publishLog)?!(await stat(paths.publishLog)).isFile():!await writableDirectory(paths.publishLog))
    throw new CliError('--publish-log must be a writable file path');
  if(existsSync(paths.publishLog)) await access(paths.publishLog,constants.W_OK).catch(()=>{throw new CliError('--publish-log must be a writable file path');});
  return list;
}
/**
 * Validate → computed revision → preflight (list binding, writable list and log) → one import transaction (setCurrent)
 * → authored list → publish log. Any check failure writes nothing; without `confirm` nothing is written (dry run).
 * A failure names the imported indexes: none when the transaction rolled back, all when only the list/log step failed
 * (rerun the same publish to finish it).
 */
export async function publishDocuments(input:{docs:unknown[];inputs:ValidationInputs;paths:PersonaPaths;target:string;confirm:boolean;
  store?:PublishStore;publisher:string;now?:()=>string}):Promise<PublishResult> {
  const {paths,confirm,store}=input;
  if(!(input.target in TARGETS)) throw new CliError('--target must be research_db or loadtest_db');
  const target=input.target as PublishTarget,database=TARGETS[target].database;
  if(!paths.authoredList||!paths.publishLog) throw new CliError('publish needs --authored-list and --publish-log');
  if(confirm&&!store) throw new CliError('A confirmed publish needs the target database');
  if(store&&store.databaseName!==database) throw new CliError('The store does not match --target');
  const list=await preflight({authoredList:paths.authoredList,publishLog:paths.publishLog},database);
  const checked=await validateDocuments(input.docs,input.inputs,confirm?(id,personId)=>store!.licensedPostExists(id,personId):undefined);
  const reports=checked.map(result=>result.report);
  const results:PublishResult['results']=checked.map(result=>({index:result.index,...(result.revision?{revision:result.revision}:{})}));
  const ok=reports.every(report=>report.ok);
  if(!ok||!confirm) return {ok,dryRun:!confirm,target,database,reports,results};
  const personas=checked.map(result=>PersonaSchema.parse({...(input.docs[result.index] as object),revision:result.revision}));
  let imported:{inserted:boolean;previousRevision:string|null}[];
  try {imported=await store!.importPersonas(personas,{setCurrent:true});}
  catch(error) {
    // Constraint/validation errors happen before COMMIT, so the transaction rolled back. Anything else (for example a
    // connection dropped during COMMIT) leaves the outcome unknown: check current_revision before rerunning.
    const pgCode=error&&typeof error==='object'&&'code' in error?String((error as {code:unknown}).code):'';
    const rolledBack=error instanceof CoreError||error instanceof ZodError||/^2[23]/.test(pgCode);
    throw new CliError(rolledBack?`Imported indexes: none (the ${database} transaction rolled back; nothing was written).`
      :`Imported indexes: unknown (the ${database} import failed without a constraint or validation error; check current_revision before rerunning). The authored list and publish log were not written.`);
  }
  try {
    // Authored list: one entry per personId, replaced in place by a new revision; written atomically.
    for(const persona of personas) {
      const at=list.findIndex(entry=>entry.personId===persona.personId);
      if(at>=0) list[at]=persona; else list.push(persona);
    }
    await writeFileAtomic(paths.authoredList,JSON.stringify({database,personas:list},null,2)+'\n');
    const publishedAt=(input.now??(()=>new Date().toISOString()))();
    // The log holds real handles (publisher, personIds): private, mode 0600.
    await appendFile(paths.publishLog,personas.map((persona,i)=>JSON.stringify({personaId:persona.id,personId:persona.personId,revision:persona.revision,
      previousRevision:imported[i]!.previousRevision,inserted:imported[i]!.inserted,currentRevisionSet:true,publisher:input.publisher,publishedAt,
      lintRevision:PERSONA_LINT_REVISION,sourceDocSha256:input.inputs.sourceDocSha256,target,database})+'\n').join(''),{mode:0o600});
  } catch {
    throw new CliError(`Imported indexes: ${personas.map((_,i)=>i).join(',')} into ${database}, but the authored list or publish log was not fully written; rerun the same publish.`);
  }
  return {ok,dryRun:false,target,database,reports,results:results.map((result,i)=>({...result,...imported[i]!}))};
}

class PostgresPublishStore implements PublishStore {
  constructor(private readonly pool:Pool,readonly databaseName:string) {}
  async licensedPostExists(id:string,personId:string) {
    return !!(await this.pool.query('SELECT 1 FROM source_posts WHERE id=$1 AND person_id=$2',[id,personId])).rowCount;
  }
  importPersonas(personas:Persona[],options:{setCurrent:true}) {return new PostgresPersonaRepository(this.pool).importPersonas(personas,options);}
}
function publisherName():string {
  let git='unknown';
  try {git=execFileSync('git',['config','user.name'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()||'unknown';} catch {git='unknown';}
  return `${userInfo().username}/${git}`;
}
const summary=(results:DocumentResult[]|PublishResult['results'],reports:PersonaPublishReport[])=>results.map((result,i)=>({...result,report:undefined,
  ok:reports[i]!.ok,errors:reports[i]!.issues.filter(issue=>issue.severity==='error').length,warnings:reports[i]!.issues.filter(issue=>issue.severity==='warn').length,issues:reports[i]!.issues}));
async function main():Promise<void> {
  const {command,file,flags}=parseCliArgs(process.argv.slice(2));
  const paths=resolvePaths(command,flags,process.env);
  const raw=parseJson(await readRequired(file,'<file>'),'<file>');
  const docs=Array.isArray(raw)?raw:[raw];
  const inputs=await loadInputs(paths);
  if(command==='validate') {
    const results=await validateDocuments(docs,inputs);
    console.log(JSON.stringify({command,lintRevision:PERSONA_LINT_REVISION,ok:results.every(result=>result.report.ok),personas:summary(results,results.map(result=>result.report))},null,2));
    if(!results.every(result=>result.report.ok)) process.exitCode=1;
    return;
  }
  const target=typeof flags.target==='string'?flags.target:'';
  if(!(target in TARGETS)) throw new CliError('--target must be research_db or loadtest_db');
  const {database,urlEnv}=TARGETS[target as PublishTarget];
  console.error(`target database: ${database}${flags.confirm?'':' (dry run: add --confirm to publish)'}`);
  let pool:Pool|undefined;
  try {
    let store:PublishStore|undefined;
    if(flags.confirm) {
      const url=urlEnv.map(key=>process.env[key]).find(Boolean)??'';
      let path='';try {path=new URL(url).pathname;} catch {path='';}
      if(path!==`/${database}`) throw new CliError(`${urlEnv.join(' or ')} must point to ${database}`);
      pool=createLocalPool(url);store=new PostgresPublishStore(pool,database);
    }
    const result=await publishDocuments({docs,inputs,paths,target,confirm:flags.confirm===true,...(store?{store}:{}),publisher:publisherName()});
    console.log(JSON.stringify({command,lintRevision:PERSONA_LINT_REVISION,ok:result.ok,dryRun:result.dryRun,target:result.target,database:result.database,
      personas:summary(result.results,result.reports),...(result.ok&&!result.dryRun?{next:'Restart the API so the catalogue reads the authored list.'}:{})},null,2));
    if(!result.ok) process.exitCode=1;
  } finally {await pool?.end();}
}
if(require.main===module) void main().catch(error=>{
  console.error(error instanceof CliError?error.message:'Persona CLI failed; details stay private.');process.exitCode=1;
});
