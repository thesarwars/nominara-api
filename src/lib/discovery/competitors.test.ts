import { describe, expect, it } from "vitest";
import { MAX_PROPOSED_COMPETITORS, proposeCompetitors } from "./competitors.js";

// STORY-043 AC11 — competitors proposed, each with a basis. Only the BASIS this build can observe from the root document is
// produced: the site's own comparison/alternatives links. Category peers (no taxonomy) and first-capture co-occurrence (no capture
// exists at discovery time) are not faked.

const BRANDS = ["HubSpot"];
const link = (text: string, href = "/compare/x") => ({ href, text });

describe("STORY-043 · proposeCompetitors", () => {
  it("takes the other side of 'Brand vs Other', with a basis", () => {
    const out = proposeCompetitors({ brandNames: BRANDS, links: [link("HubSpot vs Salesforce")] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: "Salesforce", basis: "own comparison page" });
    expect(out[0]!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("works when the brand is on the right of the vs", () => {
    expect(proposeCompetitors({ brandNames: BRANDS, links: [link("Pipedrive versus HubSpot")] })[0]?.name).toBe("Pipedrive");
  });

  it("a comparison that does not involve the brand proposes nothing", () => {
    expect(proposeCompetitors({ brandNames: BRANDS, links: [link("Salesforce vs Pipedrive")] })).toEqual([]);
  });

  it("'X alternatives' names X, at a lower confidence than an explicit vs", () => {
    const [vs] = proposeCompetitors({ brandNames: BRANDS, links: [link("HubSpot vs Zoho")] });
    const [alt] = proposeCompetitors({ brandNames: BRANDS, links: [link("Pipedrive alternatives")] });
    expect(alt?.name).toBe("Pipedrive");
    expect(alt!.confidence).toBeLessThan(vs!.confidence);
  });

  it("'HubSpot alternatives' is about the brand itself and names no competitor", () => {
    expect(proposeCompetitors({ brandNames: BRANDS, links: [link("HubSpot alternatives")] })).toEqual([]);
    expect(proposeCompetitors({ brandNames: BRANDS, links: [link("Best HubSpot alternative")] })).toEqual([]);
  });

  it("generic link text names nobody — the slug is NOT used to invent a name", () => {
    const out = proposeCompetitors({ brandNames: BRANDS, links: [link("Compare", "/compare/hubspot-vs-salesforce"), link("")] });
    expect(out).toEqual([]);
  });

  it("de-duplicates case-insensitively, keeping the higher confidence", () => {
    const out = proposeCompetitors({
      brandNames: BRANDS,
      links: [link("Zoho alternatives"), link("HubSpot vs ZOHO")],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("refuses placeholder words as names", () => {
    expect(proposeCompetitors({ brandNames: BRANDS, links: [link("HubSpot vs competitors"), link("HubSpot vs Others")] })).toEqual([]);
  });

  it("caps the list at 5 (product-spec §2.1 'up to 5')", () => {
    const links = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map((n) => link(`HubSpot vs ${n}`));
    expect(MAX_PROPOSED_COMPETITORS).toBe(5);
    expect(proposeCompetitors({ brandNames: BRANDS, links })).toHaveLength(5);
  });

  it("never proposes a name that is the brand or an alias of it", () => {
    expect(proposeCompetitors({ brandNames: ["HubSpot", "HubSpot CRM"], links: [link("HubSpot vs HubSpot CRM")] })).toEqual([]);
  });

  it("empty input yields an empty list", () => {
    expect(proposeCompetitors({ brandNames: [], links: [] })).toEqual([]);
  });

  // Review round 1 (minor): the brand test compares WHOLE names/tokens, not substrings.
  it("a rival whose name merely CONTAINS the domain stem is still proposed (force.com vs Salesforce)", () => {
    const out = proposeCompetitors({ brandNames: ["force", "Force"], links: [link("Force vs Salesforce")] });
    expect(out.map((c) => c.name)).toEqual(["Salesforce"]);
  });

  it("the stored URL-only placeholder name ('hubspot.com') is the brand 'hubspot', not a bag of substrings", () => {
    const brands = ["hubspot.com"];
    expect(proposeCompetitors({ brandNames: brands, links: [link("Spot vs HubSpot"), link("Hub vs HubSpot")] }).map((c) => c.name)).toEqual(["Spot", "Hub"]);
    // ... and it still recognises the brand itself, with or without a descriptor.
    expect(proposeCompetitors({ brandNames: brands, links: [link("HubSpot vs Zoho"), link("HubSpot CRM vs Pipedrive")] }).map((c) => c.name)).toEqual(["Zoho", "Pipedrive"]);
  });
});
