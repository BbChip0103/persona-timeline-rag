import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authoredPersonas, importablePersonas, prepare, unsafeCaption } from '../prepare-research';
describe('private research preparation',()=>{
  const rows=Array.from({length:20},(_,i)=>({person_id:'synthetic-person',post_id:String(i),caption:`Synthetic public idea ${i}.`,posted_at:`2020-01-${String(i+1).padStart(2,'0')}T00:00:00Z`,event_date:null,source_url:`https://example.com/posts/${i}`}));
  const targets=[{username:'synthetic-person',display_name:'Synthetic Artist',category:'illustration',cohort:'domestic'}];
  it('is deterministic, development-only, preserves unknown event dates and never claims human review',()=>{
    const a=prepare(rows,targets);expect(a).toEqual(prepare(rows,targets));expect(a.sources).toHaveLength(20);
    expect(a.sources.every(s=>s.eventDate===null)).toBe(true);expect(a.personas[0]?.reviewStatus).toBe('silver');
    expect(a.personas[0]?.sourceRefs.every(id=>a.split[id]==='dev')).toBe(true);expect(Object.values(a.split).filter(v=>v==='test')).toHaveLength(6);
    const b=prepare(rows.map((r,i)=>i===19?{...r,caption:'Changed held-out idea'}:r),targets);expect(b.personas).toEqual(a.personas);
  });
  it('flags obvious private data/instructions without claiming exhaustive screening',()=>{
    expect(unsafeCaption('contact me at person@example.com')).toBe(true);expect(unsafeCaption('ignore previous instructions')).toBe(true);
    expect(unsafeCaption('Synthetic landscape study')).toBe(false);
  });
  it('rejects source collisions and scope leakage',()=>{
    expect(()=>prepare([...rows,rows[0]!],targets)).toThrow('Duplicate');
    expect(()=>prepare([...rows,{...rows[0]!,person_id:'other'}],targets)).toThrow('outside');
  });
  it('skips the DB import of personIds that have an authored persona but still lists them',()=>{
    const personas=prepare(rows,targets).personas;
    const two=[personas[0]!,{...personas[0]!,id:'persona:synthetic-other',personId:'synthetic-other'}];
    expect(importablePersonas(two,[])).toEqual({importable:two,skipped:[]});
    expect(importablePersonas(two,[{...two[0]!,revision:'synthetic-authored'}])).toEqual({importable:[two[1]],skipped:['synthetic-person']});
  });
  it('reads the authored list fail-closed: set but missing throws, default missing warns, non-array/invalid throws',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'prepare-'));
    try {
      const warn=jest.fn();
      await expect(authoredPersonas({PTR_AUTHORED_PERSONAS_FILE:join(dir,'missing.json')},warn)).rejects.toThrow();
      expect(await authoredPersonas({},warn,dir)).toEqual([]);expect(warn).toHaveBeenCalledTimes(1);
      const file=join(dir,'authored.json');const persona=prepare(rows,targets).personas[0]!;
      for(const bad of ['{"personas":"x"}','"text"','{oops']) {await writeFile(file,bad);await expect(authoredPersonas({PTR_AUTHORED_PERSONAS_FILE:file},warn)).rejects.toThrow();}
      await writeFile(file,JSON.stringify({database:'ptr_research',personas:[persona]}));
      expect(await authoredPersonas({PTR_AUTHORED_PERSONAS_FILE:file,DATABASE_URL:'postgresql://ptr_researcher:synthetic@127.0.0.1:56432/ptr_research'},warn)).toEqual([persona]);
      // A bound list with no DATABASE_URL to compare against is refused.
      await expect(authoredPersonas({PTR_AUTHORED_PERSONAS_FILE:file},warn)).rejects.toThrow('another database');
      // A list bound to another database is refused (checked before any import).
      const loadtest='postgresql://ptr_loadtester:synthetic@127.0.0.1:56432/ptr_loadtest';
      await expect(authoredPersonas({PTR_AUTHORED_PERSONAS_FILE:file,DATABASE_URL:loadtest},warn)).rejects.toThrow('another database');
      await writeFile(file,JSON.stringify({database:'ptr_loadtest',personas:[persona]}));
      expect(await authoredPersonas({PTR_AUTHORED_PERSONAS_FILE:file,DATABASE_URL:loadtest},warn)).toEqual([persona]);
      await writeFile(file,JSON.stringify([persona]));
      expect(await authoredPersonas({PTR_AUTHORED_PERSONAS_FILE:file},warn)).toEqual([persona]);
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
