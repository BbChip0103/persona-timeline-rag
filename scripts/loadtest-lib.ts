import type { Persona, SourcePost } from '@ptr/contracts';

export type TurnOutcome='completed'|'failed'|'rejected'|'stuck';
/** acceptMs: POST /turns round trip. e2eMs: POST start until a terminal turn state (null when never terminal/accepted). */
export interface TurnSample { outcome:TurnOutcome; acceptMs:number|null; e2eMs:number|null; errorCode:string|null }

export function percentile(values:number[],p:number):number|null {
  if(!values.length) return null;
  const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(p/100*sorted.length)-1))]!;
}
function spread(values:number[]) {
  return {p50:percentile(values,50),p95:percentile(values,95),p99:percentile(values,99),max:values.length?Math.max(...values):null};
}
export function summarizeStage(samples:TurnSample[],windowMs:number) {
  const count=(outcome:TurnOutcome)=>samples.filter(sample=>sample.outcome===outcome).length;
  const completed=samples.filter(sample=>sample.outcome==='completed');
  const errors:Record<string,number>={};
  for(const sample of samples) if(sample.errorCode) errors[sample.errorCode]=(errors[sample.errorCode]??0)+1;
  return {
    turns:{attempted:samples.length,completed:completed.length,failed:count('failed'),rejected:count('rejected'),stuck:count('stuck')},
    completedPerSecond:completed.length/(windowMs/1000),
    e2eMs:spread(completed.map(sample=>sample.e2eMs!)),
    acceptMs:spread(samples.flatMap(sample=>sample.acceptMs===null?[]:[sample.acceptMs])),
    errors,
  };
}

/** Fictional fixtures only: load tests never touch real personas, posts or images. */
const TOPICS=['파란 책','산책','커피','공연','바다','요리','전시','자전거'];
export function syntheticCorpus(personaCount:number,postsPerPersona:number):{personas:Persona[];posts:SourcePost[]} {
  const personas:Persona[]=[];const posts:SourcePost[]=[];
  for(let p=1;p<=personaCount;p++) {
    const personId=`loadtest-person-${p}`;
    personas.push({id:`loadtest-persona-${p}`,personId,label:`합성 캐릭터 ${p}`,language:'ko',revision:'loadtest-v1',reviewStatus:'synthetic',
      identity:'부하 테스트용 가상 캐릭터. 실존 인물이 아니다.',concept:'합성 일상 대화',style:['밝은 반말','짧은 문장'],
      boundaries:['실제 활동을 주장하지 않는다'],sourceRefs:[],greeting:'안녕! 부하 테스트용 합성 캐릭터야.'});
    for(let i=1;i<=postsPerPersona;i++) {
      const topic=TOPICS[(p+i)%TOPICS.length]!;
      const day=String(1+(i%28)).padStart(2,'0'), month=String(1+(i%12)).padStart(2,'0');
      posts.push({id:`loadtest-post-${p}-${i}`,personId,caption:`합성 캡션 ${i}: ${topic} 이야기와 오늘의 기록 #${topic.replace(' ','')}`,
        postedAt:`2024-${month}-${day}T09:00:00Z`,eventDate:null,sourceUrl:`https://example.com/loadtest/${p}/${i}`,
        hash:`loadtest-hash-${p}-${i}`,snapshot:'loadtest-snapshot-v1',unsafe:false});
    }
  }
  return {personas,posts};
}
/** Mix of small talk and memory questions (the latter trigger retrieval), like Goal1 chat traffic. */
export const LOADTEST_QUESTIONS=['안녕! 오늘 기분 어때?','요즘 뭐 하고 지내?','파란 책 이야기 기억나?','산책했던 날 얘기해줘',
  '커피 좋아해?','바다 갔던 게시물 있었지?','주말에 뭐 할 거야?','전시 보러 갔던 거 어땠어?'];
