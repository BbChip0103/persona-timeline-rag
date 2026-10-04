import type { ChatTurn } from '@ptr/contracts';
import { publicTurn } from '../src/public-turn';
test('public turn explicit allowlist excludes unknown runtime fields, state, sourceContext and raw tool query',()=>{
  const turn:ChatTurn={id:'turn',sessionId:'session',ownerId:'private-owner',clientRequestId:'req',userText:'안녕',sequence:1,state:'completed',createdAt:'2024-01-01T00:00:00Z',reply:{sessionId:'session',turnId:'turn',messageId:'message',personId:'person',personaRevision:'v1',responseKind:'small_talk',status:'answered',content:'안녕!',claims:[],evidence:[],limitations:[],agent:{revision:'v1',promptRevision:'v1',modelCalls:2,toolCalls:1,variables:{conversationTopic:'private-topic',tone:'warm'},decisionSummary:'private-summary',steps:[{phase:'tool',iteration:0,query:'private-tool-query'}],validator:'disabled'},sourceContext:{revision:'v1',references:[]},retrievalContext:{revision:'v1',action:'search',query:'private-tool-query',contextTurnIds:[],reusedSourceIds:[]}}};
  const raw=JSON.stringify(publicTurn({...turn,rawProvider:'private-raw'} as ChatTurn));
  expect(raw).toContain('안녕!');for(const value of ['private-owner','private-topic','private-summary','private-tool-query','private-raw','sourceContext','retrievalContext'])expect(raw).not.toContain(value);
});
