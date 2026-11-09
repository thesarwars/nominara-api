import { describe, expect, it } from "vitest";
import { minimiseText, minimiseExcerpt, minimiseWindow, PLACEHOLDERS } from "./minimise.js";

// STORY-111 AC "minimisation pass" / NFR-CMP-01. Test scenario 8.
describe("STORY-111 minimiseText (scenario 8)", () => {
  it("S8 replaces an email address with a typed placeholder", () => {
    const out = minimiseText("Write to jane.doe+x@Example.co.uk for a quote.");
    expect(out.text).toBe(`Write to ${PLACEHOLDERS.email} for a quote.`);
    expect(out.replaced).toEqual({ email: 1, phone: 0, street_address: 0 });
  });

  it("S8 replaces phone numbers in common formats and leaves ordinary numbers and dates alone", () => {
    const out = minimiseText("Call +44 20 7946 0958 or (415) 555-2671 or 415-555-2671. Revenue grew 1234567890 units; shipped 2024-01-15; 42% up.");
    expect(out.text).toBe(`Call ${PLACEHOLDERS.phone} or ${PLACEHOLDERS.phone} or ${PLACEHOLDERS.phone}. Revenue grew 1234567890 units; shipped 2024-01-15; 42% up.`);
    expect(out.replaced.phone).toBe(3);
  });

  it("S8 replaces a street address", () => {
    const out = minimiseText("Visit us at 221B Baker Street, or 10 Downing St. today.");
    expect(out.text).not.toMatch(/Baker|Downing/);
    expect(out.replaced.street_address).toBe(2);
  });

  it("S8 preserves personal names, which are frequently brand or product names", () => {
    const text = "Tim Cook, Ada Lovelace and Jordan Peterson appear; Ben & Jerry's and Michael Kors are brands.";
    expect(minimiseText(text).text).toBe(text);
  });

  it("S8 is idempotent and returns the same string when nothing matches", () => {
    const once = minimiseText("mail a@b.io now").text;
    expect(minimiseText(once).text).toBe(once);
    expect(minimiseText("").text).toBe("");
    expect(minimiseText("nothing to see").replaced).toEqual({ email: 0, phone: 0, street_address: 0 });
  });

  it("S8 minimises BEFORE truncating, so a cut never leaves half an address behind", () => {
    const text = `${"x".repeat(270)} bob@example.com tail`;
    const excerpt = minimiseExcerpt(text, 280);
    expect(excerpt).not.toMatch(/bob|example\.com|@/);
    expect(excerpt.length).toBeLessThanOrEqual(280);
  });

  it("S8 does not match an email-looking token embedded in a URL path segment without an @", () => {
    expect(minimiseText("see https://example.com/a.b/c").text).toBe("see https://example.com/a.b/c");
  });

  it("S8 the evidence window never surfaces half an identifier the window cuts through", () => {
    const text = "Contact bob@example.com today.";
    // The window ends in the middle of the address.
    expect(minimiseWindow(text, 0, 16)).toBe(`Contact ${PLACEHOLDERS.email}`);
    // The window starts in the middle of the address.
    expect(minimiseWindow(text, 12, text.length)).toBe(`${PLACEHOLDERS.email} today.`);
    expect(minimiseWindow(text, 0, 7)).toBe("Contact");
    expect(minimiseWindow("a@b.io", 0, 6)).toBe(PLACEHOLDERS.email);
  });
});
