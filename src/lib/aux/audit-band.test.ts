import { describe, expect, it } from "vitest";
import { auxAuditEstimate } from "./audit-band.js";

// STORY-082 AC (full audit pricing, estimate) - the page band and the figure it prices, from the one price function the in-project audit uses.

describe("STORY-082 - the full audit's estimate", () => {
  it("scenario 5 - priced per page band: up to 25 pages is the flat 10, and site files are included, not billed apart", () => {
    for (const pages of [1, 10, 25]) {
      const e = auxAuditEstimate(pages, 100);
      expect(e.credits).toBe(10);
      expect(e.band).toEqual({ label: "up to 25 pages", first_band_pages: 25, beyond_first_band: false, extra_pages: 0 });
      expect(e.site_files_included).toBe(true);
      expect(e.credits_charged).toBe(0);
    }
  });

  it("scenario 6 - every patch is included at no additional charge, and the price does not depend on verification", () => {
    const e = auxAuditEstimate(5, 25);
    expect(e.patches_free).toBe(true);
    expect(e.price_depends_on_verification).toBe(false);
  });

  it("scenario 7 - changing the requested page count recomputes the band and the figure", () => {
    const small = auxAuditEstimate(25, 100);
    const large = auxAuditEstimate(40, 100);
    expect(large.band.beyond_first_band).toBe(true);
    expect(large.band.extra_pages).toBe(15);
    expect(large.band.label).toContain("40");
    expect(large.credits).toBe(25);
    expect(large.credits).toBeGreaterThan(small.credits);
    expect(auxAuditEstimate(26, 100).credits).toBe(11);
  });

  it("boundary - a request above the plan's page cap is refused, never quietly priced", () => {
    expect(() => auxAuditEstimate(26, 25)).toThrow(RangeError);
    expect(() => auxAuditEstimate(0, 25)).toThrow(RangeError);
    expect(() => auxAuditEstimate(1.5, 25)).toThrow(RangeError);
  });
});
