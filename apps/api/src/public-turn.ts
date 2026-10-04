import type { ChatReply, ChatTurn } from '@ptr/contracts';
/** Explicit DTO allowlist: internal agent summaries, variables, tool arguments and sourceContext never leave HTTP. */
export function publicTurn(turn:ChatTurn) {
  const reply:Omit<ChatReply,'agent'|'sourceContext'>|undefined=turn.reply?{
    sessionId:turn.reply.sessionId,turnId:turn.reply.turnId,messageId:turn.reply.messageId,
    personId:turn.reply.personId,personaRevision:turn.reply.personaRevision,responseKind:turn.reply.responseKind,
    status:turn.reply.status,content:turn.reply.content,claims:turn.reply.claims,evidence:turn.reply.evidence,limitations:turn.reply.limitations,
    ...(turn.reply.grounding?{grounding:turn.reply.grounding}:{}),
    ...(turn.reply.promptEvidence?{promptEvidence:turn.reply.promptEvidence}:{}),
  }:undefined;
  return {id:turn.id,sessionId:turn.sessionId,clientRequestId:turn.clientRequestId,userText:turn.userText,sequence:turn.sequence,state:turn.state,createdAt:turn.createdAt,
    ...(turn.finishedAt?{finishedAt:turn.finishedAt}:{}),...(turn.errorCode?{errorCode:turn.errorCode}:{}),...(reply?{reply}:{})};
}
