// product-spec.md FR-TL-03 / plans-and-entitlements.md "AUX Audit - full": "free (site files) - 10 for <= 25 pages, +1/page".
// The site-files check is free and is not priced here. Scheduled, onboarding and post-fix audits are 0 credits and never call this.
//
// Credits are whole numbers (a debit is a positive integer); the figures are the reference's, in one place.

/** The flat price of the first page band. */
export const AUX_AUDIT_BASE_CREDITS = 10;
/** The size of the first page band, in pages. */
export const AUX_AUDIT_BASE_PAGES = 25;
/** Credits for each page beyond the first band. */
export const AUX_AUDIT_EXTRA_PAGE_CREDITS = 1;

function assertPages(pages: number): void {
  if (!Number.isInteger(pages) || pages < 1) throw new Error(`an audit prices a positive whole number of pages, got ${String(pages)}`);
}

export function auxAuditPrice(pages: number): number {
  assertPages(pages);
  return AUX_AUDIT_BASE_CREDITS + Math.max(0, pages - AUX_AUDIT_BASE_PAGES) * AUX_AUDIT_EXTRA_PAGE_CREDITS;
}

/** What a response shows beside the figure, so a client never holds the schedule. */
export function auxAuditPricing(pages: number): { pages_priced: number; base_credits: number; base_page_band: number; extra_page_credits: number } {
  assertPages(pages);
  return { pages_priced: pages, base_credits: AUX_AUDIT_BASE_CREDITS, base_page_band: AUX_AUDIT_BASE_PAGES, extra_page_credits: AUX_AUDIT_EXTRA_PAGE_CREDITS };
}
