import { z } from "zod";

// STORY-049 AC6 / AC12 — what a crawl.audit run RECORDS about the pages it fetched, in the two places it records it.
//
//   aux_audits.error_summary (jsonb)   what went wrong, and what was not attempted, in a form a query can read
//   {dom_object_prefix}manifest.json   an object-storage file naming every stored copy of every page, with hashes
//
// NO SEPARATE PAGES TABLE. Per-page outcomes could live in a new tenant table; that is a schema decision nobody has made
// (it needs a migration pair, an isolation entry and RLS), and the documented `aux_audits` columns already hold what an
// audit needs: `target_urls` the pages attempted, `error_summary` the failures, and the manifest the storage keys.
// STORY-050 (document extraction) reads the manifest; if it wants a table, that is its story to raise.
//
// Every value here is already sanitised text: a short reason CODE, never an engine's or a socket's error message, never a
// resolved address (a refusal names the CHECK that refused it, STORY-131).

export const CRAWL_PAGE_STAGES = ["raw", "rendered", "store"] as const;
export const crawlPageStageSchema = z.enum(CRAWL_PAGE_STAGES);

export const crawlPageFailureSchema = z
  .object({
    stage: crawlPageStageSchema,
    reason: z.string().min(1).max(200),
    /** null = no HTTP response. A real status is never coerced to 0. */
    http_status: z.number().int().nullable(),
  })
  .strict();

export const crawlSkippedPageSchema = z.object({ url: z.string().max(2048), reason: z.string().min(1).max(200) }).strict();

export const auxErrorSummarySchema = z
  .object({
    /** The audit-level cause, when the whole audit failed. */
    reason: z.string().min(1).max(200).optional(),
    /** Which of the site files had no HTTP answer (our fetch failed). */
    site_files_failed: z.array(z.string().max(200)).optional(),
    failed_pages: z.array(z.object({ url: z.string().max(2048), failures: z.array(crawlPageFailureSchema) }).strict()).optional(),
    /** Not fetched, and why: robots.txt disallowed it, robots.txt could not be read, or the hard cap was reached. */
    skipped_pages: z.array(crawlSkippedPageSchema).optional(),
    /** Valid pages the scope selected that did not fit under the page cap. 0 is "none cut", absent is "not measured". */
    pages_over_cap: z.number().int().min(0).optional(),
    stopped_at_cap: z.boolean().optional(),
    /** Written only as `false`: the manifest could not be stored, so the audit cannot be reproduced from storage. */
    manifest_stored: z.literal(false).optional(),
  })
  .strict();
export type AuxErrorSummary = z.infer<typeof auxErrorSummarySchema>;

const storedCopySchema = z
  .object({
    object_key: z.string().min(1),
    /** Of the UNCOMPRESSED content. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().min(0),
    status: z.number().int().nullable(),
    truncated: z.boolean(),
  })
  .strict();

export const crawlProbeResultSchema = z
  .object({
    outcome: z.enum(["consistent", "hostile", "inconclusive", "skipped_budget"]),
    browserStatus: z.number().int().nullable(),
    agentStatus: z.number().int().nullable(),
  })
  .strict();

export const crawlManifestSchema = z
  .object({
    version: z.literal(1),
    audit_id: z.string().uuid(),
    scope: z.enum(["domain_root", "key_pages", "single_url", "sitemap_sample", "public_surface"]),
    root_url: z.string(),
    pages: z.array(
      z
        .object({
          url: z.string().max(2048),
          outcome: z.enum(["ok", "partial", "failed", "skipped"]),
          raw: storedCopySchema.optional(),
          rendered: storedCopySchema.optional(),
          failures: z.array(crawlPageFailureSchema),
          skipped_reason: z.string().optional(),
        })
        .strict(),
    ),
    pages_over_cap: z.number().int().min(0),
    stopped_at_cap: z.boolean(),
    selection_skipped: z.array(crawlSkippedPageSchema),
    sitemap: z
      .object({
        files_fetched: z.number().int().min(0),
        total_seen: z.number().int().min(0),
        sampled: z.boolean(),
        problems: z.array(z.object({ url: z.string().max(2048), reason: z.string() }).strict()),
      })
      .strict()
      .nullable(),
    /** null = the probe did not run (an unverified domain, or no budget). Never "consistent" by default. */
    probe: crawlProbeResultSchema.nullable(),
  })
  .strict();
export type CrawlManifest = z.infer<typeof crawlManifestSchema>;
