import { fetchEventSource } from '@microsoft/fetch-event-source';
import { WebApiError } from './api';
export type TurnFrame={event:string;data:unknown};
type Options={turnId:string;signal:AbortSignal;fetch?:typeof fetch;onFrame:(frame:TurnFrame)=>boolean;readStatus:(signal:AbortSignal)=>Promise<TurnFrame|undefined>;onUnauthorized:()=>void;onDelay:(milliseconds:number)=>void};
class StreamEnded extends Error {}
class StreamStopped extends Error {}
/** Native SDK owns SSE decoding and GET retry scheduling; callbacks retain status/terminal policy. */
export async function subscribeTurnStream(options:Options):Promise<void> {
  if(options.signal.aborted)return;
  const controller=new AbortController();let stopped=false;let failures=0;
  const stop=()=>{stopped=true;controller.abort();};
  options.signal.addEventListener('abort',stop,{once:true});
  const receive=(frame:TurnFrame)=>{if(stopped||options.signal.aborted)return;if(options.onFrame(frame))stop();};
  try {
    await fetchEventSource(`/api/proxy/turns/${options.turnId}/events`,{
      method:'GET',cache:'no-store',signal:controller.signal,openWhenHidden:true,fetch:options.fetch,
      async onopen(response) {
        if(stopped)throw new StreamStopped();
        if(response.status===403){options.onUnauthorized();stop();throw new StreamStopped();}
        if(!response.ok||!response.body||!response.headers.get('content-type')?.startsWith('text/event-stream')) {
          let frame:TurnFrame|undefined;
          try{frame=await options.readStatus(controller.signal);}
          catch(error){if(error instanceof WebApiError&&error.status===403){if(!stopped)options.onUnauthorized();stop();throw new StreamStopped();}throw error;}
          if(stopped)throw new StreamStopped();
          if(frame){receive(frame);if(stopped)throw new StreamStopped();}
          throw new Error('STREAM_UNAVAILABLE');
        }
        failures=0;
      },
      onmessage(message) {
        if(stopped||!['turn','state'].includes(message.event))return;
        let data:unknown;try{data=JSON.parse(message.data);}catch{return;}
        receive({event:message.event,data});
      },
      onclose() {if(!stopped)throw new StreamEnded();},
      onerror(error) {
        if(stopped||options.signal.aborted||error instanceof StreamStopped)throw new StreamStopped();
        if(error instanceof StreamEnded)return 300;
        failures++;const delay=Math.min(1000*failures,10000);options.onDelay(delay);return delay;
      },
    });
  }finally{stop();options.signal.removeEventListener('abort',stop);}
}
