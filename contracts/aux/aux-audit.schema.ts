import { z } from "zod";
import { PAGINATION_LIMIT_DEFAULT, PAGINATION_LIMIT_MAX } from "../common/pagination.schema.js";

// NEW-C-10 (STORY-052; api-specification.md "AUX") — an audit on the wire.
//
//   GET /v1/aux-audits/{id}                    score and category breakdown
//   GET /v1/projects/{id}/aux-audits?limit=1   the latest audit (NOT in the
//                                              reference; the AUX Health page
//                                              needs "the latest", so it is an
//                                              addition the reference should
//                                              absorb)
//
// Enum members are the DB CHECK values verbatim (schemas/aux.md `aux_audits`):
// scope 'domain_root' | 'key_pages' | 'single_url' | 'sitemap_sample' |
// 'public_surface'; status 'queued' | 'running' | 'completed' | 'partial' |
// 'failed'. The client's pending.ts used 'full' and a three-value status; the
// contract is the authority.
//
// `null` is "nothing measured" and `0` is "measured zero", everywhere:
//   * `aux_score` is null for an audit that did not run every category (the
//     site-file stage publishes one category's subscore, not a score);
//   * `delta` is null without a previous scored audit;
//   * `llms_txt_present` / `sitemap_url_count` are null when the file could not
//     be fetched, false / 0 when it was fetched and absent / empty.
//
// Not in this contract, deliberately: the manual re-audit price and
// `credits_charged` (the priced POST /projects/{id}/aux-audits is deferred),
// and `next_scheduled_at` (no source for it yet).

export const AUX_CATEGORIES = ["crawler_access", "structured_data", "context_fitness", "render_mode", "entity_clarity", "freshness"] as const;
export const auxCategorySchema = z.enum(AUX_CATEGORIES);

export const AUX_AUDIT_TRIGGERS = ["scheduled", "manual", "post_fix", "onboarding"] as const;
export const AUX_AUDIT_SCOPES = ["domain_root", "key_pages", "single_url", "sitemap_sample", "public_surface"] as const;
export const AUX_AUDIT_STATUSES = ["queued", "running", "completed", "partial", "failed"] as const;

/** `score_breakdown` (jsonb): category -> subscore in 0..1; only the categories that ran are present. */
export const auxScoreBreakdownSchema = z.partialRecord(auxCategorySchema, z.number().min(0).max(1));
export type AuxScoreBreakdown = z.infer<typeof auxScoreBreakdownSchema>;

export const auxAuditCategorySchema = z
  .object({
    category: auxCategorySchema,
    /** W_cat (scoring-models.md §7). */
    weight: z.number(),
    /** 0..1 */
    subscore: z.number().min(0).max(1),
    /**
     * Rules of this category that did NOT run in this audit (a held rule, one with no input, one the document model cannot judge). A rule that
     * did not run adds no penalty, so a non-empty list means the subscore is not a full measurement of the category: a client labels it.
     */
    rules_not_evaluated: z.array(z.string()),
  })
  .strict();

export const auxExcludedRuleSchema = z
  .object({
    rule_code: z.string(),
    /** The catalog title; the code itself when the catalog has no such rule. */
    title: z.string(),
  })
  .strict();

export const auxAuditSchema = z
  .object({
    audit_id: z.string().uuid(),
    project_id: z.string().uuid(),
    trigger: z.enum(AUX_AUDIT_TRIGGERS),
    scope: z.enum(AUX_AUDIT_SCOPES),
    status: z.enum(AUX_AUDIT_STATUSES),
    started_at: z.string().nullable(),
    completed_at: z.string().nullable(),
    created_at: z.string(),
    pages_crawled: z.number().int(),
    pages_failed: z.number().int(),
    /**
     * 0..100, or null when the audit did not produce a score. When `score_partial` is true it is computed over the RULES that were decided (owner
     * decisions 38 and 52): a category is scored on the decided rules only, a category with none is left out, and the sum is renormalised to 100.
     * Never present it as a full score.
     */
    aux_score: z.number().nullable(),
    /**
     * True when any rule went unmeasured (owner decision 52): a category is missing, or a published category lists `rules_not_evaluated`.
     * False only for a score in which every rule of every category was decided, and for no score.
     */
    score_partial: z.boolean(),
    /** The categories with no published subscore in this audit (all six when nothing was measured). Never empty on a partial score. */
    unmeasured_categories: z.array(auxCategorySchema),
    /** True when the critical-access hard cap applied; the interface states it whenever it is. */
    capped: z.boolean(),
    /**
     * aux_score minus the previous scored audit's; null when either is absent, and null when the two audits were not measured the same way (a different
     * `rule_version`, or a different set of unmeasured rules): two scores over different rules are not a movement.
     */
    delta: z.number().nullable(),
    rule_version: z.string(),
    categories: z.array(auxAuditCategorySchema),
    /** Rules that could not run, always named. */
    excluded_rules: z.array(auxExcludedRuleSchema),
    findings: z
      .object({ critical: z.number().int(), high: z.number().int(), medium: z.number().int(), low: z.number().int() })
      .strict(),
    llms_txt_present: z.boolean().nullable(),
    sitemap_url_count: z.number().int().nullable(),
  })
  .strict();

export type AuxAudit = z.infer<typeof auxAuditSchema>;

export const auxAuditListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .overwrite((value) => Math.min(value, PAGINATION_LIMIT_MAX))
      .max(PAGINATION_LIMIT_MAX)
      .default(PAGINATION_LIMIT_DEFAULT),
  })
  .strict();

export type AuxAuditListQuery = z.infer<typeof auxAuditListQuerySchema>;
