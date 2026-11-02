import { z } from "zod";

// STORY-028 / owner decision 42 - OpenRouter's /chat/completions response, as recorded (fixtures/openrouter-recorded.ts). Vendor objects
// are `looseObject` (the vendor adds fields without notice); what we READ is strict about type, so a payload of the wrong shape is
// `malformed_response` rather than a half-understood row. `model` is optional on purpose (STORY-028 scenario 6).

const urlCitationSchema = z.looseObject({
  type: z.literal("url_citation"),
  url_citation: z.looseObject({
    url: z.string().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
    start_index: z.number().int().optional(),
    end_index: z.number().int().optional(),
  }),
});

const messageSchema = z.looseObject({
  role: z.string().optional(),
  // null when the whole token budget went on reasoning (recorded: claude at max_tokens 400).
  content: z.string().nullable().optional(),
  refusal: z.string().nullable().optional(),
  // Other annotation types may appear; only url_citation is read.
  annotations: z.array(z.looseObject({ type: z.string() })).optional(),
});

export const openRouterChatResponseSchema = z.looseObject({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z
    .array(
      z.looseObject({
        finish_reason: z.string().nullable().optional(),
        message: messageSchema,
      }),
    )
    .min(1),
  usage: z
    .looseObject({
      prompt_tokens: z.number().int().min(0).optional(),
      completion_tokens: z.number().int().min(0).optional(),
      total_tokens: z.number().int().min(0).optional(),
      cost: z.number().min(0).optional(),
    })
    .optional(),
});
export type OpenRouterChatResponse = z.infer<typeof openRouterChatResponseSchema>;

export { urlCitationSchema };

/** The error envelope, on a non-2xx and also (OpenRouter's documented quirk) on a 200 when the upstream faulted. */
export const openRouterErrorEnvelopeSchema = z.looseObject({
  error: z.looseObject({ code: z.union([z.number(), z.string()]).optional(), message: z.string().optional() }),
});
