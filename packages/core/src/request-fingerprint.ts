import { createHash } from 'node:crypto';
import type { SendTurnInput, RagCondition } from '@ptr/contracts';
/** Direct storage callers retain a text-only default; core always supplies the structured fingerprint. */
export function turnTextFingerprint(text:string):string { return createHash('sha256').update(text).digest('hex'); }
export function requestFingerprint(input:Pick<SendTurnInput,'text'|'intent'|'timeline'>,ragCondition?:RagCondition):string {
  const timeline=input.timeline;
  const normalized={...(ragCondition?{ragCondition}:{}),text:input.text.trim(),intent:input.intent??null,timeline:timeline?{
    query:timeline.query?.trim()??null,start:timeline.start??null,end:timeline.end??null,
    dateBasis:timeline.dateBasis,limit:timeline.limit??5,
  }:null};
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
