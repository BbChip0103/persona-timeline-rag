import { providerRequestScope, PostgresBudgetLedger } from '../src/budget';
const uuid='11111111-2222-4333-8444-555555555555';
test('only explicit UUID turn keys link chat/Jev windows; stable drafts never impersonate turns',()=>{
  expect(providerRequestScope(uuid,'chat')).toEqual({kind:'chat',turnId:uuid});
  expect(providerRequestScope(uuid,'decision')).toEqual({kind:'decision',turnId:uuid});
  expect(providerRequestScope(`${uuid}#w2`,'decision')).toEqual({kind:'decision',turnId:uuid});
  expect(providerRequestScope('draft:synthetic-owner:synthetic-client-key#w1','decision')).toEqual({kind:'draft'});
  expect(providerRequestScope(`draft:${uuid}`,'chat')).toEqual({kind:'draft'});
  for(const key of [undefined,'synthetic-turn-1','body-hash','UUID#wno',`${uuid}#wrong`])expect(providerRequestScope(key,'decision')).toBeUndefined();
  expect(providerRequestScope(`${uuid}#w2`,'chat')).toBeUndefined();
});
test('invalid scope is rejected before any SQL/network work',async()=>{
  const databaseUrl='postgresql://ptr_framework_tester:synthetic@127.0.0.1:57432/ptr_framework_test';
  const connect=jest.fn();const ledger=new PostgresBudgetLedger({options:{connectionString:databaseUrl},connect} as never,databaseUrl);
  for(const scope of [{kind:'chat'},{kind:'decision',turnId:'body-hash'},{kind:'draft',turnId:uuid},{kind:'wrong'}])
    await expect(ledger.reserve('synthetic-hash',1,{scope} as never)).rejects.toThrow('INVALID_REQUEST_SCOPE');
  expect(connect).not.toHaveBeenCalled();
});

test('actual Jev/OpenRouter reserve site persists window turn scope and keeps stable draft scope standalone',async()=>{
  const { OpenRouterClient }=await import('../src/openrouter');
  const { JevIntentClassifier,DEFAULT_JEV_MODEL }=await import('../src/jev');
  const reserve=jest.fn(async(key:string,reservedMicrousd:number,_options?:import('../src/budget').BudgetReserveOptions)=>({created:true,
    request:{key,state:'reserved' as const,reservedMicrousd,actualMicrousd:null,response:null,generationId:null}}));
  const ledger={reserve,submitted:jest.fn(async()=>undefined),finish:jest.fn(async()=>undefined),get:jest.fn(async()=>undefined)};
  const fetcher=jest.fn(async(url:string|URL|Request)=>new Response(JSON.stringify(String(url).endsWith(`/models/${DEFAULT_JEV_MODEL}/endpoints`)
    ?{data:{endpoints:[{pricing:{prompt:'0.000000042',completion:'0'}}]}}
    :{id:'synthetic-decision',model:DEFAULT_JEV_MODEL,usage:{cost:0.000001},answers:{intent:{type:'choice',choice:'timeline',confidence:0.8,probabilities:{timeline:0.9,small_talk:0.1}}}}),{headers:{'content-type':'application/json'}}));
  const client=new OpenRouterClient({apiKey:'synthetic-only-token',liveEnabled:true,allowExternalData:true,
    databaseUrl:'postgresql://ptr_framework_tester:synthetic@127.0.0.1:57432/ptr_framework_test',ledger,fetch:fetcher});
  const classifier=new JevIntentClassifier(client);
  await classifier.classify({text:'Synthetic window',recentUserTurns:[],seed:`${uuid}#w3`},{signal:new AbortController().signal});
  expect(reserve.mock.calls[0]![2]).toEqual({reservedCallFraction:0.2,scope:{kind:'decision',turnId:uuid}});
  await classifier.classify({text:'Synthetic draft',recentUserTurns:[],seed:'draft:synthetic-owner:synthetic-client-key#w1'},{signal:new AbortController().signal});
  expect(reserve.mock.calls[1]![2]).toEqual({reservedCallFraction:0.2,scope:{kind:'draft'}});
});
