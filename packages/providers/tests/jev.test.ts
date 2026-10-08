import { SAFETY_CATEGORIES, safetyWindows } from '@ptr/core';
import { DEFAULT_JEV_MODEL, JevInputSafetyClassifier, JevIntentClassifier, OpenRouterClient, ProviderError, decisionCallsExhausted, jevLabelOrder, liveOptionsFromEnvironment, type BudgetLedger, type BudgetRequest } from '../src';

const databaseUrl='postgresql://ptr_researcher:synthetic@127.0.0.1:56432/ptr_research';
const DECISIONS='https://openrouter.ai/api/alpha/decisions';
class MemoryLedger implements BudgetLedger {
  readonly requests=new Map<string,BudgetRequest>();
  constructor(private readonly cap=1_000_000,private readonly callCap=10_000) {}
  async reserve(key:string,amount:number,options?:{reservedCallFraction?:number}):Promise<{created:boolean;request:BudgetRequest}> {
    const previous=this.requests.get(key); if(previous) return {created:false,request:previous};
    if(options?.reservedCallFraction!==undefined&&decisionCallsExhausted(this.requests.size,this.callCap,options.reservedCallFraction)) throw new ProviderError('DECISION_SUBCAP');
    const total=[...this.requests.values()].reduce((sum,row)=>sum+(row.state==='settled'?row.actualMicrousd??0:Math.max(row.reservedMicrousd,row.actualMicrousd??0)),0);
    if(total+amount>this.cap) throw new ProviderError('BUDGET_EXCEEDED');
    const request:BudgetRequest={key,state:'reserved',reservedMicrousd:amount,actualMicrousd:null,response:null,generationId:null};
    this.requests.set(key,request); return {created:true,request};
  }
  async submitted(key:string):Promise<void> { this.requests.get(key)!.state='submitted'; }
  async finish(key:string,actual:number|null,response:unknown|null,generationId:string|null):Promise<void> {
    const row=this.requests.get(key)!; if(row.state==='settled') return;
    Object.assign(row,{state:actual===null?'unknown':'settled',actualMicrousd:actual,response:response??row.response,generationId:generationId??row.generationId});
  }
  async get(key:string):Promise<BudgetRequest|undefined> { return this.requests.get(key); }
}
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
// Shape documented in the OpenRouter Jev tutorial (Choice answer + usage.cost), with this classifier's labels.
const documented=(choice='timeline',probabilities:Record<string,number>={timeline:0.9,small_talk:0.1},confidence=0.8)=>({
  id:'gen-dec-synthetic',model:'typesafe/jev-1.13-20260917',provider:'TypeSafe',
  answers:{intent:{type:'choice',choice,confidence,probabilities}},usage:{input_tokens:476,output_tokens:70,cost:0.000019992}});
const jevEndpoints=(pricing:Record<string,string>={prompt:'0.000000042',completion:'0',discount:'0'})=>reply({data:{id:DEFAULT_JEV_MODEL,endpoints:[{pricing}]}});
function fakeFetch(post:(body:Record<string,unknown>)=>Response|Promise<Response>=()=>reply(documented()),pricing?:Record<string,string>) {
  return jest.fn(async (url:string|URL|Request,init?:RequestInit)=>{
    const target=String(url);
    if(target.endsWith('/embeddings/models')) return reply({data:[{id:'openai/text-embedding-3-small',pricing:{prompt:'0.00000002',completion:'0',request:'0'}}]});
    if(target.endsWith(`/models/${DEFAULT_JEV_MODEL}/endpoints`)) return jevEndpoints(pricing);
    if(target.endsWith('/models')) return reply({data:[{id:'google/gemini-3-flash-preview',pricing:{prompt:'0.0000005',completion:'0.000003',request:'0'}}]});
    return post(JSON.parse(String(init?.body??'{}')));
  });
}
const client=(fetcher:ReturnType<typeof fakeFetch>,ledger:BudgetLedger=new MemoryLedger(),extra:{decisionReservedCallFraction?:number}={})=>new OpenRouterClient({apiKey:'synthetic-private-key',liveEnabled:true,allowExternalData:true,databaseUrl,ledger,fetch:fetcher as typeof fetch,...extra});
const posts=(fetcher:ReturnType<typeof fakeFetch>)=>fetcher.mock.calls.filter(([,init])=>init?.method==='POST');
const signal=()=>new AbortController().signal;
const input={text:'요즘 뭐 하고 지내?',recentUserTurns:['안녕','오늘 날씨 좋다'],seed:'turn-synthetic-1'};

describe('Jev intent classifier adapter (mocked network)',()=>{
  test('posts a minimal Choice request to the Decisions API and parses the documented answer',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch();
    const result=await new JevIntentClassifier(client(fetcher,ledger)).classify(input,{signal:signal()});
    expect(result).toEqual({label:'timeline',confidence:0.8,probabilities:{timeline:0.9,small_talk:0.1}});
    const [[url,init]]=posts(fetcher) as [[string,RequestInit]];
    expect(url).toBe(DECISIONS);expect((init.headers as Record<string,string>).Authorization).toBe('Bearer synthetic-private-key');
    const body=JSON.parse(String(init.body));
    expect(body.model).toBe('typesafe/jev-1.13');
    expect(body.state).toEqual({earlier_user_messages:['안녕','오늘 날씨 좋다'],latest_user_message:'요즘 뭐 하고 지내?'});
    expect(Object.keys(body.questions)).toEqual(['intent']);
    expect(body.questions.intent.type).toBe('choice');
    expect(Object.keys(body.questions.intent.criteria).sort()).toEqual(['small_talk','timeline']);
    expect(body.provider).toEqual({data_collection:'deny',zdr:true,allow_fallbacks:false,max_price:{prompt:'0.05',completion:'0',request:'0'}});
    // Only the Jev endpoint price is checked: no text/embedding catalog reads for a decision.
    expect(fetcher.mock.calls.map(([target])=>String(target)).filter(target=>!target.endsWith(`/models/${DEFAULT_JEV_MODEL}/endpoints`)&&target!==DECISIONS)).toEqual([]);
    // The seed only orders labels; it is never sent.
    expect(String(init.body)).not.toContain('turn-synthetic-1');
    // Actual charge comes from usage.cost; the reservation is conservative.
    const row=[...ledger.requests.values()][0]!;
    expect(row).toMatchObject({state:'settled',actualMicrousd:20,generationId:'gen-dec-synthetic'});
    expect(row.reservedMicrousd).toBeGreaterThan(20);
  });
  test('label order rotates deterministically by seed',async()=>{
    expect(jevLabelOrder('turn-synthetic-1')).toEqual(jevLabelOrder('turn-synthetic-1'));
    const orders=new Set(Array.from({length:20},(_,i)=>jevLabelOrder(`turn-${i}`).join(',')));
    expect(orders).toEqual(new Set(['timeline,small_talk','small_talk,timeline']));
    for(const seed of ['turn-0','turn-1','turn-2','turn-3']) {
      const fetcher=fakeFetch();await new JevIntentClassifier(client(fetcher)).classify({...input,seed},{signal:signal()});
      expect(Object.keys(JSON.parse(String(posts(fetcher)[0]![1]!.body)).questions.intent.criteria)).toEqual(jevLabelOrder(seed));
    }
  });
  test('no earlier turns sends only the latest message',async()=>{
    const fetcher=fakeFetch();await new JevIntentClassifier(client(fetcher)).classify({...input,recentUserTurns:[]},{signal:signal()});
    expect(JSON.parse(String(posts(fetcher)[0]![1]!.body)).state).toEqual({latest_user_message:'요즘 뭐 하고 지내?'});
  });
  test('ledger refusal makes no POST',async()=>{
    const fetcher=fakeFetch();
    await expect(new JevIntentClassifier(client(fetcher,new MemoryLedger(1))).classify(input,{signal:signal()})).rejects.toThrow('BUDGET_EXCEEDED');
    expect(posts(fetcher)).toHaveLength(0);
  });
  test('429 and transport failures are not retried and keep the reservation',async()=>{
    for(const post of [()=>reply({error:{message:'synthetic-private-key'}},429),()=>{throw new Error('synthetic-private-key');}]) {
      const ledger=new MemoryLedger();const fetcher=fakeFetch(post);const jev=new JevIntentClassifier(client(fetcher,ledger));
      await expect(jev.classify(input,{signal:signal()})).rejects.toThrow(/PROVIDER_HTTP_429|PROVIDER_TRANSPORT/);
      expect([...ledger.requests.values()][0]!.state).toBe('unknown');
      // The same request is never resubmitted.
      await expect(jev.classify(input,{signal:signal()})).rejects.toThrow('REQUEST_UNRESOLVED_NO_RESUBMIT');
      expect(posts(fetcher)).toHaveLength(1);
    }
  });
  test('abort before the call makes no request',async()=>{
    const controller=new AbortController();controller.abort();const fetcher=fakeFetch();
    await expect(new JevIntentClassifier(client(fetcher)).classify(input,{signal:controller.signal})).rejects.toThrow('CANCELLED');
    expect(posts(fetcher)).toHaveLength(0);
  });
  test('ledger idempotency is per turn: other turns are never blocked, a retried turn never resubmits',async()=>{
    const first='turn-isolation-0';let second='';
    for(let i=1;!second;i++) if(jevLabelOrder(`turn-isolation-${i}`).join()===jevLabelOrder(first).join()) second=`turn-isolation-${i}`;
    const ledger=new MemoryLedger();let fail=true;
    const fetcher=fakeFetch(()=>{if(fail){fail=false;throw new Error('synthetic transport loss');}return reply(documented());});
    const jev=new JevIntentClassifier(client(fetcher,ledger));
    await expect(jev.classify({...input,seed:first},{signal:signal()})).rejects.toThrow('PROVIDER_TRANSPORT');
    // Same text, same body, another turn: its own key, so it is not poisoned by the unresolved request.
    await expect(jev.classify({...input,seed:second},{signal:signal()})).resolves.toMatchObject({label:'timeline'});
    expect(String(posts(fetcher)[0]![1]!.body)).toBe(String(posts(fetcher)[1]![1]!.body));
    // A lease-lost retry of the same turn reuses its key: unresolved stays unresolved, settled replays without a POST.
    await expect(jev.classify({...input,seed:first},{signal:signal()})).rejects.toThrow('REQUEST_UNRESOLVED_NO_RESUBMIT');
    await expect(jev.classify({...input,seed:second},{signal:signal()})).resolves.toMatchObject({label:'timeline'});
    expect(posts(fetcher)).toHaveLength(2);expect(ledger.requests.size).toBe(2);
  });
  test('internally consistent answers only: choice is the argmax and confidence is 2p-1',async()=>{
    await expect(new JevIntentClassifier(client(fakeFetch(()=>reply(documented('small_talk',{timeline:0.42,small_talk:0.58},0.16))))).classify(input,{signal:signal()}))
      .resolves.toEqual({label:'small_talk',confidence:0.16,probabilities:{timeline:0.42,small_talk:0.58}});
    for(const body of [documented('timeline',{timeline:0.4,small_talk:0.6},0),documented('timeline',{timeline:0.9,small_talk:0.1},0.5)])
      await expect(new JevIntentClassifier(client(fakeFetch(()=>reply(body)))).classify(input,{signal:signal()})).rejects.toThrow('INVALID_PROVIDER_RESPONSE');
  });
  test('malformed answers and other models are rejected',async()=>{
    const bad=[{...documented(),answers:{}},documented('other_label'),documented('timeline',{timeline:0.9,small_talk:0.1},1.5),documented('timeline',{timeline:0.9}),
      {...documented(),answers:{intent:{type:'noul',noul:0.9}}},{...documented(),model:'typesafe/jev-2.0'},{...documented(),model:'typesafe/jev-1.13-2026'},{...documented(),model:'typesafe/jev-1.13-evil'}];
    for(const body of bad) await expect(new JevIntentClassifier(client(fakeFetch(()=>reply(body)))).classify(input,{signal:signal()})).rejects.toThrow(/INVALID_PROVIDER_RESPONSE|MODEL_MISMATCH/);
  });
  test('unpinned/unknown models and changed prices refuse before any POST',async()=>{
    const fetcher=fakeFetch();
    await expect(new JevIntentClassifier(client(fetcher),'~typesafe/jev-latest').classify(input,{signal:signal()})).rejects.toThrow('MODEL_NOT_ALLOWED');
    for(const pricing of [{prompt:'0.0000001',completion:'0'},{prompt:'0.000000042',completion:'0.000001'},{prompt:'0.000000042',completion:'0',request:'0.01'}] as Record<string,string>[]) {
      const changed=fakeFetch(undefined,pricing);
      await expect(new JevIntentClassifier(client(changed)).classify(input,{signal:signal()})).rejects.toThrow('PRICING_CHANGED_OR_UNKNOWN_FEE');
      expect(posts(changed)).toHaveLength(0);
    }
  });
});

const safetyAnswers=(values:Record<string,number>={})=>Object.fromEntries(SAFETY_CATEGORIES.map(category=>[category,{type:'noul',noul:values[category]??0.02}]));
const withAnswers=(answers:Record<string,unknown>)=>({...documented(),answers});
describe('Jev input safety classifier (mocked network)',()=>{
  test('safety only: one request with one noul question per category and the same minimal state',async()=>{
    const fetcher=fakeFetch(()=>reply(withAnswers(safetyAnswers({sexual:0.91}))));
    const result=await new JevInputSafetyClassifier(client(fetcher)).assess({...input,intent:false,categories:SAFETY_CATEGORIES},{signal:signal()});
    expect(result.safety).toEqual({...Object.fromEntries(SAFETY_CATEGORIES.map(category=>[category,0.02])),sexual:0.91});
    expect(result).not.toHaveProperty('intent');
    const [[,init]]=posts(fetcher) as [[string,RequestInit]];const body=JSON.parse(String(init.body));
    expect(Object.keys(body.questions)).toEqual([...SAFETY_CATEGORIES]);
    for(const category of SAFETY_CATEGORIES) {
      const question=body.questions[category];
      expect(question.type).toBe('noul');expect(typeof question.instructions).toBe('string');
      // Question ids are not sent to the model: each question names latest_user_message itself.
      expect(question.instructions).toContain('latest_user_message');
      expect(Object.keys(question.criteria)).toEqual(['true','false']);
    }
    expect(body.state).toEqual({earlier_user_messages:['안녕','오늘 날씨 좋다'],latest_user_message:'요즘 뭐 하고 지내?'});
    expect(String(init.body)).not.toContain('turn-synthetic-1');
  });
  test('combined: the intent question rides in the same request, identical to the intent-only question',async()=>{
    const fetcher=fakeFetch(()=>reply(withAnswers({...documented().answers,...safetyAnswers()})));
    const result=await new JevInputSafetyClassifier(client(fetcher)).assess({...input,intent:true,categories:SAFETY_CATEGORIES},{signal:signal()});
    expect(result.intent).toEqual({label:'timeline',confidence:0.8,probabilities:{timeline:0.9,small_talk:0.1}});
    const intentOnly=fakeFetch();await new JevIntentClassifier(client(intentOnly)).classify(input,{signal:signal()});
    const combinedBody=JSON.parse(String(posts(fetcher)[0]![1]!.body));const intentBody=JSON.parse(String(posts(intentOnly)[0]![1]!.body));
    expect(Object.keys(combinedBody.questions)).toEqual(['intent',...SAFETY_CATEGORIES]);
    expect(combinedBody.questions.intent).toEqual(intentBody.questions.intent);
    expect(posts(fetcher)).toHaveLength(1);
  });
  test('invalid parts are isolated: a bad intent answer keeps safety, a bad safety answer keeps intent',async()=>{
    const badIntent=await new JevInputSafetyClassifier(client(fakeFetch(()=>reply(withAnswers({intent:{type:'choice',choice:'other'},...safetyAnswers()}))))).assess({...input,intent:true,categories:SAFETY_CATEGORIES},{signal:signal()});
    expect(badIntent.intent).toBeInstanceOf(ProviderError);expect(badIntent.safety).not.toBeInstanceOf(Error);
    for(const broken of [{sexual:{type:'noul',noul:1.2}},{sexual:{type:'choice',noul:0.2}},{sexual:undefined}]) {
      const result=await new JevInputSafetyClassifier(client(fakeFetch(()=>reply(withAnswers({...documented().answers,...safetyAnswers(),...broken}))))).assess({...input,intent:true,categories:SAFETY_CATEGORIES},{signal:signal()});
      expect(result.safety).toBeInstanceOf(ProviderError);expect(result.intent).toMatchObject({label:'timeline'});
    }
  });
  test('reservation allowance grows with the question count; the intent-only reservation is unchanged',async()=>{
    const intentLedger=new MemoryLedger();const intentFetch=fakeFetch();await new JevIntentClassifier(client(intentFetch,intentLedger)).classify(input,{signal:signal()});
    const intentRow=[...intentLedger.requests.values()][0]!;
    expect(intentRow.reservedMicrousd).toBe(Math.ceil((Buffer.byteLength(String(posts(intentFetch)[0]![1]!.body),'utf8')+1024+512)*0.05));
    // Still conservative against the measured ~490 input tokens of an intent-only request.
    expect(intentRow.reservedMicrousd).toBeGreaterThan(Math.ceil(490*0.05)*3);
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply(withAnswers(safetyAnswers())));
    await new JevInputSafetyClassifier(client(fetcher,ledger)).assess({...input,intent:false,categories:SAFETY_CATEGORIES},{signal:signal()});
    const bytes=Buffer.byteLength(String(posts(fetcher)[0]![1]!.body),'utf8');
    expect([...ledger.requests.values()][0]!.reservedMicrousd).toBe(Math.ceil((bytes+1024+512*SAFETY_CATEGORIES.length)*0.05));
  });
  test('decisions keep a share of the call cap for chat: refused below it with no POST; chat is not sub-capped',async()=>{
    expect(decisionCallsExhausted(0,10,0.2)).toBe(false);expect(decisionCallsExhausted(7,10,0.2)).toBe(false);
    expect(decisionCallsExhausted(8,10,0.2)).toBe(true);expect(decisionCallsExhausted(9,10,0)).toBe(false);expect(decisionCallsExhausted(10,10,0)).toBe(true);
    const ledger=new MemoryLedger(1_000_000,10);for(let i=0;i<8;i++) await ledger.reserve(`existing-${i}`,1);
    const fetcher=fakeFetch();
    await expect(new JevIntentClassifier(client(fetcher,ledger)).classify(input,{signal:signal()})).rejects.toThrow('DECISION_SUBCAP');
    await expect(new JevInputSafetyClassifier(client(fetcher,ledger)).assess({...input,intent:false,categories:SAFETY_CATEGORIES},{signal:signal()})).rejects.toThrow('DECISION_SUBCAP');
    expect(posts(fetcher)).toHaveLength(0);
    // A configurable fraction; 0 disables the sub-cap.
    await expect(new JevIntentClassifier(client(fetcher,ledger,{decisionReservedCallFraction:0})).classify(input,{signal:signal()})).resolves.toMatchObject({label:'timeline'});
    const reserve=jest.fn(async(key:string,amount:number,options?:{reservedCallFraction?:number})=>new MemoryLedger().reserve(key,amount,options));
    const spy:BudgetLedger={...new MemoryLedger(),reserve,submitted:async()=>undefined,finish:async()=>undefined,get:async()=>undefined};
    await new JevIntentClassifier(client(fakeFetch(),spy,{decisionReservedCallFraction:0.5})).classify(input,{signal:signal()}).catch(()=>undefined);
    expect(reserve.mock.calls[0]![2]).toEqual({reservedCallFraction:0.5});
    const chat=fakeFetch(()=>reply({id:'gen-chat',model:'google/gemini-3-flash-preview',choices:[{message:{content:'합성'}}],usage:{cost:0.00001}}));
    reserve.mockClear();await client(chat,spy).generate([{role:'user',content:'안녕'}],{signal:signal()}).catch(()=>undefined);
    expect(reserve).toHaveBeenCalledTimes(1);expect(reserve.mock.calls[0]![2]).toBeUndefined();
    for(const fraction of [1,-0.1,Number.NaN]) expect(()=>client(fakeFetch(),new MemoryLedger(),{decisionReservedCallFraction:fraction})).toThrow('INVALID_LIMIT');
    // A blank env value is rejected rather than read as 0 (sub-cap off).
    for(const value of ['',' ']) expect(()=>new OpenRouterClient({...liveOptionsFromEnvironment({OPENROUTER_API_KEY:'synthetic-private-key',GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true',GOAL1_DATABASE_URL:databaseUrl,PTR_JEV_RESERVED_CALL_FRACTION:value},new MemoryLedger()),fetch:fakeFetch() as typeof fetch})).toThrow('INVALID_LIMIT');
  });
  test('only the asked categories are sent and parsed (rule-refused turns ask self_harm alone)',async()=>{
    const fetcher=fakeFetch(()=>reply(withAnswers({self_harm:{type:'noul',noul:0.7}})));
    const result=await new JevInputSafetyClassifier(client(fetcher)).assess({...input,intent:false,categories:['self_harm']},{signal:signal()});
    expect(result.safety).toEqual({self_harm:0.7});
    expect(Object.keys(JSON.parse(String(posts(fetcher)[0]![1]!.body)).questions)).toEqual(['self_harm']);
    await expect(new JevInputSafetyClassifier(client(fetcher)).assess({...input,intent:false,categories:[]},{signal:signal()})).rejects.toThrow('INVALID_INPUT');
  });
  test('replay: the same seed never posts twice and returns the same decision',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply(withAnswers(safetyAnswers({sexual:0.93}))));
    const jev=new JevInputSafetyClassifier(client(fetcher,ledger));
    const first=await jev.assess({...input,intent:false,categories:SAFETY_CATEGORIES},{signal:signal()});
    const second=await jev.assess({...input,intent:false,categories:SAFETY_CATEGORIES},{signal:signal()});
    expect(second).toEqual(first);expect(posts(fetcher)).toHaveLength(1);expect(ledger.requests.size).toBe(1);
    // Another window of the same turn has its own key.
    await jev.assess({...input,seed:`${input.seed}#w1`,intent:false,categories:SAFETY_CATEGORIES},{signal:signal()});
    expect(posts(fetcher)).toHaveLength(2);
  });
  test('worst-case window requests (8000 JSON-escaped control characters, 7 questions + intent) stay 2 KB under the input limit',async()=>{
    const text='\u0001'.repeat(8000);const recentUserTurns=['\u0001'.repeat(300),'\u0001'.repeat(300)];
    const fetcher=fakeFetch(()=>reply(withAnswers({...documented().answers,...safetyAnswers()})));const jev=new JevInputSafetyClassifier(client(fetcher));
    const windows=safetyWindows(text);expect(windows).toHaveLength(3);
    for(const [index,window] of windows.entries())
      await jev.assess({text:window,recentUserTurns:index?[]:recentUserTurns,seed:`turn-worst#w${index}`,intent:index===0,categories:SAFETY_CATEGORIES},{signal:signal()});
    const sizes=posts(fetcher).map(([,init])=>Buffer.byteLength(String(init!.body),'utf8'));
    expect(sizes).toHaveLength(3);
    for(const size of sizes) expect(size).toBeLessThanOrEqual(32768-2048);
  });
});
