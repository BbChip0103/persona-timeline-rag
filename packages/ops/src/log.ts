/**
 * JSON line log : one object per line on stderr, no library, correlated by `turnId`. Values are
 * constants, ids and numbers only: a string field that does not look like an id or a code is written as INVALID, so
 * user or model text cannot reach the log even through a mistake at the call site.
 */
export type LogValue=string|number|boolean|null|undefined;
export type LogFields=Record<string,LogValue>;
export type Log=(event:string,fields?:LogFields)=>void;

const EVENT=/^[a-z][a-z0-9_]{0,63}$/, KEY=/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
/** Ids (uuid, registry ids, `lt-…`), error codes, enums and compact maps such as `{a:1,b:2}`; no spaces. */
const SAFE=/^[A-Za-z0-9_.:,/{}=+@-]{0,200}$/;

export function createLog(role:string,write:(line:string)=>void=line=>{process.stderr.write(line);}):Log {
  return (event,fields={})=>{
    const entry:Record<string,LogValue>={ts:new Date().toISOString(),role,event:EVENT.test(event)?event:'invalid_event'};
    for(const [key,value] of Object.entries(fields)) {
      if(!KEY.test(key)||key in entry||value===undefined) continue;
      entry[key]=typeof value==='string'?SAFE.test(value)?value:'INVALID'
        :typeof value==='number'?Number.isFinite(value)?Math.round(value):null:value;
    }
    write(`${JSON.stringify(entry)}\n`);
  };
}
