import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { PersonaSchema, SourcePostSchema, type Persona, type SourcePost } from '@ptr/contracts';
import { createLocalPool, PostgresPersonaRepository, PostgresSourceRepository } from '@ptr/storage';
interface RawPost {person_id:string;post_id:string;caption:string;posted_at:string;source_url:string;event_date:string|null}
interface Target {username:string;display_name:string;category:string;cohort:string}
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Screening is a conservative heuristic, not a privacy/injection proof or semantic redaction. */
export function unsafeCaption(caption:string):boolean {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\+?\d[\d ()-]{7,}\d)|ignore\s+(?:all|previous)\s+instructions|system\s*prompt|api[_ -]?key|credit\s*card|passport|주민등록|계좌번호|비밀번호|만\s*\d\s*세|미성년/iu.test(caption);
}
export function prepare(raw:RawPost[],targets:Target[]):{sources:SourcePost[];personas:Persona[];split:Record<string,'dev'|'test'>} {
  const snapshot=`licensed-${digest(raw).slice(0,16)}`;
  const sources=raw.map(row=>SourcePostSchema.parse({id:`${row.person_id}:${row.post_id}`,personId:row.person_id,
    caption:row.caption,postedAt:new Date(row.posted_at).toISOString(),eventDate:row.event_date,
    sourceUrl:row.source_url,hash:digest(row),snapshot,unsafe:unsafeCaption(row.caption)}));
  if(new Set(sources.map(p=>p.id)).size!==sources.length) throw new Error('Duplicate source identity');
  const split:Record<string,'dev'|'test'>={};
  const personas=targets.map(target=>{
    const rows=sources.filter(s=>s.personId===target.username&&!s.unsafe&&s.caption.trim());
    const days=[...new Set(rows.map(s=>s.postedAt.slice(0,10)))].sort();
    const cutoff=days[Math.max(0,Math.floor(days.length*0.7)-1)]??'';
    for(const row of sources.filter(s=>s.personId===target.username))split[row.id]=row.postedAt.slice(0,10)<=cutoff?'dev':'test';
    const dev=rows.filter(s=>split[s.id]==='dev');
    if(dev.length<5) throw new Error('Insufficient safe development data');
    const ko=target.cohort==='domestic';
    const hashtagRate=dev.filter(s=>s.caption.includes('#')).length/dev.length;
    const emojiRate=dev.filter(s=>/\p{Extended_Pictographic}/u.test(s.caption)).length/dev.length;
    const shortRate=dev.filter(s=>s.caption.length<160).length/dev.length;
    const style=[ko?'Use natural Korean.':'Use natural English.',
      `Use ${hashtagRate>0.5?'occasional topical hashtags':'few hashtags'} in fictional captions, not every chat response.`,
      `Use ${emojiRate>0.3?'light expressive emoji':'restrained emoji'}.`,
      shortRate>0.5?'Prefer concise conversational responses.':'Prefer descriptive but compact conversational responses.',
      `Discuss the public content category ${target.category} as creative subject matter, not private biography.`];
    const definition={id:`persona:${target.username}`,personId:target.username,label:target.display_name||target.username,
      language:ko?'ko':'en',reviewStatus:'silver' as const,identity:`Unofficial research AI inspired by the public content category ${target.category}. Not the actual person.`,
      concept:'Style-only public-caption simulation. Actual activities must use licensed source evidence; fictional ideas must stay fictional.',
      style,boundaries:['No real identity claim or endorsement.','No inferred private life, relationships, location or event dates.','Generated text/images are fictional and never source evidence.'],
      sourceRefs:dev.slice(0,12).map(s=>s.id),greeting:ko?'안녕! 실제 인물이 아닌 연구용 AI야. 공개 게시물 근거와 가상 아이디어를 구분해서 이야기할게.':'Hi! I’m an unofficial research AI, not the real person. I keep source evidence separate from fictional ideas.'};
    return PersonaSchema.parse({...definition,revision:`silver-${digest(definition).slice(0,16)}`});
  });
  if(sources.some(s=>!targets.some(t=>t.username===s.personId)))throw new Error('Source outside selected targets');
  return {sources,personas,split};
}
export async function privateJson(path:string,value:unknown):Promise<void>{
  await mkdir(path.slice(0,path.lastIndexOf('/')),{recursive:true,mode:0o700});
  await writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
}
async function main():Promise<void>{
  const raw=(await readFile('data/processed/target_posts.jsonl','utf8')).trim().split('\n').map(line=>JSON.parse(line) as RawPost);
  const manifest=JSON.parse(await readFile('data/manifests/targets.json','utf8')) as {people:Target[]};
  const prepared=prepare(raw,manifest.people);
  await privateJson('data/research/sources.json',prepared.sources);
  await privateJson('data/research/personas.json',prepared.personas);
  await privateJson('data/research/split.json',prepared.split);
  const pool=createLocalPool(process.env.DATABASE_URL??'');
  try {
    const imported=await new PostgresSourceRepository(pool).importPosts(prepared.sources,'licensed_source');
    for(const persona of prepared.personas)await new PostgresPersonaRepository(pool).importPersona(persona);
    const counts={posts:prepared.sources.length,personas:prepared.personas.length,excluded:prepared.sources.filter(s=>s.unsafe).length,
      dev:prepared.sources.filter(s=>prepared.split[s.id]==='dev').length,test:prepared.sources.filter(s=>prepared.split[s.id]==='test').length,...imported,
      reviewStatus:'silver',splitMethod:'per-person UTC calendar-day 70/30 chronological proxy; not verified same-event grouping',
      styleMethod:'Development-only length/emoji/hashtag rates and manifest category, no test captions in personas',
      extraction:'Imported event dates preserved; unknown is not inferred from postedAt',screening:'Conservative regex heuristic, not privacy/injection guarantee'};
    await privateJson('reports/preparation.json',counts);console.log(JSON.stringify(counts));
  }finally{await pool.end();}
}
if(require.main===module)void main().catch(()=>{console.error('Research preparation failed; details remain private.');process.exitCode=1;});
