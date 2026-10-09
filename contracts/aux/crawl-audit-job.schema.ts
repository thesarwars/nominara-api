import { z } from "zod";

// NEW-C-9 (STORY-049 site-file stage + STORY-052 lifecycle) — the payload of a
// `crawl.audit` job. Not an HTTP request body (the producer, STORY-049's
// POST /projects/{id}/aux-audits, is a separate story), but `.strict()` all the
// same so an unexpected key fails at the queue boundary, not three frames in.
//
// `trigger` is limited to the two free triggers this stage serves: 'onboarding'
// and 'scheduled'. 'manual' and 'post_fix' are credited or user-initiated and
// belong to the endpoint story.
//
// `auditId` is minted by the producer (idempotency key `aux:{project}:{audit}`)
// so a redelivered job addresses the same row.

export const CRAWL_AUDIT_TRIGGERS = ["onboarding", "scheduled"] as const;
export const crawlAuditTriggerSchema = z.enum(CRAWL_AUDIT_TRIGGERS);

export const crawlAuditJobPayloadSchema = z
  .object({
    projectId: z.string().uuid(),
    auditId: z.string().uuid(),
    trigger: crawlAuditTriggerSchema,
    // Added by the producer for every tenant-scoped queue.
    workspaceId: z.string().uuid(),
    kid: z.string(),
  })
  .strict();

export type CrawlAuditJobPayload = z.infer<typeof crawlAuditJobPayloadSchema>;
