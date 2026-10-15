import { z } from 'zod';
const id = z.string().trim().min(1).max(200);
export const ReviewStatusSchema = z.enum(['synthetic', 'silver', 'human_reviewed']);
/** Trimmed, nonempty, at most `max` Unicode code points ( `text(n)`). */
const text = (max:number) => z.string().trim().min(1).refine(value => [...value].length <= max, `At most ${max} code points`);
/** Lore keyword: 2–40 code points after trimming. */
const loreKey = z.string().trim().refine(value => { const length=[...value].length; return length >= 2 && length <= 40; }, 'Lore keys have 2-40 code points');
export const PersonalitySchema = z.object({
  summary: text(300).optional(), traits: z.array(text(40)).max(8), values: z.array(text(60)).max(6), speechHabits: z.array(text(80)).max(8),
}).strict();
export const ExampleDialogueSchema = z.object({
  turns: z.array(z.object({ speaker: z.enum(['user','character']), text: text(200) }).strict()).min(2).max(6),
}).strict();
export const LoreEntrySchema = z.object({
  id, keys: z.array(loreKey).min(1).max(8), content: text(300),
  priority: z.number().int().min(0).max(100).default(50), sourceRefs: z.array(id).min(1).max(10),
}).strict();
/**
 * Read on every load: structure only, and rules may only widen (stored revisions must keep parsing). Content, budget
 * and source checks run at publish time only (`validatePersonaForPublish`). Every field after
 * `greeting` is optional, so v1 documents parse unchanged; `meta` is never rendered into a prompt.
 */
export const PersonaSchema = z.object({
  id, personId:id, label: z.string().min(1), language: z.string().min(1), revision: id,
  reviewStatus: ReviewStatusSchema, identity: z.string(), concept: z.string(),
  style: z.array(z.string()), boundaries: z.array(z.string()), sourceRefs: z.array(id), greeting: z.string().min(1),
  /** Public catalogue card copy; never inserted into the model persona block. */
  tagline: text(60).optional(), starters: z.array(text(60)).max(4).optional(),
  alternateGreetings: z.array(text(300)).max(4).optional(),
  personality: PersonalitySchema.optional(),
  background: z.object({ text: text(500), sourceRefs: z.array(id).min(1).max(20) }).strict().optional(),
  exampleDialogues: z.array(ExampleDialogueSchema).max(3).optional(),
  lore: z.array(LoreEntrySchema).max(50).optional(),
  meta: z.object({ tags: z.array(text(30)).max(12).optional(), creatorNotes: text(2000).optional() }).strict().optional(),
}).strict();
export type LoreEntry = z.infer<typeof LoreEntrySchema>;
export type Persona = z.infer<typeof PersonaSchema>;
export const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0,10) === value;
}, 'Invalid calendar date');
export const TimezoneSchema = z.string().refine(value => {
  // Intl also accepts numeric offsets; the Python retrieval path uses ZoneInfo names.
  if(!/^(?:UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/u.test(value)) return false;
  try { new Intl.DateTimeFormat('en', {timeZone:value}); return true; } catch { return false; }
}, 'Invalid IANA timezone');
export const ImageAnnotationEvidenceSchema = z.object({
  id, imageHash:id, annotationHash:id, revision:id, text:z.string().min(1).max(16000), model:id, humanReviewed:z.literal(false),
}).strict();
export type ImageAnnotationEvidence = z.infer<typeof ImageAnnotationEvidenceSchema>;
export const RagConditionSchema = z.enum(['off','caption','caption_image']);
export type RagCondition = z.infer<typeof RagConditionSchema>;
export const SourcePostSchema = z.object({
  id, personId: id, caption: z.string(), postedAt: z.string().datetime({ offset:true }),
  eventDate: CalendarDateSchema.nullable(), sourceUrl: z.string().url().refine(value => ['https:', 'http:'].includes(new URL(value).protocol)),
  hash: id, snapshot: id, unsafe: z.boolean(), imageAnnotations:z.array(ImageAnnotationEvidenceSchema).max(100).optional(),
}).strict();
export type SourcePost = z.infer<typeof SourcePostSchema>;
export const RetrievalModeSchema = z.enum(['off','lexical','semantic']);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;
export const TimelineQuerySchema = z.object({
  personId: id, query: z.string().trim().min(1).refine(value => [...value].length <= 500).optional(),
  start: CalendarDateSchema.optional(), end: CalendarDateSchema.optional(),
  dateBasis: z.enum(['posted','event']), timezone: TimezoneSchema, limit: z.number().int().min(1).max(100),
}).strict().superRefine((value, context) => {
  if ((value.start === undefined) !== (value.end === undefined) || (value.start && value.end && value.start >= value.end))
    context.addIssue({code:z.ZodIssueCode.custom, message:'Start and end must define a nonempty [start,end) range'});
});
export type TimelineQuery = z.infer<typeof TimelineQuerySchema>;
export const ReplyStatusSchema = z.enum(['answered','insufficient_evidence','needs_clarification','out_of_scope']);
export type ReplyStatus = z.infer<typeof ReplyStatusSchema>;
export const EvidenceRefSchema = z.object({sourceId:id,annotationId:id.optional(),quote:z.string().min(1),start:z.number().int().nonnegative(),end:z.number().int().positive()}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;
export interface EvidenceCard { sourceId:string; personId:string; sourceUrl:string; postedAt:string; eventDate:string|null; snapshot:string; hash:string; quote:string; origin?:'source_caption'|'ai_image_annotation'; annotationId?:string; imageHash?:string; annotationHash?:string; annotationRevision?:string }
export interface FactualClaim { text:string; evidenceRefs:EvidenceRef[] }
export interface AgentExecution {
  revision:string; promptRevision:string; modelCalls:number; toolCalls:number;
  variables:{conversationTopic:string;tone:'neutral'|'warm'|'playful';speechLevel?:'casual'|'polite';lastYearRecallUsed?:boolean};
  decisionSummary?:string;
  steps:Array<{phase:'context'|'model'|'tool'|'validation';iteration:number;sourceIds?:string[];omittedSourceIds?:string[];query?:string}>;
  validator:'disabled'|'skipped_tool_followup'|'accepted'|'rejected'|'error';
}
export const ExecutionProfileSchema=z.enum(['legacy','agent_loop']);
export type ExecutionProfile=z.infer<typeof ExecutionProfileSchema>;
export interface ChatReply {
  sessionId:string; turnId:string; messageId:string; personId:string; personaRevision:string;
  responseKind:'small_talk'|'timeline'|'clarification'|'unsupported'; status:ReplyStatus;
  grounding?:'unverified_model'|'source_bound_quotes'; content:string; claims:FactualClaim[]; evidence:EvidenceCard[]; limitations:string[];
  /** Internal execution/state; must not be exposed by public API DTOs. */
  agent?:AgentExecution;
  promptEvidence?:{sourceIds:string[];annotationIds:string[];omittedAnnotations:number;promptBytes:number;omittedSourceIds?:string[]};
  sourceContext?:{revision:string;references:EvidenceCard[]};
  retrievalContext?:{revision:string;action:'none'|'search'|'reuse'|'clarify';contextTurnIds:string[];query?:string;reusedSourceIds:string[]};
  /** Internal: which path decided intent when an intent classifier is configured. Never carries user text. */
  intentRouting?:IntentRouting;
  /** Internal: input safety filter outcome when one is configured. Never carries user text. */
  inputSafety?:InputSafetyTrace;
  /** Internal : lore entries rendered this turn (ids only) and matched entries left out by the caps. */
  personaContext?:{loreIds:string[];loreOmitted:number};
  /** Internal (S8 follow-up): reply guard outcome on the agent and experiment paths; a replaced reply carries the reason. */
  replyGuard?:{revision:string;action:'none'|'replaced'|'edited';reason?:'human_impersonation'|'missing_ai_disclosure'|'private_life'|'background_denial'|'meta_talk'|'formatting'};
  /** Sanitized output guard failure for the operator harness; no exception message or reply text. */
  operatorMetadata?:{guardStage:'output_guard';exceptionClass:string;code:'GUARDRAILS_OUTPUT_UNAVAILABLE'};
  /** Operator-only reply origin and repeat-check outcome; fixed codes, never text. */
  operatorTrace?:{path:'model'|'fixed'|'ask_back'|'guard_replacement'|'guard_edit'|'fallback'|'regeneration'|'register_regeneration'|'identity_variant'|'voice_variant';code:string;repeatChecked:true;previousAvailable:boolean};
  /**
   * Internal : which upstream answered each model call of the turn, in call order (`primary`, `secondary`,
   * `fake`, `openrouter`, `direct`, else `unknown`); `calls` = upstreams.length. Absent when no model was called.
   */
  serving?:{calls:number;upstreams:string[];secondaryCalls:number};
}
export type InputSafetyCategory='prompt_injection'|'sexual'|'violence_gore'|'self_harm'|'hate_harassment'|'illegal_dangerous'|'private_info';
export interface InputSafetyTrace {
  /** rule: a deterministic refusal stood (only the self_harm question was asked, and it did not fire or failed). */
  decidedBy:'rule'|'classifier'|'classifier_fallback'; action:'none'|'refuse'|'support'|'deflect'; classifier?:string;
  /** Which rule refused: the sensitive pattern, or the client's explicit `unsupported` intent (not a safety finding). */
  rule?:'sensitive_pattern'|'client_unsupported';
  /** The category that chose the action; fired lists every asked category at or above its threshold. */
  category?:InputSafetyCategory; fired:InputSafetyCategory[]; probabilities?:Partial<Record<InputSafetyCategory,number>>;
  /** Number of text windows checked when the message was longer than one window. */
  windows?:number;
  /** Set when deflection changed a timeline turn (which would have retrieved) to small talk. */
  intentOverride?:'safety_deflect';
  fallbackReason?:'timeout'|'aborted'|'budget'|'subcap'|'unresolved'|'error';
}
export interface IntentRouting {
  decidedBy:'rule'|'classifier'|'classifier_fallback'; ruleIntent:'small_talk'|'timeline'|'clarification'|'unsupported'; classifier?:string;
  label?:'small_talk'|'timeline'; confidence?:number; fallbackReason?:'below_threshold'|'no_answer'|'timeout'|'aborted'|'budget'|'subcap'|'unresolved'|'error';
}
export interface ProviderMessage { role:'system'|'user'|'assistant'; content:string }
export type TurnState = 'pending'|'retrieving'|'generating'|'validating'|'completed'|'failed'|'cancelled';
export interface ChatSession {
  id:string; ownerId:string; personId:string; personaId:string; personaRevision:string;
  language:string; timezone:string; retrievalMode:RetrievalMode; ragCondition?:RagCondition; executionProfile?:ExecutionProfile; createdAt:string;
  /** Index into [greeting, ...alternateGreetings] ; absent means 0. */
  greetingIndex?:number;
  userMemoryConsent?:boolean;
}
export type UserMemoryKind='name'|'like'|'dislike'|'recent_event'|'other';
export interface UserMemory {id:string;ownerId:string;personaId:string;sessionOriginId:string;kind:UserMemoryKind;text:string;createdAt:string;forgotten:boolean}
export interface SessionSummary {text:string;lastMessageId:string}
export interface ChatMessage { id:string; sessionId:string; turnId:string|null; role:'user'|'assistant'; content:string; createdAt:string }
export interface ChatTurn {
  id:string; sessionId:string; ownerId:string; clientRequestId:string; userText:string; sequence:number;
  state:TurnState; createdAt:string; finishedAt?:string; reply?:ChatReply; errorCode?:string;
}
export const SessionRetrievalSchema = z.object({retrievalMode:RetrievalModeSchema.optional(),ragCondition:RagConditionSchema.optional()}).superRefine((value,context)=>{
  if(value.ragCondition==='off' && value.retrievalMode && value.retrievalMode!=='off' || value.ragCondition && value.ragCondition!=='off' && value.retrievalMode==='off')
    context.addIssue({code:z.ZodIssueCode.custom,message:'RAG condition and retrieval algorithm conflict'});
}).transform(value=>({...value,retrievalMode:value.retrievalMode ?? (value.ragCondition && value.ragCondition!=='off' ? 'semantic' as const : 'off' as const)}));
export const CreateSessionSchema = z.object({personId:id,personaId:id,personaRevision:id,timezone:TimezoneSchema.default('UTC'),executionProfile:ExecutionProfileSchema.optional(),retrievalMode:RetrievalModeSchema.optional(),ragCondition:RagConditionSchema.optional(),greetingIndex:z.number().int().min(0).max(4).optional()}).strict().transform((value,context)=>{
  const result=SessionRetrievalSchema.safeParse({retrievalMode:value.retrievalMode,ragCondition:value.ragCondition});
  if(!result.success){context.addIssue({code:z.ZodIssueCode.custom,message:'RAG condition and retrieval algorithm conflict'});return z.NEVER;}
  return {...value,...result.data};
});
export type CreateSessionInput = z.input<typeof CreateSessionSchema>;
/** Creative artifacts are not chat turns. A stable client id is required by billable runtimes. */
export const DraftRequestSchema = z.object({brief:z.string().trim().min(1).max(2000),
  clientRequestId:z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_-]+$/).optional()}).strict();
export type DraftRequest = z.infer<typeof DraftRequestSchema>;
export const SendTurnSchema = z.object({sessionId:id,clientRequestId:id,text:z.string().trim().min(1).max(8000),
  intent:z.enum(['small_talk','timeline','clarification','unsupported']).optional(),
  timeline:z.object({query:z.string().trim().min(1).max(500).optional(),start:CalendarDateSchema.optional(),end:CalendarDateSchema.optional(),dateBasis:z.enum(['posted','event']),limit:z.number().int().min(1).max(100).default(5)}).strict().optional(),
}).strict();
export type SendTurnInput = z.input<typeof SendTurnSchema>;
