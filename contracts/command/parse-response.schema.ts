import { z } from "zod";
import { commandIntentSchema, UNRESOLVED_INTENT } from "./command-intent.schema.js";

// STORY-085-A — api-specification.md §10 response, narrowed to what a
// grammar-only parse can honestly say.
//
// Not present yet, on purpose, and each is a field the reference lists:
//   `wallet`, `preview` — nothing here touches the ledger;
//   `actions[].credit_estimate`, `actions[].disabled_reason` — they need the
//   price estimator and the caller's role, which belong with execute.
// Their absence is not "none": a client must not read a missing
// `disabled_reason` as "enabled". That is why `execute` is a later slice and
// no action in this response is executable by itself.

export const commandSlotsSchema = z.record(z.string(), z.string());

export const commandActionSchema = z
  .object({
    action_id: z.string().min(1),
    kind: commandIntentSchema,
    label: z.string().min(1),
    is_mutating: z.boolean(),
    requires_confirmation: z.boolean(),
    required_permission: z.string().min(1).nullable(),
  })
  .strict();

export const commandCandidateSchema = z
  .object({
    intent: commandIntentSchema,
    confidence: z.number().min(0).max(1),
    slots: commandSlotsSchema,
  })
  .strict();

export const commandParseResponseSchema = z
  .object({
    parse_id: z.uuid(),
    /** `null` when nothing resolved the input (unresolved or ambiguous). `model` is not emitted by this slice. */
    resolved_by: z.literal("grammar").nullable(),
    intent: z.union([commandIntentSchema, z.literal(UNRESOLVED_INTENT)]),
    confidence: z.number().min(0).max(1),
    slots: commandSlotsSchema,
    /** Two or more when the input is ambiguous; empty otherwise. The caller disambiguates — the server never guesses. */
    candidates: z.array(commandCandidateSchema),
    /** Non-empty only when `intent` is `unresolved`. */
    suggestions: z.array(z.string().min(1)),
    actions: z.array(commandActionSchema),
    /** Always 0 in this slice; a cache hit is 0 whatever resolved the original (api-specification.md §10). */
    cost: z.object({ credits: z.literal(0) }).strict(),
    cached: z.boolean(),
  })
  .strict();

export type CommandParseResponse = z.infer<typeof commandParseResponseSchema>;
export type CommandAction = z.infer<typeof commandActionSchema>;
export type CommandCandidate = z.infer<typeof commandCandidateSchema>;
