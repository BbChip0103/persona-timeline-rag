import type { ChatMessage, Persona, ProviderMessage } from '@ptr/contracts';
import { SAFETY_DEFLECTION_NOTE, buildExperimentContext } from '@ptr/core';
import { commonPrefixBytes, deflected, prefixGains, serialize, summarize, toS7Layout } from '../prompt-prefix-gain';

const persona:Persona={id:'gain-a',personId:'gain-person',label:'A',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional painter',concept:'Research',style:[],boundaries:[],sourceRefs:[],greeting:'안녕'};
const message=(role:'user'|'assistant',content:string):ChatMessage=>({id:`m-${content}`,sessionId:'s',turnId:'t',role,content,createdAt:'2024-01-01T00:00:00Z'});
const history=[message('assistant','안녕'),message('user','숲 그렸어?'),message('assistant','응')];
const state:ProviderMessage={role:'system',content:'AGENT_STATE_JSON_DATA {"tone":"warm"}'},tools:ProviderMessage={role:'system',content:'AGENT_TOOLS_JSON_DATA []'};
const transcript:ProviderMessage[]=[{role:'assistant',content:'{"function":{}}'},{role:'user',content:'TOOL_RESULT_JSON_DATA {}'}];
/** What the previous layout (before the cache-friendly prompt layout) rendered for the same inputs. */
function previousLayout(note:boolean):ProviderMessage[] {
  const s7=buildExperimentContext(persona,history,'언제?',[],{afterHistory:[state,tools],afterUser:transcript}).messages;
  const [policy,definition,...rest]=s7;
  return [{role:'system',content:note?`${policy!.content} ${SAFETY_DEFLECTION_NOTE}`:policy!.content},definition!,state,tools,...rest.filter(m=>m!==state&&m!==tools)];
}

describe('offline prefix-gain estimate',()=>{
  test('rebuilding a previous-layout call gives exactly what buildExperimentContext now renders (with and without a note)',()=>{
    for(const note of [false,true]) {
      const now=buildExperimentContext(persona,history,'언제?',[],{afterHistory:[state,tools],afterUser:transcript,...(note?{policyNote:SAFETY_DEFLECTION_NOTE}:{})}).messages;
      expect(previousLayout(note)).not.toEqual(now);
      expect(toS7Layout(previousLayout(note))).toEqual(now);
    }
    expect(deflected(previousLayout(false),'s7')).toEqual(toS7Layout(previousLayout(true)));
    expect(deflected(previousLayout(false),'previous')).toEqual(previousLayout(true));
  });
  test('common prefix in bytes; gains are whole blocks, split into global (other conversations) and session',()=>{
    expect(commonPrefixBytes(Buffer.from('abcd'),Buffer.from('abXd'))).toBe(2);
    const turn=(conversationId:string,turnIndex:number,user:string)=>({conversationId,turnIndex,messages:[{role:'system' as const,content:'p'.repeat(400)},{role:'user' as const,content:user}]});
    const gains=prefixGains([turn('a',0,'x'.repeat(200)),turn('a',1,`${'x'.repeat(200)}y`),turn('b',0,'z')],{bytesPerToken:4,blockTokens:16});
    expect(gains[0]).toMatchObject({globalTokens:0,sessionTokens:0});
    // Conversation a's second call shares ~620 bytes with its first one (= 155 tokens → 144 in whole 16-token blocks).
    expect(gains[1]).toMatchObject({globalTokens:0,sessionTokens:144});
    const policyOnly=Math.floor(serialize([{role:'system',content:'p'.repeat(400)}]).length/4/16)*16;
    expect(gains[2]!.globalTokens).toBe(policyOnly);expect(gains[2]!.sessionTokens).toBe(policyOnly);
    const summary=summarize(gains);
    expect(summary).toMatchObject({calls:3,sessions:2});expect(summary.byTurn.map(t=>t.turnIndex)).toEqual([0,1]);
    expect(summary.overall.session!).toBeGreaterThan(summary.overall.global!);
  });
});
