import { z } from "zod";

// STORY-046 — PATCH /v1/prompts/{id}. api-specification.md §3:
// "pause/resume, priority flag, edit text (re-hashes and starts a new
// series)".
//
// Note the route is TOP-LEVEL, not nested under the project. §3 puts it
// there and it is the right shape: a prompt id is globally unique and the
// project is already implied by it, so requiring the project in the path
// would let a caller name a mismatched pair and need a fourth error for it.

export const updatePromptRequestSchema = z
  .object({
    /**
     * `active` resumes, `paused` stops capture, `archived` frees a slot.
     *
     * THE PAUSE/ARCHIVE DISTINCTION IS THE WHOLE POINT of having three
     * values rather than a boolean. `PROMPT_OCCUPIES_SLOT` in
     * `structural-usage.ts` is `status <> 'archived'`, so pausing frees
     * NOTHING while archiving frees a slot — the story's own reason being
     * that "a paused prompt still occupies configuration and can be resumed,
     * so treating it as free capacity would let a customer exceed their cap
     * by pausing and adding".
     */
    status: z.enum(["active", "paused", "archived"]).optional(),

    /** Bounded by the plan's subset size, which is checked in the service. */
    is_priority: z.boolean().optional(),

    /**
     * A NEW WORDING, which creates a NEW ROW.
     *
     * `FR-FAN-01f` — "Editing a prompt's text creates a new `text_hash` and
     * starts a new history series, with the previous series preserved and
     * visibly marked `superseded`. Metric continuity is never faked across a
     * wording change."
     *
     * So this field does not update `text` in place. The response's
     * `prompt_id` is the NEW row's and `supersedes_prompt_id` names the old
     * one. That is unusual enough for a PATCH that it is stated on the field
     * as well as in the response.
     */
    text: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((value) => Object.values(value).some((member) => member !== undefined), {
    message: "at least one of status, is_priority or text must be supplied",
  });

export type UpdatePromptRequest = z.infer<typeof updatePromptRequestSchema>;
