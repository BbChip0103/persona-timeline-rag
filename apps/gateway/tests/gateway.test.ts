import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProviderMessage } from '@ptr/contracts';
import type { TextProvider } from '@ptr/core';
import { OpenAICompatibleTextProvider } from '@ptr/providers';
import { createGateway, OpenAICompatibleUpstream, TextProviderUpstream, type GatewayOptions } from '../src';
import { upstreamFromEnvironment } from '../src/main';

const token='synthetic_gateway_token_abcdefghij';
const messages=[{role:'user',content:'안녕'}];
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>new Promise(resolve=>server.close(resolve))));});
async function listen(server:Server):Promise<string> {servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function gateway(upstream:GatewayOptions['upstream'],limits:Partial<GatewayOptions['limits']>={}) {
  const g=createGateway({token,upstream,limits:{maxConcurrent:2,maxQueue:2,queueTimeoutMs:2000,upstreamTimeoutMs:5000,...limits}});
  return {g,base:await listen(g.server)};
}
const post=(base:string,body:unknown,headers:Record<string,string>={},signal?:AbortSignal)=>fetch(`${base}/v1/chat/completions`,
  {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal});
/** Text provider whose calls can be held open and released one by one. */
function heldProvider() {
  let inFlight=0,peak=0,calls=0;const waiting:(()=>void)[]=[];const signals:AbortSignal[]=[];
  const provider:TextProvider={generate:async(_m,{signal})=>{calls++;inFlight++;peak=Math.max(peak,inFlight);signals.push(signal);
    try {await new Promise<void>((resolve,reject)=>{waiting.push(resolve);signal.addEventListener('abort',()=>{waiting.splice(waiting.indexOf(resolve),1);reject(new Error('aborted'));},{once:true});});return 'held reply';}
    finally {inFlight--;}}};
  return {provider,releaseOne:()=>waiting.shift()?.(),held:()=>waiting.length,stats:()=>({inFlight,peak,calls}),signals};
}
const until=async(check:()=>boolean,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};

describe('LLM gateway',()=>{
  test('health is open; completions and metrics need the token',async()=>{
    const {base}=await gateway(new TextProviderUpstream({generate:async()=> 'ok'},'fake'));
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await post(base,{messages},{Authorization:'Bearer wrong'})).status).toBe(403);
    expect((await fetch(`${base}/metrics`)).status).toBe(403);
    expect((await fetch(`${base}/metrics`,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(200);
  });
  test('a text-provider upstream answers in OpenAI shape, streamed or not, and the existing client reads it',async()=>{
    const seen:ProviderMessage[][]=[];
    const {base}=await gateway(new TextProviderUpstream({generate:async m=>{seen.push(m);return '반가워요.';}},'fake-model'));
    const plain=await (await post(base,{model:'ignored',messages,stream:false})).json() as {model:string;choices:{message:{content:string}}[]};
    expect(plain.choices[0]!.message.content).toBe('반가워요.');expect(plain.model).toBe('fake-model');
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    expect(await client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal})).toBe('반가워요.');
    expect(seen).toHaveLength(2);
  });
  test('in-flight upstream calls never exceed the concurrency cap; queued requests run as slots free up',async()=>{
    const held=heldProvider();const {base,g}=await gateway(new TextProviderUpstream(held.provider,'fake'),{maxConcurrent:2,maxQueue:5});
    const requests=Array.from({length:5},()=>post(base,{messages,stream:false}));
    await until(()=>held.stats().calls===2);
    expect(g.metrics().queued).toBe(3);
    for(let i=0;i<5;i++){await until(()=>held.held()>0);held.releaseOne();}
    const responses=await Promise.all(requests);
    expect(responses.map(r=>r.status)).toEqual([200,200,200,200,200]);
    expect(held.stats().peak).toBe(2);expect(held.stats().calls).toBe(5);
  });
  test('a full queue is rejected at once with 429, Retry-After and the gateway-rejected marker, without calling upstream',async()=>{
    const held=heldProvider();const {base,g}=await gateway(new TextProviderUpstream(held.provider,'fake'),{maxConcurrent:1,maxQueue:1});
    const first=post(base,{messages,stream:false}),second=post(base,{messages,stream:false});
    await until(()=>held.stats().calls===1&&g.metrics().queued===1);
    const third=await post(base,{messages,stream:false});
    expect(third.status).toBe(429);expect(third.headers.get('retry-after')).toBe('1');expect(third.headers.get('x-ptr-gateway')).toBe('rejected');
    expect(await third.json()).toEqual({error:{code:'GATEWAY_QUEUE_FULL'}});
    expect(held.stats().calls).toBe(1);
    held.releaseOne();await until(()=>held.stats().calls===2);held.releaseOne();
    expect((await first).status).toBe(200);expect((await second).status).toBe(200);
    expect(g.metrics().rejected).toEqual({queueFull:1,queueTimeout:0});
  });
  test('waiting longer than the queue timeout is rejected with 503 and the marker',async()=>{
    const held=heldProvider();const {base}=await gateway(new TextProviderUpstream(held.provider,'fake'),{maxConcurrent:1,maxQueue:1,queueTimeoutMs:50});
    const first=post(base,{messages,stream:false});await until(()=>held.stats().calls===1);
    const late=await post(base,{messages,stream:false});
    expect(late.status).toBe(503);expect(late.headers.get('x-ptr-gateway')).toBe('rejected');
    held.releaseOne();await first;
  });
  test('a client that disconnects leaves the queue, and one that disconnects mid-call aborts the upstream call and frees its slot',async()=>{
    const held=heldProvider();const {base,g}=await gateway(new TextProviderUpstream(held.provider,'fake'),{maxConcurrent:1,maxQueue:2});
    const running=new AbortController(),queued=new AbortController();
    const a=post(base,{messages,stream:false},{},running.signal).catch(()=>undefined);
    await until(()=>held.stats().calls===1);
    const b=post(base,{messages,stream:false},{},queued.signal).catch(()=>undefined);
    await until(()=>g.metrics().queued===1);
    queued.abort();await until(()=>g.metrics().queued===0);
    running.abort();await until(()=>held.signals[0]!.aborted&&g.metrics().inFlight===0);
    await Promise.all([a,b]);
    const c=post(base,{messages,stream:false});await until(()=>held.stats().calls===2);held.releaseOne();
    expect((await c).status).toBe(200);
  });
  test('an OpenAI-compatible upstream (vLLM) is streamed through with the gateway-configured model; upstream errors are not marked as gateway rejections',async()=>{
    const bodies:{model:string;stream:boolean}[]=[];let fail=false;
    const engine=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
      bodies.push(JSON.parse(raw));
      if(fail){res.writeHead(429,{'Content-Type':'application/json'});res.end('{"error":"busy"}');return;}
      res.writeHead(200,{'Content-Type':'text/event-stream'});
      res.write(`data: ${JSON.stringify({choices:[{delta:{content:'엔진'}}]})}\n\n`);res.write(`data: ${JSON.stringify({choices:[{delta:{content:' 응답'}}],usage:{prompt_tokens:3,completion_tokens:2}})}\n\n`);res.end('data: [DONE]\n\n');
    });});
    const engineBase=await listen(engine);
    const {base}=await gateway(new OpenAICompatibleUpstream({baseUrl:`${engineBase}/v1`,model:'gemma-4-e4b-fp8'}));
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    expect(await client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal})).toBe('엔진 응답');
    expect(bodies[0]).toMatchObject({model:'gemma-4-e4b-fp8',stream:true});
    fail=true;
    const failed=await post(base,{messages,stream:true});
    expect(failed.status).toBe(502);expect(failed.headers.get('x-ptr-gateway')).toBeNull();
  });
});

describe('OpenAI-compatible client against the gateway',()=>{
  test('gateway rejections are retried after Retry-After (nothing reached upstream); other errors are not',async()=>{
    let calls=0;
    const fake=createServer((req,res)=>{req.resume();req.on('end',()=>{calls++;
      if(calls<=2){res.writeHead(429,{'Retry-After':'0','X-PTR-Gateway':'rejected','Content-Type':'application/json'});res.end('{"error":{"code":"GATEWAY_QUEUE_FULL"}}');return;}
      if(calls===3){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'세 번째'}}]})}\n\ndata: [DONE]\n\n`);return;}
      res.writeHead(429,{'Content-Type':'application/json'});res.end('{}');
    });});
    const base=await listen(fake);
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    expect(await client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal})).toBe('세 번째');
    expect(calls).toBe(3);
    await expect(client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal})).rejects.toMatchObject({code:'PROVIDER_HTTP_429'});
    expect(calls).toBe(4);
  });
});

describe('gateway upstream configuration',()=>{
  test('fake by default (latency only for fake); self-hosted must be loopback; unknown kinds fail',()=>{
    expect(upstreamFromEnvironment({}).upstream).toBeInstanceOf(TextProviderUpstream);
    expect(upstreamFromEnvironment({PTR_FAKE_LATENCY:'{"medianMs":1900,"p95Ms":3600,"seed":7}'}).upstream.model).toBe('synthetic/fake-text-v1+latency');
    expect(upstreamFromEnvironment({PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_BASE_URL:'http://127.0.0.1:18000/v1',PTR_SELFHOSTED_MODEL:'m'}).upstream).toBeInstanceOf(OpenAICompatibleUpstream);
    expect(()=>upstreamFromEnvironment({PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_BASE_URL:'https://example.com/v1',PTR_SELFHOSTED_MODEL:'m'})).toThrow();
    expect(()=>upstreamFromEnvironment({PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_FAKE_LATENCY:'{"medianMs":1,"p95Ms":2}'})).toThrow();
    expect(()=>upstreamFromEnvironment({PTR_GATEWAY_UPSTREAM:'anthropic'})).toThrow();
  });
});
describe('OpenAI-compatible client when the gateway restarts',()=>{
  test('connection refused (nothing was sent) is retried until the gateway is back; the caller signal still ends it',async()=>{
    const probe=createServer();const base=await listen(probe);const port=Number(new URL(base).port);
    await new Promise(r=>probe.close(r));servers.splice(servers.indexOf(probe),1); // port now refuses connections
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    const pending=client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal});
    await new Promise(r=>setTimeout(r,300));
    const back=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{content:'돌아왔어'}}]})}\n\ndata: [DONE]\n\n`);});});
    servers.push(back);await new Promise<void>(r=>back.listen(port,'127.0.0.1',r));
    expect(await pending).toBe('돌아왔어');
    const gone=createServer();const goneBase=await listen(gone);await new Promise(r=>gone.close(r));servers.splice(servers.indexOf(gone),1);
    const controller=new AbortController();setTimeout(()=>controller.abort(),200);
    await expect(new OpenAICompatibleTextProvider({baseUrl:`${goneBase}/v1`,model:'gateway',apiKey:token}).generate([{role:'user',content:'x'}],{signal:controller.signal})).rejects.toMatchObject({code:'CANCELLED'});
  });
});

