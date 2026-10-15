import { z } from "zod";

// STORY-046 AC3 - `POST /projects/{id}/prompts/activate/preview`, free.
//
// The QUOTE half of the two-step guard rail (api-specification.md section 1,
// `X-Nominara-Confirmed-Credits`; owner decision 2026-10-15, option C). An
// activation is variable-priced - it depends on which of the named prompts are
// new to the project and how much of the free allowance is left - so the figure
// the operator must see is computed by the server, by the same rule and from the
// same plan values the activation charges by.
//
// `credits` is the figure to echo in `X-Nominara-Confirmed-Credits` on
// `POST /projects/{id}/prompts/activate` and on `PATCH /prompts/{id}` (send
// `prompt_ids: [id]`). When it is 0 the activation debits nothing and needs no
// header.

export const activatePromptsPreviewResponseSchema = z
  .object({
    /** What activating exactly these prompts would debit now, in whole credits. 0 = free. */
    credits: z.number().int().nonnegative(),
    prompts: z
      .object({
        requested: z.number().int().nonnegative(),
        /** Already active: they take no slot and cost nothing. */
        already_active: z.number().int().nonnegative(),
        /** First activations inside the project's free allowance. */
        free: z.number().int().nonnegative(),
        /** First activations beyond it; each costs the plan's per-prompt price. */
        charged: z.number().int().nonnegative(),
      })
      .strict(),
    /** A LITERAL ZERO: a preview debits nothing and reserves nothing. */
    credits_charged: z.literal(0),
  })
  .strict();

export type ActivatePromptsPreviewResponse = z.infer<typeof activatePromptsPreviewResponseSchema>;
