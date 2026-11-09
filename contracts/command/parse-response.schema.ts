import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";
import { commandIntentSchema, UNRESOLVED_INTENT } from "./command-intent.schema.js";

// STORY-085-A / STORY-085 (decisions 78c, 79) - api-specification.md section 10 response.
//
// TWO LAYERS, and the split is the tenancy argument. The parse cache is keyed per
// workspace, so what it stores must be true for EVERY caller of that workspace: the
// grammar result (`commandGrammarParseSchema`), whose slots are the typed text. Everything
// that depends on WHO is asking - the entities bound to ids, `disabled_reason`, the
// price - is added after the cache read, under the caller's own role and project scope.
// A scoped manager's parse therefore never inherits an entity another caller bound.

export const commandSlotsSchema = z.record(z.string(), z.string());

/**
 * How POST /command/execute treats the action: `execute` (the server runs it: a deep scan, a task),
 * `open_screen` (the client opens the screen, prefilled: tool runs, a new project, an invitation, a report),
 * `client` (answered or navigated in the browser; execute refuses it).
 */
export const commandActionHandlingSchema = z.enum(["execute", "open_screen", "client"]);

export const commandGrammarActionSchema = z
  .object({
    action_id: z.string().min(1),
    kind: commandIntentSchema,
    label: z.string().min(1),
    is_mutating: z.boolean(),
    requires_confirmation: z.boolean(),
    required_permission: z.string().min(1).nullable(),
    handling: commandActionHandlingSchema,
  })
  .strict();

export const commandActionSchema = commandGrammarActionSchema
  .extend({
    /** `null` when the caller may run it; otherwise why not, e.g. `forbidden:task:create`, `missing:project`. Disabled, never hidden (FR-CMD-05). */
    disabled_reason: z.string().min(1).nullable(),
    /** The exact figure the confirmed-credits header must echo, or `null` when the action costs nothing to run. */
    credit_estimate: z.object({ credits: z.number().int().min(0) }).strict().nullable(),
  })
  .strict();

/** An id the parse bound from the typed text, within the CALLER's visibility. */
export const commandBoundEntitySchema = z
  .object({
    slot: z.string().min(1),
    kind: z.enum(["project"]),
    id: lowercaseUuidSchema,
    name: z.string().min(1),
  })
  .strict();

export const commandCandidateSchema = z
  .object({
    intent: commandIntentSchema,
    confidence: z.number().min(0).max(1),
    slots: commandSlotsSchema,
  })
  .strict();

export const commandGrammarParseSchema = z
  .object({
    /** `null` when nothing resolved the input (unresolved or ambiguous). `model` is not emitted by this slice. */
    resolved_by: z.literal("grammar").nullable(),
    intent: z.union([commandIntentSchema, z.literal(UNRESOLVED_INTENT)]),
    confidence: z.number().min(0).max(1),
    slots: commandSlotsSchema,
    /** Two or more when the input is ambiguous; empty otherwise. The caller disambiguates - the server never guesses. */
    candidates: z.array(commandCandidateSchema),
    /** Non-empty only when `intent` is `unresolved`. */
    suggestions: z.array(z.string().min(1)),
    actions: z.array(commandGrammarActionSchema),
    /** What the PARSE costs: always 0 (a cache hit is 0 whatever resolved the original). An action's own price is `actions[].credit_estimate`. */
    cost: z.object({ credits: z.literal(0) }).strict(),
  })
  .strict();

export const commandParseResponseSchema = commandGrammarParseSchema
  .omit({ actions: true })
  .extend({
    parse_id: lowercaseUuidSchema,
    actions: z.array(commandActionSchema),
    /** Entities bound after the cache, under the caller's role and project scope. */
    entities: z.array(commandBoundEntitySchema),
    cached: z.boolean(),
  })
  .strict();

export type CommandGrammarParse = z.infer<typeof commandGrammarParseSchema>;
export type CommandParseResponse = z.infer<typeof commandParseResponseSchema>;
export type CommandAction = z.infer<typeof commandActionSchema>;
export type CommandCandidate = z.infer<typeof commandCandidateSchema>;
