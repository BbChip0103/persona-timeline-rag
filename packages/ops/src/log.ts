/**
 * Pino owns JSON-line serialization/delivery. This adapter projects scalar codes/ids only;
 * string shape checks are not a proof against arbitrary ASCII secrets. Sensitive keys are excluded.
 */
import pino from 'pino';
export type LogValue=string|number|boolean|null|undefined;
export type LogFields=Record<string,LogValue>;
export type Log=(event:string,fields?:LogFields)=>void;

const EVENT=/^[a-z][a-z0-9_]{0,63}$/, KEY=/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
/** Ids (uuid, registry ids, `lt-…`), error codes, enums and compact maps such as `{a:1,b:2}`; no spaces. */
const SAFE=/^[A-Za-z0-9_.:,/{}=+@-]{0,200}$/;
const SENSITIVE=['body','prompt','caption','text','authorization','token','apiKey','password','err','error','stack'];
const DENIED=new Set(SENSITIVE.map(key=>key.toLowerCase()));

export function createLog(role:string,write:(line:string)=>void=line=>{process.stderr.write(line);}):Log {
  // A nonempty native level formatter is required for valid JSON; use the existing constant role.
  const logger=pino({base:null,timestamp:false,formatters:{level:()=>({role})},redact:{paths:SENSITIVE,remove:true}},
    {write(line:string){write(line);}});
  return (event,fields={})=>{
    const entry:Record<string,LogValue>={ts:new Date().toISOString(),event:EVENT.test(event)?event:'invalid_event'};
    for(const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(fields))) {
      if(!descriptor.enumerable||!KEY.test(key)||key==='role'||key in entry||DENIED.has(key.replace(/[_-]/g,'').toLowerCase())||!('value' in descriptor)) continue;
      const value:unknown=descriptor.value;
      if(value===undefined||value!==null&&!['string','number','boolean'].includes(typeof value))continue;
      entry[key]=typeof value==='string'?SAFE.test(value)?value:'INVALID'
        :typeof value==='number'?Number.isFinite(value)?Math.round(value):null:value as boolean|null;
    }
    logger.info(entry);
  };
}
