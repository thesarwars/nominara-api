import { z } from "zod";
import { AUX_AUDIT_STATUSES } from "./aux-audit.schema.js";
import { CRAWL_AUDIT_REQUESTED_SCOPES } from "./crawl-audit-job.schema.js";

// STORY-194 / owner decision 34 (item 3) - `POST /projects/{id}/aux-audits`, the manual re-audit (api-specification.md "AUX":
// `{scope, target_urls}`, `aux:trigger`, `Idempotency-Key`, `¢`). Scheduled, onboarding and post-fix audits are 0 credits and are not made here.
//
// PRICE (product-spec.md FR-TL-03: "free (site files) - 10 for <= 25 pages, +1/page"; plans-and-entitlements.md "AUX Audit - full": flat for the
// first page band, then per page). The site-files check is free and is not this route. The price is the plan's page cap, never the pages that
// turned out reachable: "domain verification controls scope, not price", so an unverified domain (one page, public surface) pays the same.
//
// `scope` is what the caller may ASK for. `public_surface` and `domain_root` are not here: verification decides them inside `crawl.audit`, so no
// request can ask for more than the domain's owner proved they own (STORY-048 AC6).

export const triggerAuxAuditRequestSchema = z
  .object({
    /** Absent = `key_pages`. An unverified domain is held to public-surface scope whatever this says. */
    scope: z.enum(CRAWL_AUDIT_REQUESTED_SCOPES).optional(),
    /** Exactly one URL for `single_url`; otherwise optional hints. Each is re-guarded (SSRF, same registrable domain) when fetched. */
    target_urls: z
      .array(
        z
          .string()
          .max(2048)
          .url()
          .refine((u) => /^https?:\/\//i.test(u), "must be an http(s) URL"),
      )
      .max(50)
      .optional(),
  })
  .strict()
  .refine((b) => b.scope !== "single_url" || b.target_urls?.length === 1, {
    message: "single_url needs exactly one target URL",
    path: ["target_urls"],
  });
export type TriggerAuxAuditRequest = z.infer<typeof triggerAuxAuditRequestSchema>;

/** How the credit figure was reached, so a client can show it without holding the schedule. */
export const auxAuditPricingSchema = z
  .object({
    /** Pages the price was computed for: the plan's page cap, or 1 for `single_url`. */
    pages_priced: z.number().int().min(1),
    /** The flat price of the first page band. */
    base_credits: z.number().int().min(0),
    /** The size of the first band, in pages. */
    base_page_band: z.number().int().min(1),
    /** Credits per page beyond the first band. */
    extra_page_credits: z.number().int().min(0),
  })
  .strict();

export const triggerAuxAuditResponseSchema = z
  .object({
    audit_id: z.string().uuid(),
    /** The audit's REAL status: `queued` on the first answer; a replay reports where the audit has got to (`completed`, `partial`, `failed`). Read at `GET /aux-audits/{id}`. */
    status: z.enum(AUX_AUDIT_STATUSES),
    trigger: z.literal("manual"),
    /** The scope that was asked for (`key_pages` by default). The scope that APPLIES is on the audit once it runs. */
    requested_scope: z.enum(CRAWL_AUDIT_REQUESTED_SCOPES),
    /** What this request debited, 0 never (a manual audit is the one priced trigger). Refunded in full if the audit fails outright. */
    credits_charged: z.number().int().min(1),
    /** Credits returned since (a failed audit is refunded in full). 0 on the first answer. The net cost is `credits_charged - credits_refunded`. */
    credits_refunded: z.number().int().min(0),
    pricing: auxAuditPricingSchema,
  })
  .strict();
export type TriggerAuxAuditResponse = z.infer<typeof triggerAuxAuditResponseSchema>;

/**
 * `POST /projects/{id}/aux-audits/preview` (owner decision 39; api-specification.md section 7) - the QUOTE half of the priced-action flow. Same
 * body as the trigger. Free and read-only: nothing is reserved, debited, written or queued. `credits` is the figure the client echoes in
 * `X-Nominara-Confirmed-Credits`; the trigger charges only when it matches the price recomputed at that moment.
 */
export const triggerAuxAuditPreviewResponseSchema = z
  .object({
    /** What the audit would debit now, in whole credits. */
    credits: z.number().int().min(1),
    requested_scope: z.enum(CRAWL_AUDIT_REQUESTED_SCOPES),
    pricing: auxAuditPricingSchema,
    /** A LITERAL ZERO: a preview debits nothing and reserves nothing. */
    credits_charged: z.literal(0),
  })
  .strict();
export type TriggerAuxAuditPreviewResponse = z.infer<typeof triggerAuxAuditPreviewResponseSchema>;
