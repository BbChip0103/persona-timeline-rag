import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { GuardrailsClient, GuardrailsUnavailableError } from '../src/guardrails';
import { DEFAULT_SAFETY_THRESHOLDS } from '../src/input-safety';

const token='synthetic-test-token-only';
const reply={utterance:'Are you human?',reply:'I am a real person.',realPerson:true,language:'en'};
const pass={revision:'reply-guard-v7',content:'Synthetic output.'};
const signal=()=>new AbortController().signal;
const client=(fetch:typeof globalThis.fetch,timeoutMs=100)=>new GuardrailsClient({baseUrl:'http://guardrails.internal',apiKey:token,timeoutMs,fetch});

function fakeResponse(body:unknown,status=200):typeof globalThis.fetch {
  return jest.fn(async()=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}}));
}

describe('Guardrails internal adapter',()=>{
  test('output DTO only sends the narrow domain policy context and authentication',async()=>{
    const fetch=fakeResponse(pass);
    const input={...reply,ragContext:'PRIVATE_CONTEXT_SENTINEL',apiKey:'PRIVATE_CREDENTIAL_SENTINEL'};
    expect(await client(fetch).validateReply(input,{signal:signal()})).toEqual(pass);
    const [url,request]=(fetch as jest.Mock).mock.calls[0] as [string,RequestInit];
    expect(url).toBe('http://guardrails.internal/validate/output');
    expect(request.headers).toEqual({'content-type':'application/json',authorization:`Bearer ${token}`});
    expect(JSON.parse(request.body as string)).toEqual({text:reply.reply,metadata:{utterance:reply.utterance,realPerson:true,language:'en',level:'polite'}});
    expect(request.body).not.toMatch(/PRIVATE_/u);
  });
  test('Jev metadata forwards seven-category thresholds and only requested probabilities; no second classifier call',async()=>{
    const result={revision:'reply-guard-v7',action:'support',category:'self_harm',fired:['self_harm']};
    const fetch=fakeResponse(result);
    expect(await client(fetch).validateInput({text:'synthetic',probabilities:{self_harm:0.8,prompt_injection:0.7},thresholds:DEFAULT_SAFETY_THRESHOLDS,
      categories:['self_harm']},{signal:signal()})).toEqual(result);
    const [,request]=(fetch as jest.Mock).mock.calls[0] as [string,RequestInit];
    expect(JSON.parse(request.body as string).metadata).toEqual({probabilities:{self_harm:0.8},thresholds:DEFAULT_SAFETY_THRESHOLDS,categories:['self_harm']});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('explicit rules-only metadata keeps empty probabilities without inventing Jev scores',async()=>{
    const fetch=fakeResponse({revision:'reply-guard-v7',action:'none',fired:[]});
    await client(fetch).validateInput({text:'hello',classification:'rules-only',probabilities:{},thresholds:DEFAULT_SAFETY_THRESHOLDS,
      categories:['prompt_injection','sexual','violence_gore','self_harm','hate_harassment','illegal_dangerous','private_info']},{signal:signal()});
    const [,request]=(fetch as jest.Mock).mock.calls[0] as [string,RequestInit];
    expect(JSON.parse(request.body as string).metadata).toMatchObject({classification:'rules-only',probabilities:{}});
  });
  test('rules-only cannot smuggle or silently discard classifier probabilities',async()=>{
    const fetch=fakeResponse(pass);
    await expect(client(fetch).validateInput({text:'hello',classification:'rules-only',probabilities:{self_harm:0.8},thresholds:DEFAULT_SAFETY_THRESHOLDS,
      categories:['prompt_injection']},{signal:signal()})).rejects.toThrow('Invalid Guardrails rules-only metadata');
    expect(fetch).not.toHaveBeenCalled();
  });
  test('edited reply and fixed persona reason are preserved',async()=>{
    const result={...pass,reason:'meta_talk',edited:true};
    expect(await client(fakeResponse(result)).validateReply(reply,{signal:signal()})).toEqual(result);
  });
  test.each([401,422,500,503])('HTTP %i fails closed without echoing text or provider errors; never retries',async status=>{
    const fetch=fakeResponse({error:'PRIVATE_ERROR_SENTINEL'},status);
    await expect(client(fetch).validateReply(reply,{signal:signal()})).rejects.toMatchObject({code:'GUARDRAILS_UNAVAILABLE',reason:'http'});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test.each([{...pass,revision:'unknown'}, {...pass,reason:'unknown'}, {...pass,ragContext:'PRIVATE_SENTINEL'}, {revision:'reply-guard-v7',content:42}])(
    'malformed validator response fails closed: %j',async response=>{
      await expect(client(fakeResponse(response)).validateReply(reply,{signal:signal()})).rejects.toMatchObject({reason:'invalid_response'});
    });
  test('network failures have sanitized messages and never retry',async()=>{
    const fetch=jest.fn(async()=>{throw new Error('PRIVATE_TRANSPORT_SENTINEL');}) as typeof globalThis.fetch;
    try {await client(fetch).validateReply(reply,{signal:signal()});throw new Error('must fail');}
    catch(error) {expect(error).toBeInstanceOf(GuardrailsUnavailableError);expect(String(error)).not.toMatch(/PRIVATE/u);}
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test('timeout is bounded even when the transport ignores AbortSignal',async()=>{
    const fetch=jest.fn(()=>new Promise<Response>(()=>undefined)) as typeof globalThis.fetch;
    await expect(client(fetch,15).validateReply(reply,{signal:signal()})).rejects.toMatchObject({reason:'timeout'});
    const [,request]=(fetch as jest.Mock).mock.calls[0] as [string,RequestInit];
    expect(request.signal?.aborted).toBe(true);
  });
  test('timeout covers response-body stalls too',async()=>{
    const fetch=jest.fn(async()=>new Response(new ReadableStream({start:()=>undefined}))) as typeof globalThis.fetch;
    await expect(client(fetch,15).validateReply(reply,{signal:signal()})).rejects.toMatchObject({reason:'timeout'});
  });
  test('malformed large response cannot grow the parser indefinitely',async()=>{
    await expect(client(fakeResponse({...pass,content:'x'.repeat(512_000)})).validateReply(reply,{signal:signal()})).rejects.toMatchObject({reason:'invalid_response'});
  });
  test('pre-abort sends no request',async()=>{
    const controller=new AbortController();controller.abort();const fetch=fakeResponse(pass);
    await expect(client(fetch).validateReply(reply,{signal:controller.signal})).rejects.toMatchObject({reason:'aborted'});
    expect(fetch).not.toHaveBeenCalled();
  });
  test('in-flight caller abort is forwarded and bounded even for an ignoring transport',async()=>{
    const controller=new AbortController();
    const fetch=jest.fn(()=>new Promise<Response>(()=>undefined)) as typeof globalThis.fetch;
    const promise=client(fetch).validateReply(reply,{signal:controller.signal});controller.abort();
    await expect(promise).rejects.toMatchObject({reason:'aborted'});
  });
  test.each(['file:///tmp/test','http://user:secret@localhost','https://localhost?key=secret','http://localhost#secret'])(
    'unsafe URL fails configuration: %s',baseUrl=>expect(()=>new GuardrailsClient({baseUrl,apiKey:token,timeoutMs:100})).toThrow());
  test('invalid safety decision shape fails closed',async()=>{
    const fetch=fakeResponse({revision:'reply-guard-v7',action:'support',category:'sexual',fired:['sexual']});
    await expect(client(fetch).validateInput({text:'synthetic',probabilities:{sexual:0.8},thresholds:DEFAULT_SAFETY_THRESHOLDS,categories:['sexual']},{signal:signal()}))
      .rejects.toMatchObject({reason:'invalid_response'});
  });
});

describe('Guardrails real local HTTP transport (synthetic)',()=>{
  let server:Server;let baseUrl:string;let requestBody:unknown;
  beforeAll(async()=>{
    server=createServer((request,response)=>{
      let body='';request.on('data',chunk=>{body+=String(chunk);});
      request.on('end',()=>{requestBody=JSON.parse(body) as unknown;
        if(request.headers.authorization!==`Bearer ${token}`) {response.writeHead(401).end();return;}
        response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(pass));
      });
    });server.listen(0,'127.0.0.1');await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string') throw new Error('missing loopback port');
    baseUrl=`http://127.0.0.1:${address.port}`;
  });
  afterAll(async()=>{server.close();server.closeAllConnections();await once(server,'close');});
  test('real fetch receives the contract and closes the connection cleanly',async()=>{
    expect(await new GuardrailsClient({baseUrl,apiKey:token,timeoutMs:1000}).validateReply(reply,{signal:signal()})).toEqual(pass);
    expect(requestBody).toMatchObject({text:reply.reply,metadata:{utterance:reply.utterance}});
  });
});
