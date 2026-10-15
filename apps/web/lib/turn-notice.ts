import { friendlyError } from './friendly-error';

/** Turn states and internal codes stay in operator logs; the chat gets only plain copy. */
export function turnNotice(turn:{state:string;errorCode?:string},language='ko'):string {
  if(turn.state==='cancelled')return /^ko(?:$|[-_])/i.test(language)?'답장을 멈췄어.':'The reply was stopped.';
  return turn.state==='failed'?friendlyError(turn.errorCode,language):'';
}
