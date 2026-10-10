/** Retain a draft's billing identity after transport failure; new input/session means a new attempt. */
export interface DraftAttempt {sessionId:string;brief:string;clientRequestId:string}
export function draftAttemptFor(previous:DraftAttempt|undefined,sessionId:string,brief:string,newId:()=>string):DraftAttempt {
  return previous?.sessionId===sessionId&&previous.brief===brief?previous:{sessionId,brief,clientRequestId:newId()};
}
