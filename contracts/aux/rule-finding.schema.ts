import { z } from "zod";
import { auxGuidanceSchema } from "./patch.schema.js";
import { auxFindingSeveritySchema } from "./site-file-finding.schema.js";

// STORY-051 — what a document-model rule returns, and the shape of `aux_findings.evidence` for the page rules
// (aux-and-geo-analysis.md section 2). The site-file rules keep their own shape (site-file-finding.schema.ts).
//
// Not a request schema: nothing accepts this over HTTP. It is `.strict()` all the same so a stray key in a stored finding fails
// parse instead of being carried silently.
//
// `measured_value` and `threshold_value` are `null` when nothing was measured (a timing the fetcher did not record); `0` means
// measured zero. The two are never conflated.

/** Evidence is bounded: a snippet is at most 200 characters, never a whole page. */
export const RULE_EVIDENCE_SNIPPET_MAX = 200;

export const auxRuleCodeSchema = z.string().regex(/^AUX-R-\d{3}$/);

export const auxRuleEvidenceSchema = z
  .object({
    /** Machine-readable cause, e.g. `section_tokens`, `jsonld_parse_error`. */
    reason: z.string().min(1).max(64),
    /** The text or markup that shows the problem, truncated. `null` when there is nothing to quote. */
    snippet: z.string().max(RULE_EVIDENCE_SNIPPET_MAX).nullable(),
    /** Where in the document model the problem sits, e.g. `blocks[3]`, `jsonld[0].offers.price`. */
    locator: z.string().min(1).max(200),
  })
  .strict();

export const auxRuleFindingSchema = z
  .object({
    rule_code: auxRuleCodeSchema,
    /** The catalog's `rule_version` the thresholds came from (NFR-AUX-02). */
    rule_version: z.string().min(1),
    severity: auxFindingSeveritySchema,
    measured_value: z.number().nullable(),
    threshold_value: z.number().nullable(),
    /** The audited page. */
    url: z.string().min(1),
    evidence: auxRuleEvidenceSchema,
    auto_fixable: z.boolean(),
    /** Present exactly when the rule is not auto-fixable: structured guidance and the alignment link, never an empty patch. */
    guidance: auxGuidanceSchema.nullable(),
  })
  .strict();

export type AuxRuleEvidence = z.infer<typeof auxRuleEvidenceSchema>;
export type AuxRuleFinding = z.infer<typeof auxRuleFindingSchema>;
