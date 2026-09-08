import { z } from "zod";

// STORY-134 — `POST /v1/projects/{id}/prompts`. api-specification.md §3:
// "manual creation — **0 credits**".
//
// ONE FIELD, and the absences are the contract. `.strict()` refuses
// everything a caller might reasonably try to send, and each refusal is a
// decision:
//
//   intent_archetype   A manual prompt is stored `custom` — the sixteenth
//                      enum value exists for exactly this. Letting a caller
//                      claim `head_to_head` would report a provenance that
//                      is not true, and the archetype is what §6's matrix
//                      filters and the coverage row counts.
//   funnel_stage       Derived with the archetype. See persist.ts for why
//                      `consideration` is the assumption and how it is
//                      recorded as one.
//   text_hash          Derived. A supplied hash that disagreed with the text
//                      would break dedupe silently.
//   status             STORY-046 AC7: manual entry is "always free and still
//                      subject to the cap", so it lands `active` and takes a
//                      slot. A caller asking for `archived` would be asking
//                      to bypass the cap.
//   is_priority        A separate decision, bounded by the plan's subset
//                      size, and `PATCH /prompts/{id}` already owns it.
export const createPromptRequestSchema = z
  .object({
    text: z.string().trim().min(1).max(500),
  })
  .strict();

export type CreatePromptRequest = z.infer<typeof createPromptRequestSchema>;
