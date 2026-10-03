import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Persona, SourcePost } from '@ptr/contracts';
import { privateJson } from './prepare-research';
const nextDay=(day:string)=>new Date(Date.parse(`${day}T00:00:00Z`)+86400000).toISOString().slice(0,10);
async function main():Promise<void>{
  const personas=JSON.parse(await readFile('data/research/personas.json','utf8')) as Persona[];
  const sources=JSON.parse(await readFile('data/research/sources.json','utf8')) as SourcePost[];
  const split=JSON.parse(await readFile('data/research/split.json','utf8')) as Record<string,'dev'|'test'>;
  const cases:unknown[]=[];const scenarios:unknown[]=[];const extraction:unknown[]=[];
  for(const [personIndex,p] of personas.entries()){
    const safe=sources.filter(s=>s.personId===p.personId&&!s.unsafe&&s.caption.trim()&&split[s.id]==='test').sort((a,b)=>a.postedAt.localeCompare(b.postedAt));
    const days=[...new Set(safe.map(s=>s.postedAt.slice(0,10)))];
    const selected=Array.from({length:8},(_,i)=>safe.find(s=>s.postedAt.startsWith(days[Math.floor((i+0.5)*days.length/8)]!))!);
    const base={personId:p.personId,personaId:p.id,personaRevision:p.revision,timezone:'UTC',split:'test',splitProxy:'person_posted_day'};
    const ko=p.language==='ko';
    for(const [i,s] of selected.entries()){
      const day=s.postedAt.slice(0,10);const tokens=s.caption.match(/[\p{L}][\p{L}\p{N}]{2,24}/gu)??[];
      const word=tokens.find(t=>!['the','and','this','that','with','for','you','was','are'].includes(t.toLowerCase()))??tokens[0]??'public';
      const dateScoped=i%2===0;
      cases.push({...base,id:`p${personIndex}-supported-${i}`,category:'caption_supported',intent:'timeline',
        text:ko?`${dateScoped?day+' UTC에 게시된 ':''}공개 게시물 중 '${word}'와 관련된 캡션 문구를 근거로 보여줘. 실제 사건 날짜로 추측하지 마.`:`Show exact public-caption evidence about '${word}'${dateScoped?' published on '+day+' UTC':''}. Do not infer an event date.`,
        goldSourceIds:[s.id],timeline:{query:word,...(dateScoped?{start:day,end:nextDay(day)}:{}),dateBasis:'posted',limit:5}});
    }
    for(let i=0;i<2;i++){
      const s=selected[i]!;const day=s.postedAt.slice(0,10);
      cases.push({...base,id:`p${personIndex}-event-${i}`,category:'event_date_unknown',intent:'timeline',goldSourceIds:[],
        text:ko?`${day}에 실제로 일어난 활동을 알려줘. 게시 날짜가 아니라 사건 날짜가 필요해.`:`What actually happened on ${day}? I need the event date, not the post date.`,timeline:{query:'activity',start:day,end:nextDay(day),dateBasis:'event',limit:5}});
    }
    const absentCount=personIndex<2?2:1;
    for(let i=0;i<absentCount;i++)cases.push({...base,id:`p${personIndex}-absent-${i}`,category:'absent',intent:'timeline',goldSourceIds:[],text:ko?'2035년 1월 1일 공개 게시물 활동을 알려줘.':'Show public post activities on January 1, 2035.',timeline:{query:'unique-nonexistent-2035',start:'2035-01-01',end:'2035-01-02',dateBasis:'posted',limit:5}});
    cases.push({...base,id:`p${personIndex}-clarify`,category:'clarification',intent:'clarification',goldSourceIds:[],text:ko?'언제를 말하는지 모르겠어. 날짜 기준부터 정해줘.':'I have not chosen a date or whether I mean posted or event date. Please clarify.'});
    for(let scenario=0;scenario<3;scenario++){
      const s=selected[scenario]!;const day=s.postedAt.slice(0,10);
      scenarios.push({...base,id:`p${personIndex}-scenario-${scenario}`,fixedHistory:[{role:'user',content:'For this chat my nickname is Blue.'},{role:'assistant',content:'I will use Blue as your nickname in this conversation.'}],turns:[
        {id:'greet',text:ko?'안녕, 이 대화에서 내 별명은 Blue야.':'Hello, my nickname in this conversation is Blue.',intent:'small_talk'},
        {id:'creative',text:ko?'가상의 편안한 아침 아이디어 하나만 추천해줘.':'Suggest one fictional relaxing morning idea.',intent:'small_talk'},
        {id:'memory',text:ko?'아까 이 대화에서 정한 내 별명이 뭐였지?':'What nickname did I give earlier in this chat?',intent:'small_talk'},
        {id:'source',text:ko?`${day} UTC에 게시한 공개 캡션 내용을 보여줘.`:`Show the public caption published on ${day} UTC.`,intent:'timeline',timeline:{query:s.caption.match(/[\p{L}]{3,20}/u)?.[0]??'post',start:day,end:nextDay(day),dateBasis:'posted',limit:5}},
        {id:'unknown',text:ko?'2035년 1월 1일에 실제로 뭘 했어?':'What actually happened on January 1, 2035?',intent:'timeline',timeline:{query:'activity',start:'2035-01-01',end:'2035-01-02',dateBasis:'event',limit:5}},
      ]});
    }
    for(const s of safe.slice(0,personIndex<2?13:12))extraction.push({id:`extraction-${extraction.length}`,sourceId:s.id,split:'test',silverExpectedEventDate:s.eventDate});
  }
  const body={version:'goal1-eval-v1',labelStatus:'silver_nonhuman',cases,extraction,scenarios,
    methodology:{split:'Per-person chronological UTC-day proxy, not verified same-event or human heldout.',questions:'Source-derived keyword probes, half date-scoped; easy lexical bias, not independent natural questions.',gold:'Source IDs fixed before retrieval, silver labels only.',extraction:'Preserved normalized unknown dates, consistency check only; no independently labeled event-date truth.'}};
  const revision=createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0,16);
  await privateJson('data/research/evaluation.json',{...body,revision});
  console.log(JSON.stringify({cases:cases.length,extraction:extraction.length,scenarios:scenarios.length,revision,labelStatus:'silver_nonhuman'}));
}
if(require.main===module)void main().catch(()=>{console.error('Private evaluation preparation failed.');process.exitCode=1;});
