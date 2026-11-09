import type { AuxAuditToolEstimate } from "../../../contracts/tools/index.js";
import { AUX_AUDIT_BASE_PAGES, auxAuditPrice, auxAuditPricing } from "./audit-price.js";

// STORY-082 - the full audit tool's free quote. The figure is auxAuditPrice (FR-TL-03: 10 credits up to 25 pages, +1 per page after), the same function the
// in-project manual audit prices with; this adds the band's name and the statements the story requires beside it. VERIFICATION IS NOT AN INPUT: scope, not price.

export function auxAuditEstimate(pages: number, pageCap: number): AuxAuditToolEstimate {
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError(`an audit prices a positive whole number of pages, got ${String(pages)}`);
  if (pages > pageCap) throw new RangeError(`the plan audits at most ${String(pageCap)} pages per audit, got ${String(pages)}`);
  const extra = Math.max(0, pages - AUX_AUDIT_BASE_PAGES);
  return {
    mode: "full",
    pages,
    page_cap: pageCap,
    credits: auxAuditPrice(pages),
    band: {
      label: extra === 0 ? `up to ${String(AUX_AUDIT_BASE_PAGES)} pages` : `${String(pages)} pages (${String(AUX_AUDIT_BASE_PAGES)} included, +1 credit per extra page)`,
      first_band_pages: AUX_AUDIT_BASE_PAGES,
      beyond_first_band: extra > 0,
      extra_pages: extra,
    },
    pricing: auxAuditPricing(pages),
    site_files_included: true,
    patches_free: true,
    price_depends_on_verification: false,
    credits_charged: 0,
  };
}
