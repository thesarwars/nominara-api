import { z } from "zod";

// NEW-C-9 (STORY-049 site-file stage + STORY-052 lifecycle) — the payload of a
// `crawl.audit` job. Not an HTTP request body (the producer, STORY-049's
// POST /projects/{id}/aux-audits, is a separate story), but `.strict()` all the
// same so an unexpected key fails at the queue boundary, not three frames in.
//
// `trigger` is 'onboarding' and 'scheduled' (free) and 'manual' (the priced
// `POST /projects/{id}/aux-audits`, STORY-194: the producer has already debited
// it, and a failed audit refunds it). 'post_fix' is not produced yet.
//
// `auditId` is minted by the producer (idempotency key `aux:{project}:{audit}`)
// so a redelivered job addresses the same row.

export const CRAWL_AUDIT_TRIGGERS = ["onboarding", "scheduled", "manual"] as const;
export const crawlAuditTriggerSchema = z.enum(CRAWL_AUDIT_TRIGGERS);

/**
 * The page-selection scope a PRODUCER may ask for (aux-and-geo-analysis.md §1 step 3). `public_surface` and
 * `domain_root` are deliberately not here: which of them applies is decided by the project's verification state inside
 * the handler (AUTHORIZE, step 1), so no payload can ask for more than the domain's verification allows.
 */
export const CRAWL_AUDIT_REQUESTED_SCOPES = ["key_pages", "single_url", "sitemap_sample"] as const;
export const crawlAuditRequestedScopeSchema = z.enum(CRAWL_AUDIT_REQUESTED_SCOPES);

export const crawlAuditJobPayloadSchema = z
  .object({
    projectId: z.string().uuid(),
    auditId: z.string().uuid(),
    trigger: crawlAuditTriggerSchema,
    /** Absent = `key_pages`. An unverified domain is held to public_surface whatever this says. */
    scope: crawlAuditRequestedScopeSchema.optional(),
    /** Required, with exactly one entry, for `single_url`. Each is re-guarded when fetched. */
    targetUrls: z
      .array(
        z
          .string()
          .max(2048)
          .url()
          .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL"),
      )
      .max(50)
      .optional(),
    // Added by the producer for every tenant-scoped queue.
    workspaceId: z.string().uuid(),
    kid: z.string(),
  })
  .strict()
  .refine((p) => p.scope !== "single_url" || p.targetUrls?.length === 1, {
    message: "single_url needs exactly one target URL",
    path: ["targetUrls"],
  });

export type CrawlAuditJobPayload = z.infer<typeof crawlAuditJobPayloadSchema>;
