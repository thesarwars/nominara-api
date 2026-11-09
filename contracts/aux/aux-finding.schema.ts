import { z } from "zod";
import { lowercaseUuidSchema } from "../common/uuid.schema.js";
import { PAGINATION_LIMIT_DEFAULT, PAGINATION_LIMIT_MAX } from "../common/pagination.schema.js";
import { auxCategorySchema } from "./aux-audit.schema.js";
import { auxGuidanceSchema, auxPatchSchema } from "./patch.schema.js";
import { auxRuleEvidenceSchema } from "./rule-finding.schema.js";
import { auxFindingSeveritySchema, siteFileEvidenceSchema } from "./site-file-finding.schema.js";

// NEW-C-10 (STORY-052; api-specification.md "AUX") — a finding on the wire, the
// list filter, and the one write a client has: PATCH /v1/aux-findings/{id}.
//
// THE RESOLUTION RULE (aux-and-geo-analysis.md §3). `resolved` is set only by a
// later audit that fails to reproduce the finding. The PATCH body names it so
// that the refusal is a typed 422 that says why, rather than a generic enum
// 400; nothing can set it. `in_progress`, `regressed` and `stale` are not
// accepted at all (400): they are not client states.

export const AUX_FINDING_STATUSES = ["open", "acknowledged", "in_progress", "resolved", "regressed", "wont_fix", "stale"] as const;
export const auxFindingStatusSchema = z.enum(AUX_FINDING_STATUSES);

/** A wont_fix reason is a sentence, not a document. */
export const AUX_WONT_FIX_REASON_MAX = 1000;

/**
 * `aux_findings.evidence` is jsonb and holds one of three shapes: the site-file
 * evaluators' (NEW-C-8), the document-model rules' (STORY-051) or the demo seed's `{selector, snippet, measured,
 * expected}`. Both read; neither is a request.
 */
export const auxDemoEvidenceSchema = z
  .object({
    selector: z.string().nullable(),
    snippet: z.string().nullable(),
    measured: z.unknown(),
    expected: z.unknown(),
  })
  .strict();
export const auxFindingEvidenceSchema = z.union([siteFileEvidenceSchema, auxRuleEvidenceSchema, auxDemoEvidenceSchema]);

export const auxFindingSchema = z
  .object({
    finding_id: z.string().uuid(),
    audit_id: z.string().uuid(),
    project_id: z.string().uuid(),
    rule_code: z.string(),
    title: z.string(),
    /** null only if the catalog row is missing, which the FK on rule_code rules out. */
    category: auxCategorySchema.nullable(),
    severity: auxFindingSeveritySchema,
    status: auxFindingStatusSchema,
    /** The catalog's rationale: the AI consequence, in customer language. */
    consequence: z.string().nullable(),
    url: z.string().nullable(),
    affected_pages: z.number().int(),
    /** null = not measured; 0 = measured zero. */
    measured_value: z.number().nullable(),
    threshold_value: z.number().nullable(),
    evidence: auxFindingEvidenceSchema,
    auto_fixable: z.boolean(),
    requires_human_review: z.boolean(),
    /** Present exactly when status is wont_fix; the annotation the score exclusion must show. */
    wont_fix: z
      .object({
        reason: z.string(),
        /**
         * When the finding is due back for review: wont_fix_at plus 180 days (aux-and-geo-analysis.md §3).
         * null = the finding was set will-not-fix before wont_fix_at was recorded, so no date is known.
         */
        resurfaces_at: z.string().nullable().optional(),
      })
      .strict()
      .nullable(),
    first_detected_at: z.string(),
    last_detected_at: z.string(),
    resolved_at: z.string().nullable(),
    regressed_at: z.string().nullable(),
    occurrence_count: z.number().int(),
    rule_version: z.string(),
    /** The task a promotion created, if any. */
    task_id: z.string().uuid().nullable(),
    /**
     * STORY-053 — the latest copy-ready patch the audit made for this finding. null = none yet (nothing to offer, the rule has no
     * patch, or the patch was refused by a gate). Earlier ones are `patch.earlier_patch_ids`. Always sent by the server; OPTIONAL in the
     * contract only so that adding it is an additive change (NFR-API-04), as `wont_fix.resurfaces_at` was.
     */
    patch: auxPatchSchema.nullable().optional(),
    /** STORY-053 — structured guidance and an alignment link, for a rule whose fix needs a human. null where the rule has a patch. */
    guidance: auxGuidanceSchema.nullable().optional(),
  })
  .strict();

export type AuxFinding = z.infer<typeof auxFindingSchema>;

export const auxFindingListQuerySchema = z
  .object({
    cursor: z.string().min(1).optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .overwrite((value) => Math.min(value, PAGINATION_LIMIT_MAX))
      .max(PAGINATION_LIMIT_MAX)
      .default(PAGINATION_LIMIT_DEFAULT),
    severity: auxFindingSeveritySchema.optional(),
    status: auxFindingStatusSchema.optional(),
    rule_code: z.string().min(1).max(32).optional(),
    /** Exact match on the finding's URL. */
    url: z.string().min(1).max(2048).optional(),
  })
  .strict();

export type AuxFindingListQuery = z.infer<typeof auxFindingListQuerySchema>;

export const updateAuxFindingRequestSchema = z
  .object({
    /** `open` is accepted from `acknowledged` only; `resolved` is accepted here only to be refused with a 422. */
    status: z.enum(["acknowledged", "open", "wont_fix", "resolved"]),
    reason: z.string().trim().min(1).max(AUX_WONT_FIX_REASON_MAX).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === "wont_fix" && value.reason === undefined) {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "marking a finding will-not-fix requires a reason" });
    }
    if (value.reason !== undefined && value.status !== "wont_fix") {
      ctx.addIssue({ code: "custom", path: ["reason"], message: "reason is only valid with status=wont_fix" });
    }
  });

export type UpdateAuxFindingRequest = z.infer<typeof updateAuxFindingRequestSchema>;

// The :id of every /aux-findings/{id}/... route. Validated at the boundary so a non-UUID is a 400, not a uuid-cast 500 deeper in.
export const auxFindingParamsSchema = z.object({ id: lowercaseUuidSchema }).strict();

export type AuxFindingParams = z.infer<typeof auxFindingParamsSchema>;
