export type TurnFrame={event:string;data:unknown};
/**
 * Reads a server-sent-events body frame by frame (comment/heartbeat lines are skipped). `onFrame` returning true
 * stops reading; the result says whether that happened (false: the server ended the stream first).
 */
export async function readTurnStream(body:ReadableStream<Uint8Array>,onFrame:(frame:TurnFrame)=>boolean):Promise<boolean> {
  const reader=body.getReader();const decoder=new TextDecoder();let buffer='';
  try {
    for(;;) {
      const {done,value}=await reader.read();if(done)return false;
      buffer+=decoder.decode(value,{stream:true});
      let end:number;
      while((end=buffer.indexOf('\n\n'))>=0) {
        const lines=buffer.slice(0,end).split('\n');buffer=buffer.slice(end+2);
        const event=lines.find(line=>line.startsWith('event: '))?.slice(7);const data=lines.find(line=>line.startsWith('data: '))?.slice(6);
        if(!event||data===undefined)continue;
        let parsed:unknown;try{parsed=JSON.parse(data);}catch{continue;}
        if(onFrame({event,data:parsed}))return true;
      }
    }
  } finally {void reader.cancel().catch(()=>undefined);}
}
