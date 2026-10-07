import { z } from "zod";

// NEW-C-8 (STORY-051 subset) — what a site-file evaluator returns, and the
// shape of `aux_findings.evidence` for the crawler_access rules it covers
// (aux-and-geo-analysis.md §2, AUX-R-001/002/003/004/007).
//
// Not a request schema — nothing accepts this over HTTP — but it is `.strict()`
// all the same so a stray key in a stored finding fails parse rather than
// being carried silently.
//
// `measured_value` / `threshold_value` are `null` when nothing was measured
// (a file that could not be fetched has no byte count); `0` means measured
// zero. The two are never conflated.

export const SITE_FILE_RULE_CODES = ["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-007"] as const;
export const siteFileRuleCodeSchema = z.enum(SITE_FILE_RULE_CODES);

export const auxFindingSeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);

export const SITE_FILE_NAMES = ["robots.txt", "llms.txt", "sitemap.xml"] as const;

/** Evidence is bounded: a snippet is at most 200 chars, never a whole file. */
export const SITE_FILE_EVIDENCE_SNIPPET_MAX = 200;

export const siteFileEvidenceSchema = z
  .object({
    file: z.enum(SITE_FILE_NAMES),
    /** Machine-readable cause, e.g. `root_disallow`, `http_status`, `stale_lastmod`. */
    reason: z.string().min(1).max(64),
    /** The matching line / element, truncated. `null` when there is no line to quote. */
    snippet: z.string().max(SITE_FILE_EVIDENCE_SNIPPET_MAX).nullable(),
    /** 1-based line number in the file, when the evidence is a line. */
    line: z.number().int().positive().nullable(),
    /** Agents / URLs / paths involved, bounded. */
    subjects: z.array(z.string().max(200)).max(50),
  })
  .strict();

export const siteFileFindingSchema = z
  .object({
    rule_code: siteFileRuleCodeSchema,
    severity: auxFindingSeveritySchema,
    measured_value: z.number().nullable(),
    threshold_value: z.number().nullable(),
    evidence: siteFileEvidenceSchema,
  })
  .strict();

export type SiteFileFinding = z.infer<typeof siteFileFindingSchema>;
export type SiteFileEvidence = z.infer<typeof siteFileEvidenceSchema>;
