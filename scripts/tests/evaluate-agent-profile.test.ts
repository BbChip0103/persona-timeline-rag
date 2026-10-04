import { PROFILE_LIMITS, matchedProfileRows, summarizeProfiles, validateProfileBudget, type ProfileRow } from '../evaluate-agent-profile';
const budget={cap_microusd:1_000_000,call_cap:1000,calls:880,actual_microusd:'235849',unresolved_microusd:'7625'};
test('paired pilot preserves global budget and does not pretend worst-case calls fit120fresh cap',()=>{
  expect(()=>validateProfileBudget(budget)).not.toThrow();
  expect(PROFILE_LIMITS).toEqual({turns:72,textCalls:144,embeddingCalls:96,freshRequests:120});
  for(const patch of [{calls:881},{call_cap:1001},{cap_microusd:1_000_001},{actual_microusd:1_000_000},{unresolved_microusd:'NaN'},{calls:-1}])expect(()=>validateProfileBudget({...budget,...patch})).toThrow();
});
test('summaries separate profiles, operational completion and failed observations, never accuracy',()=>{
  const row={executionProfile:'agent_loop',condition:'off',trace:{state:'failed',requests:[],textCalls:1,retrievalCalls:0,embeddingCalls:0,crossPersonEvidence:0,latencyMs:1}} as unknown as ProfileRow;
  const summary=summarizeProfiles([row]);expect(summary.agent_loop.controlFlow).toMatchObject({totalTurns:1,completed:0,failed:1});expect(summary.legacy.controlFlow.totalTurns).toBe(0);
  expect(JSON.stringify(summary)).not.toContain('accuracy');
});


test('completed matched subset excludes failed and missing dependent followups',()=>{
  const base={conversationId:'synthetic',userTurnId:'turn',condition:'off',trace:{state:'completed'}} as unknown as ProfileRow;
  const rows=[{...base,executionProfile:'legacy' as const},{...base,executionProfile:'agent_loop' as const},{...base,userTurnId:'failed',executionProfile:'legacy' as const},{...base,userTurnId:'failed',executionProfile:'agent_loop' as const,trace:{state:'failed'}}] as ProfileRow[];
  expect(matchedProfileRows(rows)).toHaveLength(2);
});
