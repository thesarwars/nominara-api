import { z } from "zod";

// NEW-A-3 (STORY-028, Gemini slice) — the vendor's generateContent response, as recorded
// (fixtures/gemini-recorded.ts). Vendor objects are `looseObject`: the vendor adds fields without
// notice and an unknown key must not fail a capture. What we READ is strict about type, so a
// payload that is the wrong shape is `malformed_response` rather than a half-understood row.
//
// `modelVersion` is optional on purpose (STORY-028 scenario 6): its absence must not fail a
// capture. When present it is recorded as modelFingerprint — a change to it is a methodology event.

const groundingChunkSchema = z.looseObject({
  web: z.looseObject({ uri: z.string().min(1), title: z.string().optional() }).optional(),
});

const groundingSupportSchema = z.looseObject({
  segment: z.looseObject({ startIndex: z.number().int().optional(), endIndex: z.number().int(), text: z.string().optional() }).optional(),
  groundingChunkIndices: z.array(z.number().int().min(0)).optional(),
});

const groundingMetadataSchema = z.looseObject({
  groundingChunks: z.array(groundingChunkSchema).optional(),
  groundingSupports: z.array(groundingSupportSchema).optional(),
  webSearchQueries: z.array(z.string()).optional(),
});

const candidateSchema = z.looseObject({
  content: z
    .looseObject({
      role: z.string().optional(),
      // A safety stop can return content with no parts at all.
      parts: z.array(z.looseObject({ text: z.string().optional(), thought: z.boolean().optional() })).optional(),
    })
    .optional(),
  finishReason: z.string().optional(),
  index: z.number().int().optional(),
  groundingMetadata: groundingMetadataSchema.optional(),
});

const usageMetadataSchema = z.looseObject({
  promptTokenCount: z.number().int().min(0).optional(),
  candidatesTokenCount: z.number().int().min(0).optional(),
  totalTokenCount: z.number().int().min(0).optional(),
  thoughtsTokenCount: z.number().int().min(0).optional(),
  toolUsePromptTokenCount: z.number().int().min(0).optional(),
});

export const geminiGenerateContentResponseSchema = z.looseObject({
  // Absent when the prompt itself was blocked (promptFeedback.blockReason).
  candidates: z.array(candidateSchema).optional(),
  promptFeedback: z.looseObject({ blockReason: z.string().optional() }).optional(),
  usageMetadata: usageMetadataSchema.optional(),
  modelVersion: z.string().optional(),
  responseId: z.string().optional(),
});
export type GeminiGenerateContentResponse = z.infer<typeof geminiGenerateContentResponseSchema>;

// The error envelope the API returns on a non-2xx (used by the health probe's detail).
export const geminiErrorResponseSchema = z.looseObject({
  error: z.looseObject({ code: z.number().int(), message: z.string(), status: z.string().optional() }),
});
export type GeminiErrorResponse = z.infer<typeof geminiErrorResponseSchema>;
