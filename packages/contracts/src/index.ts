import { z } from 'zod';
const id = z.string().trim().min(1).max(200);
export const ReviewStatusSchema = z.enum(['synthetic', 'silver', 'human_reviewed']);
export const PersonaSchema = z.object({
  id, personId:id, label: z.string().min(1), language: z.string().min(1), revision: id,
  reviewStatus: ReviewStatusSchema, identity: z.string(), concept: z.string(),
  style: z.array(z.string()), boundaries: z.array(z.string()), sourceRefs: z.array(id), greeting: z.string().min(1),
}).strict();
export type Persona = z.infer<typeof PersonaSchema>;
export const CalendarDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0,10) === value;
}, 'Invalid calendar date');
export const TimezoneSchema = z.string().refine(value => {
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
export interface ChatReply {
  sessionId:string; turnId:string; messageId:string; personId:string; personaRevision:string;
  responseKind:'small_talk'|'timeline'|'clarification'|'unsupported'; status:ReplyStatus;
  grounding?:'unverified_model'|'source_bound_quotes'; content:string; claims:FactualClaim[]; evidence:EvidenceCard[]; limitations:string[];
}
export interface ProviderMessage { role:'system'|'user'|'assistant'; content:string }
export type TurnState = 'pending'|'retrieving'|'generating'|'validating'|'completed'|'failed'|'cancelled';
export interface ChatSession {
  id:string; ownerId:string; personId:string; personaId:string; personaRevision:string;
  language:string; timezone:string; retrievalMode:RetrievalMode; ragCondition?:RagCondition; createdAt:string;
}
export interface ChatMessage { id:string; sessionId:string; turnId:string|null; role:'user'|'assistant'; content:string; createdAt:string }
export interface ChatTurn {
  id:string; sessionId:string; ownerId:string; clientRequestId:string; userText:string; sequence:number;
  state:TurnState; createdAt:string; finishedAt?:string; reply?:ChatReply; errorCode?:string;
}
export const SessionRetrievalSchema = z.object({retrievalMode:RetrievalModeSchema.optional(),ragCondition:RagConditionSchema.optional()}).superRefine((value,context)=>{
  if(value.ragCondition==='off' && value.retrievalMode && value.retrievalMode!=='off' || value.ragCondition && value.ragCondition!=='off' && value.retrievalMode==='off')
    context.addIssue({code:z.ZodIssueCode.custom,message:'RAG condition and retrieval algorithm conflict'});
}).transform(value=>({...value,retrievalMode:value.retrievalMode ?? (value.ragCondition && value.ragCondition!=='off' ? 'semantic' as const : 'off' as const)}));
export const CreateSessionSchema = z.object({personId:id,personaId:id,personaRevision:id,timezone:TimezoneSchema.default('UTC'),retrievalMode:RetrievalModeSchema.optional(),ragCondition:RagConditionSchema.optional()}).strict().transform((value,context)=>{
  const result=SessionRetrievalSchema.safeParse({retrievalMode:value.retrievalMode,ragCondition:value.ragCondition});
  if(!result.success){context.addIssue({code:z.ZodIssueCode.custom,message:'RAG condition and retrieval algorithm conflict'});return z.NEVER;}
  return {...value,...result.data};
});
export type CreateSessionInput = z.input<typeof CreateSessionSchema>;
export const SendTurnSchema = z.object({sessionId:id,clientRequestId:id,text:z.string().trim().min(1).max(8000),
  intent:z.enum(['small_talk','timeline','clarification','unsupported']).optional(),
  timeline:z.object({query:z.string().trim().min(1).max(500).optional(),start:CalendarDateSchema.optional(),end:CalendarDateSchema.optional(),dateBasis:z.enum(['posted','event']),limit:z.number().int().min(1).max(100).default(5)}).strict().optional(),
}).strict();
export type SendTurnInput = z.input<typeof SendTurnSchema>;
