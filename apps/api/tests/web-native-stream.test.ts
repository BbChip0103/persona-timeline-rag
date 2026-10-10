import { subscribeTurnStream } from '../../web/lib/turn-stream';
import { WebApiError } from '../../web/lib/api';
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
function browser() {
 const document={addEventListener:jest.fn(),removeEventListener:jest.fn()};
 Object.defineProperty(globalThis,'document',{value:document,configurable:true});Object.defineProperty(globalThis,'window',{value:{setTimeout,clearTimeout},configurable:true});return document;
}
function response(signal:AbortSignal,chunks:Array<string|Uint8Array>,stayOpen=false) {
 const encoder=new TextEncoder();return new Response(new ReadableStream<Uint8Array>({start(controller){signal.addEventListener('abort',()=>{try{controller.error(new DOMException('Aborted','AbortError'));}catch{/* Already closed. */}});for(const text of chunks)controller.enqueue(typeof text==='string'?encoder.encode(text):text);if(!stayOpen)controller.close();}}),{headers:{'content-type':'text/event-stream'}});
}
beforeEach(()=>{jest.useFakeTimers();browser();});
afterEach(()=>{jest.useRealTimers();Reflect.deleteProperty(globalThis,'document');Reflect.deleteProperty(globalThis,'window');});
test('real SDK parses split UTF8/CRLF/multiline, ignores comments/bad JSON, terminal aborts once and requests only GET',async()=>{
 const frames:unknown[]=[];const fetcher=jest.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>response(init!.signal as AbortSignal,[': ping\r\n\r\nevent: state\r\ndata: {"state":\r\ndata: "generating"}\r\n\r\nevent: turn\r\ndata: invalid\r\n\r\nevent: tu','rn\r\ndata: {"state":"completed","text":"합성"}\r\n\r\nevent: turn\r\ndata: {"state":"completed"}\r\n\r\n'],true));
 await subscribeTurnStream({turnId:'synthetic_turn',signal:new AbortController().signal,fetch:fetcher,onFrame:frame=>{frames.push(frame);return frame.event==='turn';},readStatus:async()=>undefined,onUnauthorized:jest.fn(),onDelay:jest.fn()});
 expect(frames).toEqual([{event:'state',data:{state:'generating'}},{event:'turn',data:{state:'completed',text:'합성'}}]);expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![1]).toMatchObject({method:'GET',cache:'no-store'});expect((globalThis.document.addEventListener as jest.Mock)).not.toHaveBeenCalled();
});
test('nonterminal EOF uses SDK scheduled 300ms reconnect; aborted retry never reconnects or submits',async()=>{
 const controller=new AbortController();const fetcher=jest.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>response(init!.signal as AbortSignal,[]));
 const run=subscribeTurnStream({turnId:'synthetic_turn',signal:controller.signal,fetch:fetcher,onFrame:()=>false,readStatus:async()=>undefined,onUnauthorized:jest.fn(),onDelay:jest.fn()});await tick();expect(fetcher).toHaveBeenCalledTimes(1);
 await jest.advanceTimersByTimeAsync(299);expect(fetcher).toHaveBeenCalledTimes(1);await jest.advanceTimersByTimeAsync(1);expect(fetcher).toHaveBeenCalledTimes(2);controller.abort();await run;await jest.advanceTimersByTimeAsync(10000);expect(fetcher).toHaveBeenCalledTimes(2);
});
test('bad response performs one status read and settles terminal without retry; 403 redirects without reading status',async()=>{
 const status=jest.fn(async()=>({event:'turn',data:{state:'failed'}}));const onFrame=jest.fn(()=>true);const unauthorized=jest.fn();
 await subscribeTurnStream({turnId:'synthetic',signal:new AbortController().signal,fetch:jest.fn(async()=>new Response('{}',{status:503})),onFrame,readStatus:status,onUnauthorized:unauthorized,onDelay:jest.fn()});expect(status).toHaveBeenCalledTimes(1);expect(onFrame).toHaveBeenCalledTimes(1);
 await subscribeTurnStream({turnId:'synthetic',signal:new AbortController().signal,fetch:jest.fn(async()=>new Response('{}',{status:403})),onFrame,readStatus:status,onUnauthorized:unauthorized,onDelay:jest.fn()});expect(status).toHaveBeenCalledTimes(1);expect(unauthorized).toHaveBeenCalledTimes(1);
});
test('network failures use SDK 1..10-second backoff and pre-aborted invocation makes zero requests',async()=>{
 const controller=new AbortController();const fetcher=jest.fn().mockRejectedValue(new Error('socket'));const delay=jest.fn();
 const options={turnId:'synthetic',signal:controller.signal,fetch:fetcher,onFrame:()=>false,readStatus:async()=>undefined,onUnauthorized:jest.fn(),onDelay:delay};
 const run=subscribeTurnStream(options);await tick();expect(delay).toHaveBeenLastCalledWith(1000);
 await jest.advanceTimersByTimeAsync(1000);expect(delay).toHaveBeenLastCalledWith(2000);controller.abort();await run;const count=fetcher.mock.calls.length;await subscribeTurnStream(options);expect(fetcher).toHaveBeenCalledTimes(count);
});
test('abort while asynchronous status lookup is pending prevents late terminal callbacks',async()=>{
 const controller=new AbortController();let resolve!:(value:{event:string;data:unknown})=>void;const status=jest.fn(()=>new Promise<{event:string;data:unknown}>(done=>{resolve=done;}));const onFrame=jest.fn(()=>true);
 const run=subscribeTurnStream({turnId:'synthetic',signal:controller.signal,fetch:jest.fn(async()=>new Response('{}',{status:502})),onFrame,readStatus:status,onUnauthorized:jest.fn(),onDelay:jest.fn()});await tick();controller.abort();resolve({event:'turn',data:{state:'completed'}});await run;await tick();expect(onFrame).not.toHaveBeenCalled();
});

test('non-SSE open then forbidden status fallback is fatal: no delayed GET reconnection',async()=>{const fetcher=jest.fn(async()=>new Response('{}',{status:503}));const unauthorized=jest.fn();const readStatus=jest.fn().mockRejectedValue(new WebApiError('UNAUTHORIZED',403));await subscribeTurnStream({turnId:'synthetic',signal:new AbortController().signal,fetch:fetcher,readStatus,onFrame:()=>false,onUnauthorized:unauthorized,onDelay:jest.fn()});await jest.advanceTimersByTimeAsync(30000);expect(fetcher).toHaveBeenCalledTimes(1);expect(readStatus).toHaveBeenCalledTimes(1);expect(unauthorized).toHaveBeenCalledTimes(1);});

test('SDK decoder handles a UTF8 codepoint split across every byte, without a custom text/frame codec',async()=>{
 const bytes=new TextEncoder().encode('event: turn\r\ndata: {"state":"completed","text":"합성 😀"}\r\n\r\n');const frames:unknown[]=[];
 await subscribeTurnStream({turnId:'synthetic',signal:new AbortController().signal,fetch:jest.fn(async(_input:RequestInfo|URL,init?:RequestInit)=>response(init!.signal as AbortSignal,Array.from(bytes,byte=>new Uint8Array([byte])),true)),onFrame:frame=>{frames.push(frame);return true;},readStatus:async()=>undefined,onUnauthorized:jest.fn(),onDelay:jest.fn()});expect(frames).toEqual([{event:'turn',data:{state:'completed',text:'합성 😀'}}]);
});
test('abort during pending SDK open suppresses all late callbacks and cleans its external signal listener',async()=>{
 const controller=new AbortController();const remove=jest.spyOn(controller.signal,'removeEventListener');let resolve!:(response:Response)=>void;const fetcher=jest.fn(()=>new Promise<Response>(done=>{resolve=done;}));const onFrame=jest.fn(()=>true);
 const run=subscribeTurnStream({turnId:'synthetic',signal:controller.signal,fetch:fetcher,onFrame,readStatus:async()=>undefined,onUnauthorized:jest.fn(),onDelay:jest.fn()});controller.abort();await run;resolve(new Response('event: turn\ndata: {"state":"completed"}\n\n',{headers:{'content-type':'text/event-stream'}}));await tick();expect(onFrame).not.toHaveBeenCalled();expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));expect(jest.getTimerCount()).toBe(0);
});
