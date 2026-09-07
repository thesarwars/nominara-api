import { z } from "zod";

// STORY-046 — the activate response, and the prompt lifecycle response
// `PATCH /v1/prompts/{id}` shares with it.
//
// Designed, not transcribed: §3 documents the route and its 403 and nothing
// else. Shaped to mirror `generate`'s response so the two steps read as one
// flow.

/**
 * `FR-CRD-08` — "The coverage chip shows **activated / generated**, so a
 * capped project never appears to have full coverage."
 *
 * BOTH NUMBERS, not a ratio or a percentage. The requirement is that a
 * capped project cannot LOOK fully covered, and a single "80%" hides which
 * side moved: 8/10 and 40/50 render identically while meaning very different
 * things about a prompt set. Two integers also let the client render §10's
 * own sentence — "You have 8 of 40 slots left" — without arithmetic the
 * server already did.
 */
export const promptCoverageSchema = z
  .object({
    activated: z.number().int().nonnegative(),
    generated: z.number().int().nonnegative(),
  })
  .strict();

export const activationSummarySchema = z
  .object({
    requested: z.number().int().nonnegative(),
    activated: z.number().int().nonnegative(),
    /**
     * Already active before this call, and therefore not activated again.
     *
     * This is what makes replay observable rather than merely safe (AC12).
     * An idempotent retry reports `activated: 0, already_active: 8` — a
     * caller can tell "the first attempt landed" apart from "nothing
     * happened", which a bare `activated: 0` cannot express.
     */
    already_active: z.number().int().nonnegative(),
    /** After this call. §10 renders "You have N of M slots left" from it. */
    slots_remaining: z.number().int().nonnegative(),
  })
  .strict();

export const activatePromptsResponseSchema = z
  .object({
    activated_prompt_ids: z.array(z.string().uuid()),
    summary: activationSummarySchema,
    coverage: promptCoverageSchema,
    /** `projects.prompts_active` after the call — maintained in the same transaction (AC10). */
    prompts_active: z.number().int().nonnegative(),
    prompts_cap: z.number().int().nonnegative(),
    /**
     * A LITERAL ZERO, and the literal is the point.
     *
     * `plans-and-entitlements.md` §4 prices activation at "1 per prompt
     * activated" beyond the free 10, and nothing can charge yet:
     * `CreditGuard` is a pass-through no-op whose own comment puts the
     * reserve/commit path in EPIC-10, and wallets are not provisioned. §4
     * and §10's `FR-CRD-06` also disagree about whether activating an
     * archived candidate later costs anything — see the story.
     *
     * Typed as `0` rather than a number so a future edit that introduces the
     * debit CANNOT ship without changing this contract, which is the same
     * device `discover.ts` uses for its own "discovery charges nothing".
     * Reporting a plain `number` here would let a charge appear silently in
     * a field nobody re-reviewed.
     */
    credits_charged: z.literal(0),
  })
  .strict();

/** One prompt, as `PATCH /v1/prompts/{id}` returns it. */
export const promptResponseSchema = z
  .object({
    prompt_id: z.string().uuid(),
    project_id: z.string().uuid(),
    text: z.string().min(1).max(500),
    text_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    status: z.enum(["active", "paused", "archived"]),
    is_priority: z.boolean(),
    /**
     * The row this one replaced, when the change was a TEXT EDIT.
     *
     * `FR-FAN-01f` — "Editing a prompt's text creates a new `text_hash` and
     * starts a new history series, with the previous series preserved and
     * visibly marked `superseded`. Metric continuity is never faked across a
     * wording change." So an edit returns a DIFFERENT `prompt_id` than the
     * one in the path, and this member names the old one. A client that
     * assumed the id was stable would otherwise keep polling a superseded
     * row and see its metrics stop.
     */
    supersedes_prompt_id: z.string().uuid().nullable(),
    prompts_active: z.number().int().nonnegative(),
    prompts_cap: z.number().int().nonnegative(),
    credits_charged: z.literal(0),
  })
  .strict();

export type PromptCoverage = z.infer<typeof promptCoverageSchema>;
export type ActivationSummary = z.infer<typeof activationSummarySchema>;
export type ActivatePromptsResponse = z.infer<typeof activatePromptsResponseSchema>;
export type PromptResponse = z.infer<typeof promptResponseSchema>;
