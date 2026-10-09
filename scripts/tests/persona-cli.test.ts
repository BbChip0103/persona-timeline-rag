import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { CoreError, PERSONA_LINT_REVISION, personaRevision } from '@ptr/core';
import { mkdir, readdir } from 'node:fs/promises';
import { loadInputs, parseCliArgs, publishDocuments, resolvePaths, restoreDocuments, validateDocuments, writeFileAtomic, type PersonaPaths, type PublishStore } from '../persona';
import { prepare } from '../prepare-research';

const withoutUndefined=(value:Persona):Persona=>JSON.parse(JSON.stringify(value)) as Persona;
/**  (§5): synthetic personas, temp files and an in-memory store only — no database, no research data. */
const persona=(personId:string,patch:Partial<Persona>={}):Persona=>withoutUndefined({id:`persona:${personId}`,personId,label:'Synthetic',language:'en',revision:'draft',reviewStatus:'silver',
  identity:'Fictional research AI. Not a real person.',concept:'Synthetic style simulation.',style:['Prefer concise conversational responses.'],
  boundaries:['No real identity claim or endorsement.'],sourceRefs:[`${personId}:post-1`],greeting:'Hi! I am a research AI.',
  background:{text:'A fictional watercolour studio runs weekend sketch walks.',sourceRefs:['web:1']},...patch} as Persona);
const sourceEntry=(personId:string,id='web:1')=>({id,personId,url:'https://example.invalid/profile',title:'Synthetic profile',publisher:'Example',kind:'official_channel',
  retrievedAt:'2026-10-09',paraphrase:'A synthetic public profile line.',usedBy:['background.text'],accessedAt:'2026-10-09',claim:'extra keys are ignored'});
const captions=[{id:'syn-a:post-1',personId:'syn-a',caption:'Dev caption about painting'},{id:'syn-a:post-2',personId:'syn-a',caption:'Held out: a quiet morning at the market'},
  {id:'syn-b:post-1',personId:'syn-b',caption:'Other dev caption'},{id:'syn-b:post-2',personId:'syn-b',caption:'A fictional watercolour studio runs weekend sketch walks.'}];
const split={'syn-a:post-1':'dev','syn-a:post-2':'test','syn-b:post-1':'dev','syn-b:post-2':'test'};

class MemoryStore implements PublishStore {
  databaseName='ptr_loadtest';
  rows=new Map<string,{personId:string;current:string;versions:Map<string,string>}>();
  posts:Set<string>;
  imports=0;batches=0;
  /** Runs after a committed batch (tests use it to break the list/log step). */
  afterImport?:()=>Promise<void>;
  constructor(posts:{id:string;personId:string}[]=captions) {this.posts=new Set(posts.map(c=>`${c.id}\u0000${c.personId}`));}
  /** All or nothing, like the one Postgres transaction. */
  async importPersonas(personas:Persona[],options:{setCurrent:true}) {
    this.batches++;
    const saved=new Map([...this.rows].map(([id,row])=>[id,{...row,versions:new Map(row.versions)}]));
    const results=[];
    try {for(const p of personas)results.push(await this.importPersona(p,options));}
    catch(error) {this.rows=saved;throw error;}
    await this.afterImport?.();return results;
  }
  async licensedPostExists(id:string,personId:string){return this.posts.has(`${id}\u0000${personId}`);}
  verifyCalls=0;
  /** Each baseline must be the persona's CURRENT revision with this exact document and person. */
  async verifyBaselines(entries:{baseline:Persona;draftRevision:string}[]) {
    this.verifyCalls++;
    return entries.map(({baseline:b,draftRevision})=>{const row=this.rows.get(b.id);
      return !!row&&row.personId===b.personId&&(row.current===b.revision||row.current===draftRevision)&&row.versions.get(b.revision)===JSON.stringify(PersonaSchema.parse(b));});
  }
  /** Tests use it to make the restore transaction fail with a non-CoreError (unknown outcome). */
  restoreFailure?:Error;
  /** Runs after a committed restore (tests use it to break the list/log step). */
  afterRestore?:()=>Promise<void>;
  restores=0;
  /** All or nothing: every revision must already exist with exactly this content; then each becomes current. */
  async restoreRevisions(personas:Persona[]) {
    this.restores++;
    if(this.restoreFailure) throw this.restoreFailure;
    for(const p of personas) {
      const row=this.rows.get(p.id);
      if(!row||row.personId!==p.personId||row.versions.get(p.revision)!==JSON.stringify(PersonaSchema.parse(p))) throw new CoreError('NOT_FOUND');
    }
    const results=personas.map(p=>{const row=this.rows.get(p.id)!;const previousRevision=row.current;row.current=p.revision;return {previousRevision};});
    await this.afterRestore?.();return results;
  }
  async importPersona(p:Persona,options:{setCurrent:true}) {
    this.imports++;const doc=JSON.stringify(PersonaSchema.parse(p));
    const row=this.rows.get(p.id)??{personId:p.personId,current:p.revision,versions:new Map()};
    const previousRevision=this.rows.get(p.id)?.current??null;
    if(row.personId!==p.personId) throw new CoreError('IDEMPOTENCY_CONFLICT');
    const existing=row.versions.get(p.revision);
    if(existing!==undefined&&existing!==doc) throw new CoreError('IDEMPOTENCY_CONFLICT');
    if(existing===undefined||options.setCurrent) row.current=p.revision;
    row.versions.set(p.revision,doc);this.rows.set(p.id,row);
    return {inserted:existing===undefined,previousRevision};
  }
}

let dir:string;let paths:PersonaPaths;
beforeEach(async()=>{
  dir=await mkdtemp(join(tmpdir(),'persona-cli-'));
  paths={sourcesDoc:join(dir,'sources-doc.json'),splitFile:join(dir,'split.json'),captionsFile:join(dir,'captions.json'),
    authoredList:join(dir,'authored.json'),publishLog:join(dir,'publish-log.jsonl')};
  await writeFile(paths.sourcesDoc,JSON.stringify([sourceEntry('syn-a'),sourceEntry('syn-b')]));
  await writeFile(paths.splitFile,JSON.stringify(split));await writeFile(paths.captionsFile,JSON.stringify(captions));
});
afterEach(async()=>{await rm(dir,{recursive:true,force:true});});
const publish=async(docs:unknown[],patch:Partial<Parameters<typeof publishDocuments>[0]>={})=>publishDocuments({docs,inputs:await loadInputs(paths),paths,target:'loadtest_db',
  confirm:true,store:new MemoryStore(),publisher:'tester/synthetic',now:()=>'2026-10-09T00:00:00.000Z',...patch});

describe('arguments and private paths (N3: named flags, env fallback, no defaults)',()=>{
  test('parses the command, the file and flags',()=>{
    expect(parseCliArgs(['publish','a.json','--target','research_db','--confirm','--sources-doc','s.json'])).toEqual({command:'publish',file:'a.json',flags:{target:'research_db',confirm:true,'sources-doc':'s.json'}});
    for(const argv of [[],['export','a.json'],['validate'],['validate','a.json','--unknown','x'],['validate','a.json','--sources-doc']]) expect(()=>parseCliArgs(argv)).toThrow();
  });
  test('a flag wins over its env var; a missing path fails naming the flag, never with a default',()=>{
    const env={PTR_PERSONA_SOURCES_FILE:'env-sources',PTR_RESEARCH_SPLIT_FILE:'env-split',PTR_RESEARCH_SOURCES_FILE:'env-captions',PTR_AUTHORED_PERSONAS_FILE:'env-authored',PTR_PERSONA_PUBLISH_LOG:'env-log',PTR_PERSONAS_FILE:'env-generated'};
    expect(resolvePaths('validate',{'sources-doc':'flag-sources'},env)).toEqual({sourcesDoc:'flag-sources',splitFile:'env-split',captionsFile:'env-captions',generatedList:'env-generated'});
    expect(resolvePaths('publish',{},env)).toEqual({sourcesDoc:'env-sources',splitFile:'env-split',captionsFile:'env-captions',generatedList:'env-generated',authoredList:'env-authored',publishLog:'env-log'});
    expect(()=>resolvePaths('validate',{},{...env,PTR_RESEARCH_SPLIT_FILE:undefined})).toThrow('--split-file');
    expect(()=>resolvePaths('publish',{},{...env,PTR_PERSONA_PUBLISH_LOG:''})).toThrow('--publish-log');
    expect(resolvePaths('validate',{},{...env,PTR_PERSONAS_FILE:undefined}).generatedList).toBeUndefined();
    expect(resolvePaths('validate',{baseline:'flag-baseline'},env).baseline).toBe('flag-baseline');
    expect(resolvePaths('validate',{},{...env,PTR_PERSONA_BASELINE_FILE:'env-baseline'}).baseline).toBe('env-baseline');
    expect(resolvePaths('validate',{},env).baseline).toBeUndefined();
  });
  test('missing input files fail closed',async()=>{
    for(const key of ['sourcesDoc','splitFile','captionsFile'] as const) await expect(loadInputs({...paths,[key]:join(dir,'missing.json')})).rejects.toThrow();
  });
  test('the private source document: §5.1 keys validated, extra keys ignored; errors name index and key only',async()=>{
    expect((await loadInputs(paths)).sources).toHaveLength(2);
    for(const bad of [{id:'note:1'},{paraphrase:'x'.repeat(301)},{retrievedAt:undefined},{url:'ftp://example.invalid'},{kind:'fan_wiki'},{personId:''}]) {
      await writeFile(paths.sourcesDoc,JSON.stringify([sourceEntry('syn-a'),{...sourceEntry('syn-b'),...bad}]));
      const error=await loadInputs(paths).then(()=>undefined,(e:Error)=>e);
      expect(error?.message).toMatch(/^Invalid private source document entry 1/);expect(error?.message).not.toContain('example.invalid');
    }
    await writeFile(paths.sourcesDoc,JSON.stringify([sourceEntry('syn-a'),sourceEntry('syn-a')]));
    await expect(loadInputs(paths)).rejects.toThrow('Duplicate');
  });
});

describe('validate',()=>{
  test('a clean synthetic persona passes; reports carry the computed revision',async()=>{
    const [result]=await validateDocuments([persona('syn-a')],await loadInputs(paths));
    expect(result!.report).toEqual({ok:true,issues:[],lintRevision:PERSONA_LINT_REVISION});
    expect(result!.revision).toBe(personaRevision(persona('syn-a')));
  });
  test('web:<n> and licensed refs must belong to the same person',async()=>{
    const inputs=await loadInputs(paths);
    const [result]=await validateDocuments([persona('syn-a',{sourceRefs:['syn-b:post-1'],background:{text:'Fictional studio.',sourceRefs:['web:2']}})],inputs);
    expect(result!.report.issues).toEqual([{path:'sourceRefs[0]',rule:'source_missing',severity:'error'},{path:'background.sourceRefs[0]',rule:'source_missing',severity:'error'}]);
    await writeFile(paths.sourcesDoc,JSON.stringify([sourceEntry('syn-b','web:2')]));
    const [other]=await validateDocuments([persona('syn-a',{background:{text:'Fictional studio.',sourceRefs:['web:2']}})],await loadInputs(paths));
    expect(other!.report.issues).toContainEqual({path:'background.sourceRefs[0]',rule:'source_missing',severity:'error'});
  });
  test('the leak check compares the same person\'s test captions only, and skips generated texts',async()=>{
    const inputs=await loadInputs(paths);
    // syn-b's test caption equals syn-a's background text: not compared for syn-a.
    expect((await validateDocuments([persona('syn-a')],inputs))[0]!.report.ok).toBe(true);
    expect((await validateDocuments([persona('syn-b',{sourceRefs:['syn-b:post-1']})],inputs))[0]!.report.issues).toContainEqual({path:'background.text',rule:'test_caption_overlap',severity:'error'});
    // Dev captions are never compared.
    expect((await validateDocuments([persona('syn-a',{concept:'Dev caption about painting'})],inputs))[0]!.report.ok).toBe(true);
    const generated=join(dir,'generated.json');
    await writeFile(generated,JSON.stringify([persona('syn-b',{background:undefined,style:['A fictional watercolour studio runs weekend sketch walks.']})]));
    const withGenerated=await loadInputs({...paths,generatedList:generated});
    const [exempt]=await validateDocuments([persona('syn-b',{sourceRefs:['syn-b:post-1'],background:undefined,style:['A fictional watercolour studio runs weekend sketch walks.']})],withGenerated);
    expect(exempt!.report.ok).toBe(true);
    // --baseline: the previous current revisions (e.g. refined dialogue revisions) exempt their identical lines too.
    const baseline=join(dir,'baseline.json');
    await writeFile(baseline,JSON.stringify([persona('syn-b',{background:undefined,style:['A fictional watercolour studio runs weekend sketch walks.']})]));
    const withBaseline=await loadInputs({...paths,baseline});
    const [baselined]=await validateDocuments([persona('syn-b',{sourceRefs:['syn-b:post-1'],background:undefined,style:['A fictional watercolour studio runs weekend sketch walks.']})],withBaseline);
    expect(baselined!.report.ok).toBe(true);
    await writeFile(baseline,'[{"not":"a persona"}]');
    await expect(loadInputs({...paths,baseline})).rejects.toThrow('Invalid --baseline');
  });
  test('two documents for one personId are refused',async()=>{
    const results=await validateDocuments([persona('syn-a'),persona('syn-a',{greeting:'Hello again, research AI here.'})],await loadInputs(paths));
    expect(results[1]!.report.issues).toContainEqual({path:'personId',rule:'duplicate_person',severity:'error'});
  });
});

describe('publish',()=>{
  test('without --confirm it is a dry run: no store call, no list, no log',async()=>{
    const store=new MemoryStore();
    const result=await publish([persona('syn-a')],{confirm:false,store});
    expect(result).toMatchObject({ok:true,dryRun:true,database:'ptr_loadtest',results:[{index:0,revision:personaRevision(persona('syn-a'))}]});
    expect(store.imports).toBe(0);expect(existsSync(paths.authoredList!)).toBe(false);expect(existsSync(paths.publishLog!)).toBe(false);
  });
  test('confirmed: imports with the computed revision, makes it current, writes the authored list and one log line',async()=>{
    const store=new MemoryStore();
    const result=await publish([persona('syn-a')],{store});
    const revision=personaRevision(persona('syn-a'));
    expect(result).toMatchObject({ok:true,dryRun:false,results:[{index:0,revision,inserted:true,previousRevision:null}]});
    expect(store.rows.get('persona:syn-a')!.current).toBe(revision);
    const listed=JSON.parse(await readFile(paths.authoredList!,'utf8')) as {database:string;personas:Persona[]};
    expect(listed).toEqual({database:'ptr_loadtest',personas:[{...PersonaSchema.parse(persona('syn-a')),revision}]});
    expect(store.batches).toBe(1);
    const lines=(await readFile(paths.publishLog!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    const sourceDocSha256=(await loadInputs(paths)).sourceDocSha256;
    expect(lines).toEqual([{personaId:'persona:syn-a',personId:'syn-a',revision,previousRevision:null,inserted:true,currentRevisionSet:true,publisher:'tester/synthetic',
      publishedAt:'2026-10-09T00:00:00.000Z',lintRevision:PERSONA_LINT_REVISION,sourceDocSha256,target:'loadtest_db',database:'ptr_loadtest'}]);
  });
  test('same file → same revision; republishing is idempotent and restores current_revision (N6 ②)',async()=>{
    const store=new MemoryStore();
    await publish([persona('syn-a')],{store});
    const listBefore=await readFile(paths.authoredList!,'utf8');
    // A prepare-research rerun importing a new generated revision moves the pointer away.
    await store.importPersona({...persona('syn-a',{background:undefined}),revision:'silver-generated'},{setCurrent:true});
    expect(store.rows.get('persona:syn-a')!.current).toBe('silver-generated');
    const again=await publish([persona('syn-a')],{store});
    expect(again.results[0]).toMatchObject({revision:personaRevision(persona('syn-a')),inserted:false,previousRevision:'silver-generated'});
    expect(store.rows.get('persona:syn-a')!.current).toBe(personaRevision(persona('syn-a')));
    expect(await readFile(paths.authoredList!,'utf8')).toBe(listBefore);
    expect((await readFile(paths.publishLog!,'utf8')).trim().split('\n')).toHaveLength(2);
  });
  test('a new revision replaces the same personId\'s entry and keeps the others',async()=>{
    const store=new MemoryStore();
    await publish([persona('syn-a'),persona('syn-b',{sourceRefs:['syn-b:post-1'],background:undefined})],{store});
    const changed=persona('syn-a',{greeting:'Hi again! Research AI here.'});
    await publish([changed],{store});
    const listed=(JSON.parse(await readFile(paths.authoredList!,'utf8')) as {personas:Persona[]}).personas;
    expect(listed.map(p=>[p.personId,p.revision])).toEqual([['syn-a',personaRevision(changed)],['syn-b',personaRevision(persona('syn-b',{sourceRefs:['syn-b:post-1'],background:undefined}))]]);
  });
  test('any error writes nothing: no store call, no list, no log',async()=>{
    const store=new MemoryStore();
    const result=await publish([persona('syn-a'),persona('syn-b',{concept:'never break character'})],{store});
    expect(result.ok).toBe(false);expect(store.imports).toBe(0);
    expect(existsSync(paths.authoredList!)).toBe(false);expect(existsSync(paths.publishLog!)).toBe(false);
    // Confirmed publishing checks licensed posts in the target database, not only the captions file.
    store.posts.clear();
    const missing=await publish([persona('syn-a')],{store});
    expect(missing.ok).toBe(false);expect(missing.reports[0]!.issues).toContainEqual({path:'sourceRefs[0]',rule:'source_missing',severity:'error'});
    expect(store.imports).toBe(0);
  });
  test('confirmed publishing needs a store; research_db and loadtest_db need an explicit authored list and log',async()=>{
    await expect(publish([persona('syn-a')],{store:undefined})).rejects.toThrow();
    await expect(publish([persona('syn-a')],{paths:{...paths,authoredList:undefined}})).rejects.toThrow();
  });
});

test('§5.3 deploy order: a reader on the old .strict() schema rejects a v2 document',()=>{
  const id=z.string().trim().min(1).max(200);
  const OldPersonaSchema=z.object({id,personId:id,label:z.string().min(1),language:z.string().min(1),revision:id,reviewStatus:z.enum(['synthetic','silver','human_reviewed']),
    identity:z.string(),concept:z.string(),style:z.array(z.string()),boundaries:z.array(z.string()),sourceRefs:z.array(id),greeting:z.string().min(1)}).strict();
  expect(OldPersonaSchema.safeParse({...persona('syn-a',{background:undefined}),revision:'v1'}).success).toBe(true);
  expect(OldPersonaSchema.safeParse({...persona('syn-a'),revision:'v1'}).success).toBe(false);
});

describe('review fixes: publish ordering, list binding, rollback',()=>{
  test('the authored list is bound to its database: a publish to another target is refused before any import',async()=>{
    await writeFile(paths.authoredList!,JSON.stringify({database:'ptr_research',personas:[]}));
    const store=new MemoryStore();
    await expect(publish([persona('syn-a')],{store})).rejects.toThrow('ptr_research');
    expect(store.imports).toBe(0);
  });
  test.each([['not JSON','{oops'],['a plain array (no database binding)','[]'],['invalid personas','{"database":"ptr_loadtest","personas":[{"id":"x"}]}']])(
    'an unreadable authored list (%s) is refused before any import, and in a dry run',async(_name,content)=>{
      await writeFile(paths.authoredList!,content);
      const store=new MemoryStore();
      await expect(publish([persona('syn-a')],{store})).rejects.toThrow();expect(store.imports).toBe(0);
      await expect(publish([persona('syn-a')],{confirm:false,store})).rejects.toThrow();
    });
  test('an unusable publish log path is refused before any import',async()=>{
    const store=new MemoryStore();
    await expect(publish([persona('syn-a')],{store,paths:{...paths,publishLog:join(dir,'missing-dir','log.jsonl')}})).rejects.toThrow('--publish-log');
    await mkdir(join(dir,'log-as-dir'));
    await expect(publish([persona('syn-a')],{store,paths:{...paths,publishLog:join(dir,'log-as-dir')}})).rejects.toThrow('--publish-log');
    expect(store.imports).toBe(0);
  });
  test('all personas are imported in one batch; a database failure imports none and says so',async()=>{
    const store=new MemoryStore();
    await store.importPersona({...persona('syn-b'),revision:personaRevision(persona('syn-b',{sourceRefs:['syn-b:post-1'],background:undefined}))},{setCurrent:true});
    store.imports=0;
    // syn-b's computed revision already exists with different content: the second import conflicts.
    const conflicting=persona('syn-b',{sourceRefs:['syn-b:post-1'],background:undefined});
    store.rows.get(conflicting.id)!.versions.set(personaRevision(conflicting),'different content');
    await expect(publish([persona('syn-a'),conflicting],{store})).rejects.toThrow(/imported indexes: none/i);
    expect(store.rows.has('persona:syn-a')).toBe(false);expect(store.batches).toBe(1);
    expect(existsSync(paths.authoredList!)).toBe(false);expect(existsSync(paths.publishLog!)).toBe(false);
  });
  test('an error that is not a constraint or validation error (a dropped connection at COMMIT) reports unknown',async()=>{
    const store=new MemoryStore();
    store.importPersonas=async()=>{throw new Error('Connection terminated unexpectedly');};
    await expect(publish([persona('syn-a')],{store})).rejects.toThrow(/imported indexes: unknown/i);
    expect(existsSync(paths.authoredList!)).toBe(false);expect(existsSync(paths.publishLog!)).toBe(false);
  });
  test('a failure after the import commits names the imported indexes',async()=>{
    const logDir=join(dir,'logs');await mkdir(logDir);
    const store=new MemoryStore();
    store.afterImport=async()=>{await rm(logDir,{recursive:true,force:true});};
    await expect(publish([persona('syn-a')],{store,paths:{...paths,publishLog:join(logDir,'log.jsonl')}})).rejects.toThrow(/imported indexes: 0 into ptr_loadtest/i);
    expect(store.rows.get('persona:syn-a')!.current).toBe(personaRevision(persona('syn-a')));
  });
  test('writeFileAtomic removes its temporary file when the rename fails',async()=>{
    const target=join(dir,'occupied');await mkdir(target);await writeFile(join(target,'keep'),'x');
    await expect(writeFileAtomic(target,'{}')).rejects.toThrow();
    expect((await readdir(dir)).filter(name=>name.includes('.tmp-'))).toEqual([]);
  });
  test('rollback: republishing the generated persona restores its silver revision as current and leaves a v1-shaped list entry',async()=>{
    const rows=Array.from({length:20},(_,i)=>({person_id:'syn-r',post_id:String(i),caption:`Synthetic public idea ${i}.`,posted_at:`2020-01-${String(i+1).padStart(2,'0')}T00:00:00Z`,event_date:null,source_url:'https://example.invalid/post'}));
    const prepared=prepare(rows,[{username:'syn-r',display_name:'Synthetic',category:'illustration',cohort:'overseas'}]);
    const generated=prepared.personas[0]!;
    await writeFile(paths.captionsFile,JSON.stringify(prepared.sources));await writeFile(paths.splitFile,JSON.stringify(prepared.split));
    await writeFile(paths.sourcesDoc,JSON.stringify([sourceEntry('syn-r')]));
    const store=new MemoryStore(prepared.sources);
    // prepare-research imported the generated revision before anything was authored.
    await store.importPersona(generated,{setCurrent:true});
    const card={...generated,background:{text:'A fictional illustrator profile.',sourceRefs:['web:1']}};
    await publish([card],{store});
    expect(store.rows.get(generated.id)!.current).toBe(personaRevision(card));
    // The prepare-research revision rule is the publish rule, so the generated document republishes as itself.
    expect(personaRevision(generated)).toBe(generated.revision);
    const restored=await publish([generated],{store});
    expect(restored.results[0]).toMatchObject({revision:generated.revision,inserted:false,previousRevision:personaRevision(card)});
    expect(store.rows.get(generated.id)!.current).toBe(generated.revision);
    const listed=(JSON.parse(await readFile(paths.authoredList!,'utf8')) as {personas:Persona[]}).personas;
    expect(listed).toEqual([generated]);
  });
  test('real-person personas without same-person test captions are refused (leak_check_unavailable)',async()=>{
    const [result]=await validateDocuments([persona('syn-c',{sourceRefs:[],background:undefined})],await loadInputs(paths));
    expect(result!.report.issues).toContainEqual({path:'',rule:'leak_check_unavailable',severity:'error'});
  });
});

describe('restore (rollback to the previous current revision, e.g. a refined dialogue-* revision)',()=>{
  const restore=async(docs:unknown[],store:MemoryStore,confirm=true,add=false)=>restoreDocuments({docs,paths,target:'loadtest_db',confirm,add,store,publisher:'tester/synthetic',now:()=>'2026-10-09T01:00:00.000Z'});
  // A refined revision made outside this CLI (goal1's refine-personas): stored verbatim with its own revision name.
  const dialogue={...PersonaSchema.parse(persona('syn-a',{background:undefined})),revision:'dialogue-0123456789abcdef',style:['Respond as the disclosed research character.']};
  test('restore needs only the authored list and the publish log',()=>{
    expect(parseCliArgs(['restore','prev.json','--target','research_db']).command).toBe('restore');
    // No research inputs are read for a restore (the private paths stay empty, never defaulted).
    expect(resolvePaths('restore',{'authored-list':'l.json','publish-log':'g.jsonl'},{})).toEqual({sourcesDoc:'',splitFile:'',captionsFile:'',authoredList:'l.json',publishLog:'g.jsonl'});
    expect(()=>resolvePaths('restore',{'authored-list':'l.json'},{})).toThrow('--publish-log');
  });
  test('the previous revision becomes current again, verbatim (no new revision, no lint), with a list entry and a restore log line',async()=>{
    const store=new MemoryStore();
    await store.importPersona(dialogue,{setCurrent:true});
    await publish([persona('syn-a')],{store});
    const published=personaRevision(persona('syn-a'));
    expect(store.rows.get('persona:syn-a')!.current).toBe(published);
    const dry=await restore([dialogue],store,false);
    expect(dry).toMatchObject({dryRun:true,results:[{index:0,revision:'dialogue-0123456789abcdef'}]});expect(store.restores).toBe(0);
    expect(dry.note).toMatch(/database was not checked/);
    const result=await restore([dialogue],store);
    expect(result).toMatchObject({dryRun:false,results:[{index:0,revision:'dialogue-0123456789abcdef',previousRevision:published}]});
    expect(store.rows.get('persona:syn-a')!.current).toBe('dialogue-0123456789abcdef');
    const listed=(JSON.parse(await readFile(paths.authoredList!,'utf8')) as {personas:Persona[]}).personas;
    expect(listed).toEqual([dialogue]);
    const last=JSON.parse((await readFile(paths.publishLog!,'utf8')).trim().split('\n').at(-1)!);
    expect(last).toEqual({action:'restore',personaId:'persona:syn-a',personId:'syn-a',revision:'dialogue-0123456789abcdef',previousRevision:published,
      currentRevisionSet:true,publisher:'tester/synthetic',publishedAt:'2026-10-09T01:00:00.000Z',target:'loadtest_db',database:'ptr_loadtest'});
  });
  test('a revision that is not stored, or stored with other content, is refused and nothing is written',async()=>{
    const store=new MemoryStore();
    await store.importPersona(dialogue,{setCurrent:true});
    await expect(restore([{...dialogue,revision:'dialogue-ffffffffffffffff'}],store,true,true)).rejects.toThrow(/nothing was written/);
    await expect(restore([{...dialogue,style:['Edited after the fact.']}],store,true,true)).rejects.toThrow(/nothing was written/);
    expect(existsSync(paths.authoredList!)).toBe(false);expect(existsSync(paths.publishLog!)).toBe(false);
    expect(store.rows.get('persona:syn-a')!.current).toBe('dialogue-0123456789abcdef');
  });
  test('documents must parse and name one revision per personId',async()=>{
    const store=new MemoryStore();
    await expect(restore([{nope:true}],store)).rejects.toThrow();
    await expect(restore([dialogue,dialogue],store)).rejects.toThrow(/one document per personId/);
  });
});

describe('restore review fixes',()=>{
  const restore=async(docs:unknown[],store:MemoryStore,options:{confirm?:boolean;add?:boolean}={})=>restoreDocuments({docs,paths,target:'loadtest_db',confirm:options.confirm??true,
    add:options.add??false,store,publisher:'tester/synthetic',now:()=>'2026-10-09T02:00:00.000Z'});
  const dialogue={...PersonaSchema.parse(persona('syn-a',{background:undefined})),revision:'dialogue-0123456789abcdef',style:['Respond as the disclosed research character.']};
  const logLines=async()=>(await readFile(paths.publishLog!,'utf8')).trim().split('\n').map(line=>JSON.parse(line) as Record<string,unknown>);
  test('no authored-list entry for the persona: refused unless --add, before the database',async()=>{
    const store=new MemoryStore();await store.importPersona(dialogue,{setCurrent:true});
    await expect(restore([dialogue],store)).rejects.toThrow(/--add/);
    expect(store.restores).toBe(0);expect(existsSync(paths.publishLog!)).toBe(false);
    expect((await restore([dialogue],store,{add:true})).dryRun).toBe(false);
    expect(JSON.parse(await readFile(paths.authoredList!,'utf8')).personas).toEqual([dialogue]);
  });
  test('the authored entry for that personId must be the same persona id',async()=>{
    const store=new MemoryStore();await store.importPersona(dialogue,{setCurrent:true});
    await writeFile(paths.authoredList!,JSON.stringify({database:'ptr_loadtest',personas:[{...dialogue,id:'persona:other-id'}]}));
    await expect(restore([dialogue],store)).rejects.toThrow(/different persona id/);expect(store.restores).toBe(0);
  });
  test('idempotent rerun logs alreadyCurrent; a target other than the newest previousRevision is a warning (allowed)',async()=>{
    const store=new MemoryStore();await store.importPersona(dialogue,{setCurrent:true});
    await publish([persona('syn-a')],{store});
    await publish([persona('syn-a',{greeting:'Hello again, research AI here.'})],{store});
    // The newest log line's previousRevision is the first publish, not the dialogue revision: multi-step rollback warns.
    const first=await restore([dialogue],store);
    expect(first.results[0]).toMatchObject({revision:dialogue.revision,warning:'not_latest_previous_revision'});
    expect((await logLines()).at(-1)).toMatchObject({action:'restore',notLatestPreviousRevision:true});
    const again=await restore([dialogue],store);
    expect(again.results[0]).toMatchObject({previousRevision:dialogue.revision});
    expect((await logLines()).at(-1)).toMatchObject({action:'restore',alreadyCurrent:true});
  });
  test('the newest previousRevision skips alreadyCurrent lines (a rerun does not move the one-step target)',async()=>{
    const store=new MemoryStore();await store.importPersona(dialogue,{setCurrent:true});
    await publish([persona('syn-a')],{store});await publish([persona('syn-a')],{store}); // second line: alreadyCurrent
    const result=await restore([dialogue],store,{confirm:false});
    expect(result.results[0]!.warning).toBeUndefined();
  });
  test('the list/log step failing after the transaction names the restored indexes; an unknown store error says unknown',async()=>{
    const store=new MemoryStore();await store.importPersona(dialogue,{setCurrent:true});
    await publish([persona('syn-a')],{store});
    store.afterRestore=async()=>{await rm(paths.publishLog!);await mkdir(paths.publishLog!);};
    await expect(restore([dialogue],store)).rejects.toThrow(/Restored indexes: 0 .*rerun the same restore/);
    expect(store.rows.get('persona:syn-a')!.current).toBe(dialogue.revision);
    store.afterRestore=undefined;await rm(paths.publishLog!,{recursive:true});await writeFile(paths.publishLog!,'');
    store.restoreFailure=new Error('connection reset');
    await expect(restore([dialogue],store)).rejects.toThrow(/Restored indexes: unknown/);
  });
});

describe('publish --baseline review fixes',()=>{
  const dialogue={...PersonaSchema.parse(persona('syn-b',{background:undefined,sourceRefs:['syn-b:post-1'],style:['A fictional watercolour studio runs weekend sketch walks.']})),revision:'dialogue-00000000000000bb'};
  const draft=persona('syn-b',{sourceRefs:['syn-b:post-1'],background:undefined,style:['A fictional watercolour studio runs weekend sketch walks.'],greeting:'Hi! Research AI here.'});
  const withBaseline=async(baseline:unknown[])=>{const file=join(dir,'baseline.json');await writeFile(file,JSON.stringify(baseline));return loadInputs({...paths,baseline:file});};
  test('validate and dry runs warn baseline_unverified; a confirmed publish verifies it against the target and logs it',async()=>{
    const inputs=await withBaseline([dialogue]);
    const [checked]=await validateDocuments([draft],inputs);
    expect(checked!.report).toMatchObject({ok:true,issues:[{path:'',rule:'baseline_unverified',severity:'warn'}]});
    const store=new MemoryStore();await store.importPersona(dialogue,{setCurrent:true});
    const dry=await publishDocuments({docs:[draft],inputs,paths,target:'loadtest_db',confirm:false,store,publisher:'t'});
    expect(dry.reports[0]!.issues).toContainEqual({path:'',rule:'baseline_unverified',severity:'warn'});expect(store.verifyCalls).toBe(0);
    const done=await publishDocuments({docs:[draft],inputs,paths,target:'loadtest_db',confirm:true,store,publisher:'t',now:()=>'2026-10-09T03:00:00.000Z'});
    expect(done.ok).toBe(true);expect(done.reports[0]!.issues).toEqual([]);expect(store.verifyCalls).toBe(1);
    const line=JSON.parse((await readFile(paths.publishLog!,'utf8')).trim());
    expect(line).toMatchObject({baselineRevision:dialogue.revision,previousRevision:dialogue.revision});
  });
  test('a baseline that is not the current stored revision (or differs) refuses the whole publish',async()=>{
    for(const setup of [async(store:MemoryStore)=>{await store.importPersona(dialogue,{setCurrent:true});await store.importPersona({...dialogue,revision:'silver-later'},{setCurrent:true});},
      async(store:MemoryStore)=>{await store.importPersona({...dialogue,style:['Changed in the database.']},{setCurrent:true});},async()=>undefined]) {
      const store=new MemoryStore();await setup(store);const importsBefore=store.imports,batchesBefore=store.batches;
      await expect(publishDocuments({docs:[draft],inputs:await withBaseline([dialogue]),paths,target:'loadtest_db',confirm:true,store,publisher:'t'})).rejects.toThrow(/baseline.*nothing was written/i);
      expect(store.imports).toBe(importsBefore);expect(store.batches).toBe(batchesBefore);expect(existsSync(paths.publishLog!)).toBe(false);
    }
  });
  test('a rerun of a committed publish completes: the draft revision is current and the baseline is still stored as given',async()=>{
    const store=new MemoryStore();await store.importPersona(dialogue,{setCurrent:true});
    const inputs=await withBaseline([dialogue]);
    const run=()=>publishDocuments({docs:[draft],inputs,paths,target:'loadtest_db',confirm:true,store,publisher:'t',now:()=>'2026-10-09T04:00:00.000Z'});
    await run();
    // The list/log step failed after the import committed: the rerun must not be blocked by the baseline check.
    const rerun=await run();
    expect(rerun.ok).toBe(true);expect(rerun.results[0]).toMatchObject({inserted:false,previousRevision:personaRevision(draft)});
    // A baseline stored with other content still refuses, even when the draft revision is current.
    await expect(publishDocuments({docs:[draft],inputs:await withBaseline([{...dialogue,greeting:'Not what is stored.'}]),paths,target:'loadtest_db',confirm:true,store,publisher:'t'}))
      .rejects.toThrow(/baseline/i);
  });
  test('a baseline for another personId or with another persona id grants nothing',async()=>{
    const [otherId]=await validateDocuments([draft],await withBaseline([{...dialogue,id:'persona:not-syn-b'}]));
    expect(otherId!.report.issues).toContainEqual({path:'',rule:'baseline_mismatch',severity:'error'});
    const [otherPerson]=await validateDocuments([draft],await withBaseline([{...dialogue,personId:'syn-a',id:'persona:syn-a'}]));
    expect(otherPerson!.report.issues.some(issue=>issue.rule==='baseline_unverified')).toBe(false);
  });
  test('a republish of the current revision logs alreadyCurrent',async()=>{
    const store=new MemoryStore();
    await publish([persona('syn-a')],{store});await publish([persona('syn-a')],{store});
    const lines=(await readFile(paths.publishLog!,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    expect(lines[0].alreadyCurrent).toBeUndefined();expect(lines[1].alreadyCurrent).toBe(true);
  });
});
