import { z } from "zod";
import { auxCategorySchema } from "../aux/aux-audit.schema.js";
import { auxFindingSchema } from "../aux/aux-finding.schema.js";
import { auxPatchSchema } from "../aux/patch.schema.js";

// STORY-082 - the AUX audit tool: POST /v1/tools/aux-audit (api-specification.md section 3 "Tools", FR-TL-03) and the stored snapshot that lives in
// tool_runs.result_json.
//
//   mode "site_files"  FREE, the well-known site files only, cached per host. Available on every tier.
//   mode "full"        priced per page band (10 credits up to 25 pages, +1 per page after - FR-TL-03). Site files are INCLUDED and never billed apart, and every
//                      copy-ready patch is included: the fix is never priced separately from the diagnosis.
//
// DOMAIN VERIFICATION CONTROLS SCOPE, NOT PRICE. The same page count costs the same on a verified and an unverified domain; an unverified domain is audited
// at `public_surface` (the supplied URL and the site files) and the result says so: the score is labelled partial, the rules that did not run are named, and
// the weight they carry is stated. A partial score never reads as a full one.
//
// The route is asynchronous (KAD-06): the fetches happen in the worker. It answers 202 with the run - already `completed` when a cached site-files answer
// was served - and the result is read from GET /v1/tools/runs/{id} like every other tool's.

/** The ceiling of the request field; the plan's own page cap (page-selection.ts) is what the service enforces. */
export const AUX_AUDIT_TOOL_MAX_PAGES = 100;

const urlSchema = z.url({ protocol: /^https?$/ }).max(2048);

export const auxAuditToolRequestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("site_files"), url: urlSchema }).strict(),
  z.object({ mode: z.literal("full"), url: urlSchema, pages: z.number().int().min(1).max(AUX_AUDIT_TOOL_MAX_PAGES).optional() }).strict(),
]);

export const auxAuditToolEstimateQuerySchema = z
  .object({ pages: z.coerce.number().int().min(1).max(AUX_AUDIT_TOOL_MAX_PAGES).optional() })
  .strict();

/** The free quote: the figure to echo in `X-Nominara-Confirmed-Credits`, the band it falls in, and what it includes. Recomputed from the page count on every call. */
export const auxAuditToolEstimateSchema = z
  .object({
    mode: z.literal("full"),
    pages: z.number().int().positive(),
    /** The plan's page cap: the most pages a request can name. */
    page_cap: z.number().int().positive(),
    credits: z.number().int().nonnegative(),
    band: z
      .object({
        /** "up to 25 pages" for the first band; "26 pages (25 included, +1 per extra page)" beyond it. */
        label: z.string().min(1),
        first_band_pages: z.number().int().positive(),
        beyond_first_band: z.boolean(),
        extra_pages: z.number().int().nonnegative(),
      })
      .strict(),
    pricing: z.object({ pages_priced: z.number().int().positive(), base_credits: z.number().int(), base_page_band: z.number().int(), extra_page_credits: z.number().int() }).strict(),
    /** Site files are part of the audit, not a second charge. */
    site_files_included: z.literal(true),
    /** Every copy-ready patch is included at no additional charge. */
    patches_free: z.literal(true),
    /** Verification changes the scope, never this figure. */
    price_depends_on_verification: z.literal(false),
    credits_charged: z.literal(0),
  })
  .strict();

export const auxAuditToolAcceptedSchema = z
  .object({
    tool_run_id: z.uuid(),
    mode: z.enum(["site_files", "full"]),
    /** `completed` only for a site-files answer served from the per-host cache: no fetch was made. */
    status: z.enum(["running", "completed"]),
    cached: z.boolean(),
    credits_charged: z.number().int().nonnegative(),
    pages_requested: z.number().int().positive().nullable(),
    /** What the domain's verification state authorises. Scope, never price. */
    scope: z.enum(["public_surface", "key_pages"]),
    domain_verified: z.boolean(),
    poll: z.string().min(1),
  })
  .strict();

/** One AI agent, in terms of what robots.txt lets it do. `unknown` when robots.txt could not be read: never "allowed" by default. */
export const auxAiAgentAccessSchema = z
  .object({ agent: z.string().min(1), access: z.enum(["allowed", "blocked", "unknown"]), meaning: z.string().min(1) })
  .strict();

export const auxSiteFileReportSchema = z
  .object({
    file: z.enum(["robots.txt", "llms.txt", "sitemap"]),
    state: z.enum(["present", "absent", "unreachable"]),
    /** What this file means for an AI agent, as a sentence. */
    meaning: z.string().min(1),
  })
  .strict();

export const auxSiteFilesAccessSchema = z
  .object({
    /** What the files permit and deny for AI agents - the headline of site-files mode. */
    summary: z.string().min(1),
    agents: z.array(auxAiAgentAccessSchema),
    files: z.array(auxSiteFileReportSchema),
    /** The site-file rules' findings (AUX-R-001..004, 007), consequence first. */
    checked_at: z.iso.datetime(),
  })
  .strict();

export const auxToolPatchSchema = auxPatchSchema
  .pick({ kind: true, target_url: true, content_after: true, unified_diff: true, jsonld_blocks: true, reversal: true, preconditions: true, explanation: true, derivation: true, requires_human_review: true, review_reason: true, risk_flags: true })
  .extend({ free: z.literal(true), credits_charged: z.literal(0) })
  .strict();

/** The in-project finding's own fields (the same renderer builds both), with the consequence first; the patch rides on it. */
export const auxToolFindingSchema = auxFindingSchema
  .pick({ consequence: true, title: true, rule_code: true, category: true, severity: true, url: true, affected_pages: true, measured_value: true, threshold_value: true, evidence: true, auto_fixable: true, requires_human_review: true })
  .extend({ patch: auxToolPatchSchema.nullable() })
  .strict();

export const auxExcludedRuleSchema = z
  .object({
    rule_code: z.string().min(1),
    title: z.string().min(1),
    category: auxCategorySchema,
    /** This rule's share of the whole 100-point score, in points (category weight x rule weight x 100). */
    weight_points: z.number().nonnegative(),
    reason: z.string().min(1),
  })
  .strict();

export const auxToolScoreSchema = z
  .object({
    /** `null` = no page was judged (not measured); never 0 for that. */
    value: z.number().min(0).max(100).nullable(),
    /** True whenever any rule went unmeasured. A partial score is never presented as a full one. */
    partial: z.boolean(),
    label: z.string().min(1),
    /** The points of the 100-point score that the excluded rules carry. */
    excluded_weight_points: z.number().nonnegative(),
    unmeasured_categories: z.array(auxCategorySchema),
    capped: z.boolean(),
  })
  .strict();

export const auxToolPageFailureSchema = z.object({ url: z.string().min(1), failures: z.array(z.object({ stage: z.string(), reason: z.string(), http_status: z.number().int().nullable() }).strict()) }).strict();

export const auxAuditToolResultSchema = z
  .object({
    schema_version: z.literal(1),
    mode: z.enum(["site_files", "full"]),
    url: z.string().min(1),
    host: z.string().min(1),
    domain_verified: z.boolean(),
    scope: z.enum(["public_surface", "key_pages"]),
    /** Always present, from the shared site-files check. */
    site_files: auxSiteFilesAccessSchema,
    /** Full mode only. */
    audit: z
      .object({
        score: auxToolScoreSchema,
        /** Rules that did not run, each with the points it carries. On an unverified domain these are named with the scope that limited them. */
        excluded_rules: z.array(auxExcludedRuleSchema),
        /** Why the scope was narrower than the full audit - present exactly when the domain is not verified. */
        scope_note: z.string().nullable(),
        findings: z.array(auxToolFindingSchema),
        findings_total: z.number().int().nonnegative(),
        /** Findings left out to fit the stored result (24 KB). Counted, never silent. */
        findings_omitted: z.number().int().nonnegative(),
        patches_included: z.number().int().nonnegative(),
        pages: z
          .object({
            requested: z.number().int().positive(),
            raw_fetched: z.number().int().nonnegative(),
            rendered_fetched: z.number().int().nonnegative(),
            judged: z.number().int().nonnegative(),
            unreachable: z.array(auxToolPageFailureSchema),
          })
          .strict(),
        charge: z.object({ credits: z.number().int().nonnegative(), band_label: z.string().min(1), site_files_included: z.literal(true), patches_credits: z.literal(0) }).strict(),
      })
      .strict()
      .nullable(),
  })
  .strict();

/** The signed `lookup.execute` job payload for an AUX audit tool run (the signing layer adds `workspaceId` and `kid`). */
export const auxAuditToolJobPayloadSchema = z
  .object({
    tool: z.literal("aux_audit"),
    toolRunId: z.uuid(),
    mode: z.enum(["site_files", "full"]),
    targetUrl: z.string().min(1),
    pages: z.number().int().positive().nullable(),
    credits: z.number().int().nonnegative(),
    startedAt: z.iso.datetime(),
  })
  .passthrough();

export type AuxAuditToolRequest = z.infer<typeof auxAuditToolRequestSchema>;
export type AuxAuditToolEstimateQuery = z.infer<typeof auxAuditToolEstimateQuerySchema>;
export type AuxAuditToolEstimate = z.infer<typeof auxAuditToolEstimateSchema>;
export type AuxAuditToolAccepted = z.infer<typeof auxAuditToolAcceptedSchema>;
export type AuxAuditToolResult = z.infer<typeof auxAuditToolResultSchema>;
export type AuxSiteFilesAccess = z.infer<typeof auxSiteFilesAccessSchema>;
export type AuxToolFinding = z.infer<typeof auxToolFindingSchema>;
export type AuxToolPatch = z.infer<typeof auxToolPatchSchema>;
export type AuxAuditToolJobPayload = z.infer<typeof auxAuditToolJobPayloadSchema>;
