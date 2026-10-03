import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ImageAnnotationEvidenceSchema, type ImageAnnotationEvidence } from '@ptr/contracts';

const identifier = z.string().trim().min(1).max(200);
export const ImageAnnotationInputSchema = z.object({
  id: identifier, sourceId: identifier, personId: identifier, sourceHash: identifier,
  imagePosition: z.number().int().nonnegative(), imageHash: z.string().regex(/^[a-f0-9]{64}$/),
  annotationHash: z.string().regex(/^[a-f0-9]{64}$/), revision: identifier,
  text: z.string().min(1).max(16000), model: identifier, humanReviewed: z.literal(false),
}).strict();
export type ImageAnnotationInput = z.infer<typeof ImageAnnotationInputSchema>;
/** Hash only the indexed annotation, never reinterpret the immutable source caption. */
export function imageAnnotationHash(input: Omit<ImageAnnotationInput, 'annotationHash'>): string {
  return createHash('sha256').update(JSON.stringify({
    id: input.id, sourceId: input.sourceId, personId: input.personId, sourceHash: input.sourceHash,
    imagePosition: input.imagePosition, imageHash: input.imageHash, revision: input.revision,
    text: input.text, model: input.model, humanReviewed: input.humanReviewed,
  })).digest('hex');
}
export function imageAnnotationEvidence(input: ImageAnnotationInput): ImageAnnotationEvidence {
  return ImageAnnotationEvidenceSchema.parse({ id: input.id, imageHash: input.imageHash, annotationHash: input.annotationHash,
    revision: input.revision, text: input.text, model: input.model, humanReviewed: false });
}
export type EvidenceScope = 'caption' | 'caption_image';
