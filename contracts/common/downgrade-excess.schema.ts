import { z } from "zod";

// STORY-184 — one entry of the list a downgrade names: what the customer
// would lose or must reduce to move to a lower plan. It lives in `common/`
// because TWO contracts carry it and neither may import the other: the
// preview's `exceeds[]` (billing) and the `details.excess[]` of the
// `409 downgrade_exceeds_limits` refusal (error details).
//
// STORY-077 slice A — plans-and-entitlements.md §14: a downgrade is ACCEPTED
// and, at the cut-over, the least recently active excess projects and prompts
// (STORY-077 D2: the default keeps the most recently active; a recorded keep
// choice, contracts/billing/downgrade-keep.schema.ts, replaces the default)
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
      /**
       * STORY-077 (review round 3), `paused_at_period_end` entries only: EXACTLY how many rows the cut-over pauses for
       * this entry, worked out by the same reconcile the cut-over runs (a dry run), so the confirmation never names
       * fewer than the cut-over pauses. `current`/`excess` are the guard's slot counts and can differ from it.
       *   projects.max              the projects the cut-over pauses;
       *   prompts.max_per_project   the prompts in `project_id` paused by the per-project limit;
       *   prompts.max_total         the prompts paused by the workspace-wide limit, beyond the two above.
       * A project's own prompts paused WITH it are counted on its `items[].prompts`, not here. The prompts the cut-over
       * pauses in all = the sum of `items[].prompts` and of `paused` on the two prompt keys - ONLY while `items` names
       * every paused project (`items.length` equals the `projects.max` entry's `paused`). `items` is cut at 100, so above
       * 100 paused projects that sum undercounts and no total can be derived from this entry (a client shows none).
       */
      paused: z.number().int().nonnegative().optional(),
      /**
       * `projects.max` only: the projects the cut-over pauses, in the order it pauses them (least recently active first),
       * AT MOST 100 of them - `paused` stays exact past that, so `items.length < paused` means the list was cut.
       * `projects.max` counts TRACKING projects only (active or initializing; owner decision 2026-10-23): an archived or
       * person-paused project uses no slot and is never named, and neither is one an earlier downgrade already paused.
       * `prompts`: how many of that project's active prompts the cut-over pauses WITH it. Always set by this server;
       * optional on the wire so the addition is a minor client bump (STORY-023 AC5).
       */
      items: z.array(z.object({ id: z.uuid(), name: z.string(), prompts: z.number().int().nonnegative().optional() }).strict()).max(100).optional(),
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
