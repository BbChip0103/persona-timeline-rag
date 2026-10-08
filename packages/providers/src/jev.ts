import { createHash } from 'node:crypto';
import type { ClassifiedIntent, IntentClassification, IntentClassifier } from '@ptr/core';
import { ProviderError } from './budget';
import type { OpenRouterClient } from './openrouter';

/** Pinned release: thresholds are tuned against one version, never the moving `~typesafe/jev-latest` alias. */
export const DEFAULT_JEV_MODEL='typesafe/jev-1.13';
export const JEV_INTENT_QUESTION_REVISION='jev-intent-v1';
const INSTRUCTIONS='The user is chatting with a fictional character who has a record of past social media posts and photos. '
  +'Decide whether replying to latest_user_message needs the character\'s recorded past, or is ordinary conversation. '
  +'earlier_user_messages are only context for what latest_user_message refers to.';
const CRITERIA:Record<ClassifiedIntent,string>={
  timeline:'Asks about or refers back to something the character actually did, posted or showed: past posts, photos, trips, visits, places, dates, activities or life events, including follow-ups about them.',
  small_talk:'Greetings, feelings, opinions, preferences, general advice or knowledge, plans, hypotheticals or imaginative requests that do not depend on what the character actually did or posted.',
};
/** Jev has a first-option bias: the label order is rotated per turn, deterministically, so runs are reproducible. */
export function jevLabelOrder(seed:string):ClassifiedIntent[] {
  return createHash('sha256').update(seed).digest()[0]!&1?['small_talk','timeline']:['timeline','small_talk'];
}
const CONSISTENCY_TOLERANCE=0.03;
const unit=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
export class JevIntentClassifier implements IntentClassifier {
  constructor(private readonly client:Pick<OpenRouterClient,'decide'>,readonly name:string=DEFAULT_JEV_MODEL) {}
  async classify(input:{text:string;recentUserTurns:string[];seed:string},options:{signal:AbortSignal}):Promise<IntentClassification> {
    // Small state on purpose: irrelevant context lowers Jev accuracy, and nothing beyond user text leaves the service.
    const state=input.recentUserTurns.length?{earlier_user_messages:[...input.recentUserTurns],latest_user_message:input.text}:{latest_user_message:input.text};
    const criteria=Object.fromEntries(jevLabelOrder(input.seed).map(label=>[label,CRITERIA[label]]));
    // The turn id scopes ledger idempotency: a retried turn never resubmits, other turns are never blocked by it.
    const result=await this.client.decide({model:this.name,state,questions:{intent:{type:'choice',instructions:INSTRUCTIONS,criteria}}},{signal:options.signal,idempotencyKey:input.seed});
    const answers=result.answers;
    const answer=answers&&typeof answers==='object'?(answers as Record<string,unknown>).intent:undefined;
    if (!answer||typeof answer!=='object') throw new ProviderError('INVALID_PROVIDER_RESPONSE');
    const {type,choice,confidence,probabilities}=answer as Record<string,unknown>;
    const p=probabilities&&typeof probabilities==='object'?probabilities as Record<string,unknown>:{};
    if (type!=='choice'||(choice!=='timeline'&&choice!=='small_talk')||!unit(confidence)||!unit(p.timeline)||!unit(p.small_talk)) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
    // Internally inconsistent answers are errors (→ rules): the choice must be the most probable label, and a
    // two-label Choice confidence is 2p-1 (TypeSafe (p_max−1/n)/(1−1/n); observed answers are rounded to 0.01).
    const [chosen,other]=choice==='timeline'?[p.timeline,p.small_talk]:[p.small_talk,p.timeline];
    if (chosen<other||Math.abs(confidence-(2*chosen-1))>CONSISTENCY_TOLERANCE) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
    return {label:choice,confidence,probabilities:{timeline:p.timeline,small_talk:p.small_talk}};
  }
}
