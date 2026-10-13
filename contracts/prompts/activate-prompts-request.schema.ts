import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";

// STORY-046 — POST /v1/projects/{id}/prompts/activate.
//
// api-specification.md §3 gives the route and one behaviour — "activate a
// chosen subset; `403 entitlement_exceeded` names the remaining slots" — and
// no request or response shape. So this is designed, not transcribed, and it
// mirrors `generate`'s shape deliberately: a client that reads one response
// should not have to learn a second vocabulary for the step immediately
// after it.
//
// ALL OR NOTHING, which is what §3's 403 decides. A caller who names ten
// prompts with eight slots left is REFUSED, not partially served. Two
// reasons, and the second is the one that matters: a partial activation
// gives the customer no way to say which eight they wanted, and once
// activation charges (blocked — see the story) a partial success is a
// partial debit for an outcome nobody asked for.

export const activatePromptsRequestSchema = z
  .object({
    /**
     * The chosen subset, by id.
     *
     * §10's flow is "we've pre-selected 8 that preserve the widest
     * buyer-intent coverage — [Activate 8]", so the customer confirms a set
     * the server proposed and may edit it first. Ids rather than a count:
     * a count would let the server pick again between the dialog rendering
     * and the click, and activate something the customer never saw.
     */
    prompt_ids: z.array(lowercaseUuidSchema).min(1).max(500),
  })
  .strict();

export type ActivatePromptsRequest = z.infer<typeof activatePromptsRequestSchema>;
