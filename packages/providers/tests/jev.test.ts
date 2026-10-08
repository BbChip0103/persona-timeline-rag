import { DEFAULT_JEV_MODEL, JevIntentClassifier, OpenRouterClient, ProviderError, jevLabelOrder, type BudgetLedger, type BudgetRequest } from '../src';

const databaseUrl='postgresql://ptr_researcher:synthetic@127.0.0.1:56432/ptr_research';
const DECISIONS='https://openrouter.ai/api/alpha/decisions';
class MemoryLedger implements BudgetLedger {
  readonly requests=new Map<string,BudgetRequest>();
  constructor(private readonly cap=1_000_000) {}
  async reserve(key:string,amount:number):Promise<{created:boolean;request:BudgetRequest}> {
    const previous=this.requests.get(key); if(previous) return {created:false,request:previous};
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
const client=(fetcher:ReturnType<typeof fakeFetch>,ledger=new MemoryLedger())=>new OpenRouterClient({apiKey:'synthetic-private-key',liveEnabled:true,allowExternalData:true,databaseUrl,ledger,fetch:fetcher as typeof fetch});
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
