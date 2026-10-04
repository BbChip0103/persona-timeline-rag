import type { Pool } from 'pg';
import type { Persona } from '@ptr/contracts';
import { createHash } from 'node:crypto';
import { activateRefinement } from '../activate-persona-refinement';
const originals:Persona[]=Array.from({length:4},(_,i)=>({id:`persona-${i}`,personId:`person-${i}`,label:'Synthetic',language:'ko',revision:'old',reviewStatus:'silver',identity:'Research AI',concept:'Synthetic',style:[],boundaries:['AI'],sourceRefs:[],greeting:'AI greeting'}));
const next=originals.map(p=>({...p,revision:'new',concept:'New design'}));
function setup(patch:{current?:string;existing?:string}={}) {
  const query=jest.fn(async(sql:string,params?:unknown[])=>{
    const p=originals.find(p=>p.id===params?.[0]);
    if(sql.startsWith('SELECT person_id'))return {rows:[{person_id:p!.personId,current_revision:patch.current??'old'}]};
    if(sql.startsWith('SELECT document'))return {rows:[{document:p}]};
    if(sql.startsWith('SELECT content_hash'))return {rows:patch.existing?[{content_hash:patch.existing==='valid'?createHash('sha256').update(JSON.stringify(next.find(n=>n.id===p!.id))).digest('hex'):patch.existing}]:[]};
    return {rows:[]};
  });
  const release=jest.fn();const pool={connect:jest.fn(async()=>({query,release}))} as unknown as Pool;
  return {pool,query,release};
}
test('four versions publish in one transaction without changing old versions or sessions',async()=>{
  const h=setup();expect(await activateRefinement(h.pool,originals,next)).toEqual({personas:4,inserted:4});
  expect(h.query.mock.calls[0][0]).toBe('BEGIN');expect(h.query.mock.calls.at(-1)![0]).toBe('COMMIT');
  expect(h.query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO persona_versions'))).toHaveLength(4);
  expect(h.query.mock.calls.map(([sql])=>sql).join(' ')).not.toMatch(/DELETE|UPDATE persona_versions|chat_sessions|chat_messages/);
  expect(h.release).toHaveBeenCalledTimes(1);
});
test('same published bundle is idempotent and does not insert another version',async()=>{
  const h=setup({current:'new',existing:'valid'});expect(await activateRefinement(h.pool,originals,next)).toEqual({personas:4,inserted:0});
});
test.each([{current:'unrelated'},{existing:'conflict'}])('unexpected pointer or immutable-version conflict rolls back atomically',async patch=>{
  const h=setup(patch);await expect(activateRefinement(h.pool,originals,next)).rejects.toThrow();
  expect(h.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');expect(h.query.mock.calls.map(([sql])=>sql)).not.toContain('COMMIT');expect(h.release).toHaveBeenCalledTimes(1);
});
test('changed identity/person/language or duplicate persona is rejected before connecting',async()=>{
  for(const patch of [{personId:'other'},{identity:'Real person'},{language:'en'}]){
    const h=setup();await expect(activateRefinement(h.pool,originals,next.map((p,i)=>i? p:{...p,...patch}))).rejects.toThrow();expect(h.pool.connect).not.toHaveBeenCalled();
  }
  const h=setup();await expect(activateRefinement(h.pool,originals,[next[0],next[0],next[2],next[3]])).rejects.toThrow();expect(h.pool.connect).not.toHaveBeenCalled();
});
