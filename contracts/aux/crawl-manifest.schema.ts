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
    /** Pages with ONE stored copy and a recorded failure for the other (e.g. raw stored, no renderer). Not counted in `aux_audits.pages_failed`. */
    pages_partial: z.number().int().min(0).optional(),
    /**
     * The target's declared Crawl-delay or the job's wall-clock budget limited what was fetched. `crawl_delay_ms` is the
     * interval HONOURED; `declared_crawl_delay_ms` is present only when the declared delay was longer than the cap and was
     * shortened to it (NOT FROM THE REFERENCE: MAX_HONOURED_CRAWL_DELAY_MS, so a hostile robots.txt cannot cost the audit its
     * site files). `pages_skipped` counts pages only; a site file the budget did not allow is in `skipped_pages`.
     */
    crawl_delay_limited: z
      .object({
        crawl_delay_ms: z.number().int().min(0),
        declared_crawl_delay_ms: z.number().int().min(0).optional(),
        pages_skipped: z.number().int().min(0),
      })
      .strict()
      .optional(),
    /**
     * STORY-051 AC13: the rules that ran on an INTERIM reading (`AUX_RULES_PARTIAL`), so the audit does not read as having fully checked them.
     * Only rules that ran on at least one page are listed; a rule that did not run is in `aux_audits.excluded_rules` instead. Absent = none.
     */
    rules_partial: z.array(z.string().regex(/^AUX-R-\d{3}$/)).optional(),
    /**
     * The URLs the page rules MODELLED in this audit (an upper bound of 500 for the plan's page cap). `crawl.audit` reads it from the audits before
     * the current one to tell whether a page finding was LOOKED AT then: a page that failed, was skipped or was no longer selected was not, and a finding
     * on it must go stale (STORY-052 AC8), which the audit-level `excluded_rules` cannot say for a rule that ran on the other pages. Absent on an audit
     * that modelled no page.
     */
    pages_modelled: z.array(z.string().max(2048)).max(500).optional(),
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

/**
 * STORY-050 AC7 / AC8 / AC10 — what the plain fetch of a page answered, beside the stored bytes, so the document model can be
 * rebuilt from storage alone: where the chain ended, every redirect hop, the status, and the response headers the model reads
 * (an allow-list: `x-robots-tag`, `content-type`; never cookies or anything a server could use to plant data). Timing is whole
 * milliseconds measured by the guarded fetch; null = not measured, which is not 0. Optional: a manifest written before this
 * field existed has none, and its pages cannot be rebuilt into a model.
 */
export const crawlPageFetchSchema = z
  .object({
    final_url: z.string().max(2048),
    redirect_chain: z.array(z.string().max(2048)).max(20),
    http_status: z.number().int(),
    headers: z.record(z.string(), z.string().max(2000)),
    ttfb_ms: z.number().int().min(0).nullable(),
    load_ms: z.number().int().min(0).nullable(),
  })
  .strict();
export type CrawlPageFetch = z.infer<typeof crawlPageFetchSchema>;

/**
 * What robots.txt says about ONE AI crawler token for the crawl's root path (STORY-049 AC8, owner decision 2026-10-22).
 * Nominara sends no request under any other crawler's name, so a firewall or CDN rule that blocks by user agent cannot be
 * observed here: AUX-R-005 stays unevaluated and is named in `excluded_rules`. Only what the site PUBLISHED is judged.
 */
export const crawlAiBotAccessSchema = z.object({ agent: z.string().min(1).max(100), allowed: z.boolean() }).strict();

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
          fetch: crawlPageFetchSchema.optional(),
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
    /** null = robots.txt could not be judged (unreachable or unreadable). Never "allowed" by default. */
    ai_bot_access: z.array(crawlAiBotAccessSchema).nullable(),
  })
  .strict();
export type CrawlManifest = z.infer<typeof crawlManifestSchema>;
