import { z } from "zod";

// STORY-034 AC2 — `POST /projects/{id}/runs`.
//
// AN EMPTY BODY, AND THE EMPTINESS IS THE CONTRACT.
//
// §3: "Manual deep scan — one flat price. Runs the full tracked set on every
// enabled engine plus the AUX audit... **The body takes no scope or engine
// selection.**"
//
// The story's technical note gives the reason, and it is a pricing one
// rather than a simplification for its own sake: "a flat price only holds if
// the scope is fixed; allowing a caller to select engines would either
// require per-cell pricing or let them buy the whole scan and use a fraction
// of it."
//
// `.strict()` is therefore load-bearing, not house style. A request carrying
// `{"engines": ["chatgpt"]}` is refused as an unknown field — which is test
// scenario 4 — rather than silently ignored, because a caller that believes
// it narrowed the scope and was charged the full flat price has been
// mischarged by exactly the amount it tried to avoid.
export const triggerRunRequestSchema = z.object({}).strict();

export type TriggerRunRequest = z.infer<typeof triggerRunRequestSchema>;
