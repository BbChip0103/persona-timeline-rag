import { prepare, unsafeCaption } from '../prepare-research';
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
});
