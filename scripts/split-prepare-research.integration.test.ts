/** Opt-in, explicitly selected freshly owned synthetic split PG; never discovers a DB/env/corpus. */
import { randomUUID, createHash } from 'node:crypto';
import { Pool } from 'pg';
import { prepare } from './prepare-research';
import { assertSplitPreparationTarget, importPreparation, type PreparationPlan } from './split-prepare-research';
const raw=process.env.PTR_SPLIT_PREPARATION_TEST_DATABASE_URL;
const suite=raw?describe:describe.skip;
suite('split preparation actual owner transaction/provenance',()=>{
  const person='synthetic-prep-'+randomUUID(),personaId='persona:'+person;
  const rows=Array.from({length:20},(_,i)=>({person_id:person,post_id:String(i),caption:`Synthetic public sketch ${i}.`,posted_at:`2020-01-${String(i+1).padStart(2,'0')}T00:00:00Z`,event_date:null,source_url:`https://example.invalid/posts/${i}`}));
  const generated=prepare(rows,[{username:person,display_name:'Synthetic Artist',category:'illustration',cohort:'domestic'}]);
  const plan=():PreparationPlan=>({...generated,authored:[],previousGenerated:[],origin:'synthetic_fixture'});
  const hash=(x:unknown)=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
  let pool:Pool;
  beforeAll(()=>{expect(assertSplitPreparationTarget(raw!)).toBe('ptr_split_test');pool=new Pool({connectionString:raw!,max:2,connectionTimeoutMillis:3000});});
  // Immutable provenance triggers prohibit DELETE. Caller must destroy its own
  // disposable synthetic container after this suite; never disable those triggers.
  afterAll(async()=>{if(pool)await pool.end();});
  test('batch imports atomically and exact rerun preserves both hashes and current pointer',async()=>{
    expect(await importPreparation(pool,'ptr_split_test',plan())).toMatchObject({inserted:20,existing:0,personasImported:1});
    expect(await importPreparation(pool,'ptr_split_test',plan())).toMatchObject({inserted:0,existing:20});
    expect((await pool.query('SELECT content_hash,source_hash,origin FROM llm.source_posts WHERE id=$1',[generated.sources[0]!.id])).rows[0]).toEqual({content_hash:hash({post:generated.sources[0],origin:'synthetic_fixture'}),source_hash:generated.sources[0]!.hash,origin:'synthetic_fixture'});
    expect((await pool.query('SELECT current_revision FROM llm.personas WHERE id=$1',[personaId])).rows[0].current_revision).toBe(generated.personas[0]!.revision);
  });
  test('mid-batch immutable source conflict rolls back a new source before persona changes',async()=>{
    const p=plan(),first=generated.sources[0]!;
    p.sources=[{...first,id:person+':rollback-source'},{...first,caption:'Changed synthetic immutable caption'}];
    await expect(importPreparation(pool,'ptr_split_test',p)).rejects.toThrow('SPLIT_PREPARATION_SOURCE_CONFLICT');
    expect((await pool.query('SELECT count(*)::int AS n FROM llm.source_posts WHERE id=$1',[person+':rollback-source'])).rows[0].n).toBe(0);
  });
  test('mid-batch immutable persona revision conflict also rolls back new sources',async()=>{
    const p=plan(),first=generated.sources[0]!;
    p.sources=[{...first,id:person+':rollback-persona'}];p.previousGenerated=generated.personas;
    p.personas=[{...generated.personas[0]!,greeting:'Changed synthetic immutable greeting'}];
    await expect(importPreparation(pool,'ptr_split_test',p)).rejects.toThrow('SPLIT_PREPARATION_PERSONA_CONFLICT');
    expect((await pool.query('SELECT count(*)::int AS n FROM llm.source_posts WHERE id=$1',[person+':rollback-persona'])).rows[0].n).toBe(0);
  });
  test('wrong connected database identity refuses before source writes',async()=>{
    await expect(importPreparation(pool,'ptr_split_research',plan())).rejects.toThrow('SPLIT_PREPARATION_OWNER_REQUIRED');
    await expect(importPreparation(pool,'ptr_split_research',{...plan(),origin:'licensed_source'})).rejects.toThrow('SPLIT_PREPARATION_IDENTITY_REQUIRED');
  });
  test('both actual connected runtime roles refuse the owner import',async()=>{
    for(const role of ['APP','LLM']) {
      const connectionString=process.env[`PTR_SPLIT_PREPARATION_TEST_${role}_DATABASE_URL`];
      if(!connectionString)throw new Error('EXPLICIT_SYNTHETIC_RUNTIME_ROLE_REQUIRED');
      const url=new URL(connectionString);
      expect(url.hostname).toBe('127.0.0.1');expect(url.port).toBe('58432');expect(url.pathname).toBe('/ptr_split_test');expect(url.username).toBe(`ptr_split_${role.toLowerCase()}`);
      const runtime=new Pool({connectionString,max:1,connectionTimeoutMillis:3000});
      try{await expect(importPreparation(runtime,'ptr_split_test',plan())).rejects.toThrow('SPLIT_PREPARATION_IDENTITY_REQUIRED');}finally{await runtime.end();}
    }
  });
  test('known prior generated baseline permits an explicit generated revision advance',async()=>{
    const p=plan();p.previousGenerated=generated.personas;p.personas=[{...generated.personas[0]!,revision:'silver-synthetic-next',greeting:'Synthetic next generated greeting'}];
    expect(await importPreparation(pool,'ptr_split_test',p)).toMatchObject({personasImported:1});
    expect((await pool.query('SELECT current_revision FROM llm.personas WHERE id=$1',[personaId])).rows[0].current_revision).toBe('silver-synthetic-next');
  });
  test('authored exclusion and missing-list fail-closed protect current publication',async()=>{
    const authored={...generated.personas[0]!,revision:'silver-synthetic-authored',identity:'Synthetic authored persona'};
    await pool.query('INSERT INTO llm.persona_versions(persona_id,revision,document,content_hash) VALUES($1,$2,$3,$4)',[personaId,authored.revision,authored,hash(authored)]);
    await pool.query('UPDATE llm.personas SET current_revision=$2 WHERE id=$1',[personaId,authored.revision]);
    expect(await importPreparation(pool,'ptr_split_test',{...plan(),authored:[authored]})).toMatchObject({authoredSkipped:1,personasImported:0});
    await expect(importPreparation(pool,'ptr_split_test',plan())).rejects.toThrow('SPLIT_PREPARATION_CURRENT_NOT_GENERATED');
    expect((await pool.query('SELECT current_revision FROM llm.personas WHERE id=$1',[personaId])).rows[0].current_revision).toBe(authored.revision);
  });
});
