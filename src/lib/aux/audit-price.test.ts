import { describe, expect, it } from "vitest";
import { AUX_AUDIT_BASE_CREDITS, AUX_AUDIT_BASE_PAGES, AUX_AUDIT_EXTRA_PAGE_CREDITS, auxAuditPrice, auxAuditPricing } from "./audit-price.js";

// product-spec.md FR-TL-03: "AUX Audit - free (site files) - 10 for <= 25 pages, +1/page".

describe("AUXLIVE-3 · the manual AUX audit price (FR-TL-03)", () => {
  it("the constants are the reference's: 10 credits for the first band of 25 pages, +1 per page after", () => {
    expect([AUX_AUDIT_BASE_CREDITS, AUX_AUDIT_BASE_PAGES, AUX_AUDIT_EXTRA_PAGE_CREDITS]).toEqual([10, 25, 1]);
  });

  it("one page and a full first band cost the same flat 10", () => {
    expect(auxAuditPrice(1)).toBe(10);
    expect(auxAuditPrice(24)).toBe(10);
    expect(auxAuditPrice(25)).toBe(10);
  });

  it("the 26th page is the first one that costs extra: +1 per page beyond the band", () => {
    expect(auxAuditPrice(26)).toBe(11);
    expect(auxAuditPrice(50)).toBe(35);
    expect(auxAuditPrice(100)).toBe(85);
  });

  it("a page count that is not a positive whole number is refused, never priced as 0", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => auxAuditPrice(bad), String(bad)).toThrow();
  });

  it("the pricing breakdown a response shows reproduces the price", () => {
    const p = auxAuditPricing(40);
    expect(p).toEqual({ pages_priced: 40, base_credits: 10, base_page_band: 25, extra_page_credits: 1 });
    expect(p.base_credits + Math.max(0, p.pages_priced - p.base_page_band) * p.extra_page_credits).toBe(auxAuditPrice(40));
  });
});
