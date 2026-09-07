import { z } from "zod";
import { DISCOVERY_STATUSES } from "./create-project-response.schema.js";

// STORY-132 — the workspace matrix row. api-specification.md §3:
// "GET /projects — workspace matrix; includes visibility_blended,
// sparkline_30d, open_task_count".
//
// THE SCORE FIELDS ARE NULLABLE, AND THAT IS THE HONEST SHAPE. Their producer
// is STORY-042's rollup worker, which sits behind the parser and the scoring
// core in Slice 4. The columns exist on `projects` and are genuinely NULL
// until a rollup runs, so a null here reports the truth; a 0 would assert a
// score of zero, which is a different and false claim. lib/copy/metrics.ts
// draws the same distinction on the client — absence is not zero.
export const projectListItemSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    root_domain: z.string(),
    kind: z.enum(["brand", "product_line"]),
    status: z.string(),
    discovery_status: z.enum(DISCOVERY_STATUSES),

    prompts_active: z.number().int().nonnegative(),
    prompts_cap: z.number().int().nonnegative(),
    open_task_count: z.number().int().nonnegative(),

    /** Null until the domain is verified — gates audit scope, not price. */
    domain_verified_at: z.string().nullable(),
    created_at: z.string(),

    // --- filled by STORY-042's rollup worker, null until then ---
    visibility_blended: z.number().nullable(),
    visibility_delta_30d: z.number().nullable(),
    aux_score_current: z.number().nullable(),
    /** The denormalised 30-day series the matrix draws without a per-project query. */
    sparkline_30d: z.unknown().nullable(),
  })
  .strict();

export const projectListResponseSchema = z.array(projectListItemSchema);

export type ProjectListItem = z.infer<typeof projectListItemSchema>;
