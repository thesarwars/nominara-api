import { z } from "zod";
import { dataSourceSchema } from "./data-source.schema.js";

// NEW-C-1 — `GET /v1/projects/{id}/competitors/panel`, `api-specification.md`
// §3's Analytics row ("per-engine comparison, head-to-head win rate,
// detection variance"); `scoring-models.md` §12; STORY-092 (backend half),
// FR-CO-01, FR-CO-02, FR-CO-05.
//
// EVERY MEASURE IS NULLABLE, AND NULL IS NOT ZERO. A detected-but-untracked
// entity has no tracked score by definition, so its `blended`, `per_engine`
// and `sov` are null — a zero in a competitor table reads as "they are
// invisible", the opposite of what "detected, not tracked" means (STORY-092
// AC, technical notes).

export const competitorPanelQuerySchema = z
  .object({
    timeframe: z.enum(["7d", "30d", "90d"]).default("30d"),
    /** Comma-separated engine keys. A NARROWING of the project's engine set. */
    engines: z.string().min(1).optional(),
  })
  .strict();

export const competitorRowSchema = z
  .object({
    /** The competitor id; the project id on the brand's row; null for a detected-not-tracked entity. */
    entity_id: z.string().uuid().nullable(),
    label: z.string().min(1),
    root_domain: z.string().nullable(),
    /** The brand's own row — always present, always first. */
    is_brand: z.boolean(),
    /** False only for detected-but-untracked rows. */
    tracked: z.boolean(),
    /** Detected-not-tracked only: distinct captures naming the entity in the last 30 days. Null otherwise. */
    appearances: z.number().int().nonnegative().nullable(),
    /** §3 blended Visibility Score across engines. Null when unmeasured, and always null when untracked. */
    blended: z.number().nullable(),
    /** Visibility Score per engine key. Every requested engine has a key; a null value is "not measured". */
    per_engine: z.record(z.string(), z.number().nullable()),
    /**
     * §2.3 SoV in [0,1] — the share of the WHOLE answer, untracked entities
     * included in the denominator. NOT `category_share`.
     */
    sov: z.number().nullable(),
    /** §12 `SoV(e) / Σ_{k ∈ K} SoV(k)` — the entity's share of the TRACKED set only. */
    category_share: z.number().nullable(),
    /** §6 SentimentScore in [0,100]. Null when the entity was never mentioned. */
    sentiment: z.number().nullable(),
    /** §4 share of the cited corpus held by the entity's own domain, in [0,1]. */
    citation_share: z.number().nullable(),
    /**
     * §12 `head_to_head_win_rate(brand, entity)` in [0,1] — over the cells
     * where BOTH appear. Null for the brand's own row, and when no cell
     * had both.
     */
    h2h_win_rate: z.number().nullable(),
    /** §12 `stddev(sov)` across the window's days, per engine. Null under two measured days. */
    detection_variance: z.record(z.string(), z.number().nullable()),
    /** Blended Visibility Score minus the prior window's. Null when either window is under 30 cells. */
    delta: z.number().nullable(),
  })
  .strict();

export const competitorPanelResponseSchema = z
  .object({
    project_id: z.string().uuid(),
    timeframe: z.enum(["7d", "30d", "90d"]),
    window: z.object({ from: z.string(), to: z.string(), timezone: z.string() }).strict(),
    /** The engine keys the per-engine columns cover. */
    engines: z.array(z.string()),
    /**
     * Per engine, whether the window's captures are real or seeded demo data:
     * `live`, `demo`, or `mixed` when both kinds contributed. Null when
     * nothing was measured — never `demo` by default.
     */
    engine_data_source: z.record(z.string(), dataSourceSchema.nullable()),
    /** `competitors.max_per_project`; null when the plan is unlimited. */
    competitors_cap: z.number().int().nonnegative().nullable(),
    tracked_count: z.number().int().nonnegative(),
    rows: z.array(competitorRowSchema),
  })
  .strict();

export type CompetitorPanelQuery = z.infer<typeof competitorPanelQuerySchema>;
export type CompetitorRow = z.infer<typeof competitorRowSchema>;
export type CompetitorPanelResponse = z.infer<typeof competitorPanelResponseSchema>;
