import { z } from "zod";

// STORY-184 — one entry of the list a downgrade names: what the customer
// would lose or must reduce to move to a lower plan. It lives in `common/`
// because TWO contracts carry it and neither may import the other: the
// preview's `exceeds[]` (billing) and the `details.excess[]` of the
// `409 downgrade_exceeds_limits` refusal (error details).
//
// STORY-077 slice A — plans-and-entitlements.md §14: a downgrade is ACCEPTED
// and, at the cut-over, the most recently created excess projects and prompts
// are PAUSED (never deleted). So a `structural` entry says what happens to it
// in `effect`:
//   paused_at_period_end  projects and prompts (`projects.max`,
//                         `prompts.max_total`, `prompts.max_per_project`):
//                         named, never blocking; paused at the cut-over.
//   must_reduce           seats, competitors and API keys, which §14 does not
//                         name as pausable: these still BLOCK the downgrade
//                         (STORY-184's refusal, kept for these keys only)
//                         until usage is reduced.
// The other three kinds are the "named warning" §14 requires and never block.
export const STRUCTURAL_EXCESS_EFFECTS = ["paused_at_period_end", "must_reduce"] as const;
export const downgradeExcessItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("structural"),
      /** An entitlement key from the structural set (`projects.max`, `prompts.max_total`, `seats.max`, …). */
      key: z.string().min(1),
      /** Set for a per-project key (`prompts.max_per_project`, `competitors.max_per_project`). */
      project_id: z.uuid().optional(),
      /** The target plan's ceiling, with the workspace's surviving add-ons and overrides applied. */
      limit: z.number().int().nonnegative(),
      current: z.number().int().nonnegative(),
      /** `current - limit`, always positive: an entry exists only when usage is above the ceiling. */
      excess: z.number().int().positive(),
      /** STORY-077: what the cut-over does with it. Only `must_reduce` blocks the downgrade. */
      effect: z.enum(STRUCTURAL_EXCESS_EFFECTS),
      /** `projects.max` only: the projects that exceed, most recently created first (the ones paused at the cut-over). */
      items: z.array(z.object({ id: z.uuid(), name: z.string() }).strict()).max(100).optional(),
    })
    .strict(),
  z.object({ kind: z.literal("feature_lost"), key: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("addon_dropped"), addon: z.enum(["extra_project", "extra_seat"]), quantity: z.number().int().positive() }).strict(),
  z
    .object({
      kind: z.literal("retention_shortened"),
      key: z.string().min(1),
      /** Null: unlimited. */
      from_days: z.number().int().positive().nullable(),
      /** 0: the target plan keeps none (a tier whose rollup retention is "—"). */
      to_days: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type DowngradeExcessItem = z.infer<typeof downgradeExcessItemSchema>;
