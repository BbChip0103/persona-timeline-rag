import type { ChatReply, ChatTurn } from '@ptr/contracts';

export type OwnerSpace='web'|'harness';
type TurnFields=Pick<ChatTurn,'id'|'sessionId'|'clientRequestId'|'userText'|'sequence'|'state'|'createdAt'|'finishedAt'|'errorCode'>;
type ReplyFields=Pick<ChatReply,'sessionId'|'turnId'|'messageId'|'personId'|'personaRevision'|'responseKind'|'status'|'content'>;
export type WebTurn=TurnFields&{reply?:ReplyFields};
export type HarnessTurn=TurnFields&{reply?:ReplyFields&Pick<ChatReply,'claims'|'evidence'|'limitations'|'grounding'|'promptEvidence'|'operatorMetadata'|'operatorTrace'>};

/** Explicit allowlist: only the harness token can receive research fields. Internal traces never leave HTTP. */
export function publicTurn(turn:ChatTurn,space:'web'):WebTurn;
export function publicTurn(turn:ChatTurn,space:'harness'):HarnessTurn;
export function publicTurn(turn:ChatTurn,space:OwnerSpace):WebTurn|HarnessTurn;
export function publicTurn(turn:ChatTurn,space:OwnerSpace):WebTurn|HarnessTurn {
  const reply=turn.reply?{
    sessionId:turn.reply.sessionId,turnId:turn.reply.turnId,messageId:turn.reply.messageId,
    personId:turn.reply.personId,personaRevision:turn.reply.personaRevision,responseKind:turn.reply.responseKind,
    status:turn.reply.status,content:turn.reply.content,
    ...(space==='harness'?{
      claims:turn.reply.claims,evidence:turn.reply.evidence,limitations:turn.reply.limitations,
      ...(turn.reply.grounding?{grounding:turn.reply.grounding}:{}),
      ...(turn.reply.promptEvidence?{promptEvidence:turn.reply.promptEvidence}:{}),
      ...(turn.reply.operatorMetadata?{operatorMetadata:turn.reply.operatorMetadata}:{}),
      ...(turn.reply.operatorTrace?{operatorTrace:turn.reply.operatorTrace}:{}),
    }:{}),
  }:undefined;
  return {id:turn.id,sessionId:turn.sessionId,clientRequestId:turn.clientRequestId,userText:turn.userText,sequence:turn.sequence,state:turn.state,createdAt:turn.createdAt,
    ...(turn.finishedAt?{finishedAt:turn.finishedAt}:{}),...(turn.errorCode?{errorCode:turn.errorCode}:{}),...(reply?{reply}:{})};
}
