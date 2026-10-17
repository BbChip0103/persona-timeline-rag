import type { Pool } from 'pg';
import type { Persona } from '@ptr/contracts';
import { PostgresPersonaRepository } from '../src/personas';

/** Mocked client (no database): the SQL decisions of importPersona, including the publish CLI's setCurrent behavior. */
const persona:Persona={id:'persona-synthetic',personId:'synthetic',label:'Synthetic',language:'ko',revision:'synthetic-v2',reviewStatus:'synthetic',
  identity:'Fictional',concept:'test',style:[],boundaries:[],sourceRefs:[],greeting:'안녕'};
function setup(state:{current?:string;existingHash?:'same'|'other'}) {
  const query=jest.fn(async(sql:string)=>{
    if(sql.startsWith('SELECT current_revision'))return {rows:state.current?[{current_revision:state.current}]:[]};
    if(sql.startsWith('SELECT person_id'))return {rows:[{person_id:persona.personId}]};
    if(sql.startsWith('SELECT content_hash')) {
      if(!state.existingHash)return {rows:[],rowCount:0};
      const {createHash}=jest.requireActual('node:crypto') as typeof import('node:crypto');
      return {rows:[{content_hash:state.existingHash==='same'?createHash('sha256').update(JSON.stringify(persona)).digest('hex'):'other'}],rowCount:1};
    }
    return {rows:[],rowCount:0};
  });
  const pool={connect:jest.fn(async()=>({query,release:jest.fn()}))} as unknown as Pool;
  const updates=()=>query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE personas SET current_revision'));
  return {repo:new PostgresPersonaRepository(pool),updates};
}
test('a new revision is inserted and becomes current; the previous pointer is reported',async()=>{
  const h=setup({current:'synthetic-v1'});
  expect(await h.repo.importPersona(persona)).toEqual({inserted:true,previousRevision:'synthetic-v1'});expect(h.updates()).toHaveLength(1);
});
test('an existing revision does not move the pointer by default (prepare-research, evaluation fixtures)',async()=>{
  const h=setup({current:'silver-generated',existingHash:'same'});
  expect(await h.repo.importPersona(persona)).toEqual({inserted:false,previousRevision:'silver-generated'});expect(h.updates()).toHaveLength(0);
});
test('setCurrent makes an existing revision current again (publish CLI)',async()=>{
  const h=setup({current:'silver-generated',existingHash:'same'});
  expect(await h.repo.importPersona(persona,{setCurrent:true})).toEqual({inserted:false,previousRevision:'silver-generated'});expect(h.updates()).toHaveLength(1);
});
test('changed content under the same revision is still a conflict, with or without setCurrent',async()=>{
  for(const options of [{},{setCurrent:true}]) await expect(setup({current:'x',existingHash:'other'}).repo.importPersona(persona,options)).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
});
test('importPersonas: several personas in ONE transaction on one client; a conflict rolls every one back',async()=>{
  const second:Persona={...persona,id:'persona-synthetic-2',personId:'synthetic-2'};
  const run=async(conflictOn?:string)=>{
    const query=jest.fn(async(sql:string,params?:unknown[])=>{
      if(sql.startsWith('SELECT current_revision'))return {rows:[{current_revision:'old'}]};
      if(sql.startsWith('SELECT person_id'))return {rows:[{person_id:params?.[0]===second.id?second.personId:persona.personId}]};
      if(sql.startsWith('SELECT content_hash'))return params?.[0]===conflictOn?{rows:[{content_hash:'other'}],rowCount:1}:{rows:[],rowCount:0};
      return {rows:[],rowCount:0};
    });
    const connect=jest.fn(async()=>({query,release:jest.fn()}));
    const repo=new PostgresPersonaRepository({connect} as unknown as Pool);
    const result=await repo.importPersonas([persona,second],{setCurrent:true}).then(value=>value,error=>error as Error);
    return {result,connect,sql:query.mock.calls.map(([sql])=>sql)};
  };
  const ok=await run();
  expect(ok.result).toEqual([{inserted:true,previousRevision:'old'},{inserted:true,previousRevision:'old'}]);
  expect(ok.connect).toHaveBeenCalledTimes(1);
  expect(ok.sql.filter(sql=>sql==='BEGIN')).toHaveLength(1);expect(ok.sql.at(-1)).toBe('COMMIT');
  expect(ok.sql.filter(sql=>sql.startsWith('INSERT INTO persona_versions'))).toHaveLength(2);
  const failed=await run(second.id);
  expect(failed.result).toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  expect(failed.sql).not.toContain('COMMIT');expect(failed.sql.at(-1)).toBe('ROLLBACK');
});
test('restoreRevisions: one transaction; a missing or different stored document rolls back; nothing is inserted',async()=>{
  const second:Persona={...persona,id:'persona-synthetic-2',personId:'synthetic-2'};
  const run=async(missing?:string,otherPerson=false)=>{
    const query=jest.fn(async(sql:string,params?:unknown[])=>{
      if(sql.startsWith('SELECT current_revision'))return {rows:[{current_revision:'silver-new',person_id:otherPerson?'someone-else':params?.[0]===second.id?second.personId:persona.personId}]};
      if(sql.startsWith('SELECT 1 FROM persona_versions'))return params?.[0]===missing?{rows:[],rowCount:0}:{rows:[{}],rowCount:1};
      return {rows:[],rowCount:0};
    });
    const connect=jest.fn(async()=>({query,release:jest.fn()}));
    const repo=new PostgresPersonaRepository({connect} as unknown as Pool);
    const result=await repo.restoreRevisions([persona,second]).then(value=>value,error=>error as Error);
    return {result,sql:query.mock.calls.map(([sql])=>sql),params:query.mock.calls.map(([,params])=>params)};
  };
  const ok=await run();
  expect(ok.result).toEqual([{previousRevision:'silver-new'},{previousRevision:'silver-new'}]);
  expect(ok.sql.filter(sql=>sql.startsWith('INSERT'))).toHaveLength(0);
  expect(ok.sql.filter(sql=>sql.startsWith('UPDATE personas SET current_revision'))).toHaveLength(2);
  // The stored document is compared as jsonb against the exact document given.
  expect(ok.params.find((_,i)=>ok.sql[i]!.startsWith('SELECT 1 FROM persona_versions'))).toEqual([persona.id,persona.revision,JSON.stringify(persona)]);
  expect(ok.sql.at(-1)).toBe('COMMIT');
  const missing=await run(second.id);
  expect(missing.result).toMatchObject({code:'NOT_FOUND'});expect(missing.sql.at(-1)).toBe('ROLLBACK');
  const other=await run(undefined,true);
  expect(other.result).toMatchObject({code:'NOT_FOUND'});expect(other.sql).not.toContain('COMMIT');
});
test('verifyBaselines: the baseline is stored exactly as given, and current is the baseline or the draft revision (a rerun)',async()=>{
  const query=jest.fn(async(_sql:string,params?:unknown[])=>({rows:[{person_id:persona.personId,current_revision:params?.[0]==='persona-rerun'?'draft-rev':'base-rev',stored:params?.[1]!=='base-missing'}],rowCount:1}));
  const repo=new PostgresPersonaRepository({query} as unknown as Pool);
  const base={...persona,revision:'base-rev'};
  expect(await repo.verifyBaselines([{baseline:base,draftRevision:'draft-rev'},{baseline:{...base,id:'persona-rerun'},draftRevision:'draft-rev'},
    {baseline:{...base,id:'persona-rerun'},draftRevision:'other'},{baseline:{...base,revision:'base-missing'},draftRevision:'draft-rev'},
    {baseline:{...base,personId:'someone-else'},draftRevision:'draft-rev'}])).toEqual([true,true,false,false,false]);
  expect(query.mock.calls[0]![0]).toMatch(/v\.revision=\$2 AND v\.document=\$3::jsonb/);
  expect(query.mock.calls[0]![1]).toEqual([persona.id,'base-rev',JSON.stringify(base)]);
});
