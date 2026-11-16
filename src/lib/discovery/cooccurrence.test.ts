import { describe, expect, it, vi } from "vitest";
import {
  COOCCURRENCE_BASIS,
  MIN_COOCCURRING_RESULTS,
  loadCooccurringEntities,
  mergeCooccurringEntities,
} from "./cooccurrence.js";
import type { ProposedCompetitor } from "../../../contracts/projects/index.js";

// STORY-043 AC11 - the third competitor basis: entities co-occurring with the brand in the project's FIRST capture run, read from the parsed
// `mention_facts` (entity_type 'other': detected but not tracked). No model call. It fills only the places the first two bases left empty.

const own = (name: string, basis = "own comparison page"): ProposedCompetitor => ({ name, confidence: 0.8, basis });
const entity = (label: string, results: number, brandResults = 10) => ({ label, results, brandResults });

describe("STORY-043 AC11 · mergeCooccurringEntities", () => {
  it("AC11 proposes a co-occurring entity with the co-occurrence basis and its share of the brand's answers as confidence", () => {
    const out = mergeCooccurringEntities({ own: [], entities: [entity("Salesforce", 8)], ownBrandNames: ["HubSpot"] });
    expect(out).toEqual([{ name: "Salesforce", confidence: 0.8, basis: COOCCURRENCE_BASIS }]);
  });

  it("AC11 comes AFTER the site's own links and category peers, never ahead of them", () => {
    const out = mergeCooccurringEntities({
      own: [own("Pipedrive"), own("Zoho", "category peer")],
      entities: [entity("Salesforce", 9)],
      ownBrandNames: ["HubSpot"],
    });
    expect(out.map((c) => c.name)).toEqual(["Pipedrive", "Zoho", "Salesforce"]);
  });

  it("AC11 stops at five in total", () => {
    const out = mergeCooccurringEntities({
      own: [own("A1"), own("B1"), own("C1"), own("D1")],
      entities: [entity("Salesforce", 9), entity("Zoho", 8)],
      ownBrandNames: ["HubSpot"],
    });
    expect(out).toHaveLength(5);
    expect(out[4]!.name).toBe("Salesforce");
  });

  it("AC11 does not repeat a rival already proposed (case and punctuation ignored)", () => {
    const out = mergeCooccurringEntities({ own: [own("Sales-Force")], entities: [entity("salesforce", 9)], ownBrandNames: ["HubSpot"] });
    expect(out).toHaveLength(1);
  });

  it("AC11 never proposes the brand itself, by whole name", () => {
    const out = mergeCooccurringEntities({ own: [], entities: [entity("HubSpot", 9), entity("Hub Spot", 9), entity("Salesforce", 5)], ownBrandNames: ["HubSpot"] });
    expect(out.map((c) => c.name)).toEqual(["Salesforce"]);
  });

  it("AC11 ignores an entity seen in fewer than the minimum number of answers (a single sighting is noise)", () => {
    expect(MIN_COOCCURRING_RESULTS).toBe(2);
    expect(mergeCooccurringEntities({ own: [], entities: [entity("Rare", 1)], ownBrandNames: ["HubSpot"] })).toEqual([]);
    expect(mergeCooccurringEntities({ own: [], entities: [entity("Edge", 2)], ownBrandNames: ["HubSpot"] })).toHaveLength(1);
  });

  it("AC11 orders by confidence, then by name, so the result is stable", () => {
    const out = mergeCooccurringEntities({ own: [], entities: [entity("Beta", 5), entity("Alpha", 5), entity("Gamma", 9)], ownBrandNames: ["HubSpot"] });
    expect(out.map((c) => c.name)).toEqual(["Gamma", "Alpha", "Beta"]);
  });

  it("AC11 keeps confidence within 0..1 even if the counts are inconsistent, and skips a zero denominator", () => {
    const [c] = mergeCooccurringEntities({ own: [], entities: [entity("Over", 12, 10)], ownBrandNames: ["HubSpot"] });
    expect(c!.confidence).toBe(1);
    expect(mergeCooccurringEntities({ own: [], entities: [entity("None", 3, 0)], ownBrandNames: ["HubSpot"] })).toEqual([]);
  });

  it("AC11 returns the existing proposals unchanged when none co-occur (empty collection)", () => {
    const base = [own("Pipedrive")];
    expect(mergeCooccurringEntities({ own: base, entities: [], ownBrandNames: ["HubSpot"] })).toEqual(base);
  });

  it("AC11 drops a label that is not a name (empty, or over 50 characters)", () => {
    const out = mergeCooccurringEntities({ own: [], entities: [entity("  ", 9), entity("x".repeat(51), 9)], ownBrandNames: ["HubSpot"] });
    expect(out).toEqual([]);
  });
});

describe("STORY-043 AC11 · loadCooccurringEntities", () => {
  it("AC11 reads parsed mentions of the first run only and maps the rows", async () => {
    const query = vi.fn(async () => ({ rows: [{ label: "Salesforce", results: 8, brand_results: 10 }] }));
    const out = await loadCooccurringEntities({ query } as never, "project-1");
    expect(out).toEqual([{ label: "Salesforce", results: 8, brandResults: 10 }]);
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(params).toEqual(["project-1"]);
    expect(sql).toMatch(/mention_facts/);
    expect(sql).toMatch(/entity_type = 'other'/); // tracked competitors are not re-proposed
    expect(sql).toMatch(/entity_type = 'brand'/); // co-occurring WITH the brand
    expect(sql).toMatch(/ORDER BY created_at ASC/); // the first run
    expect(sql).toMatch(/c\.status = 'parsed'/); // only answers the parser has read have mention facts
    expect(sql).not.toMatch(/workspace_id/); // RLS scopes the transaction
  });

  it("AC11 no first run (or none finished) is an empty list, not an error", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await loadCooccurringEntities({ query } as never, "p")).toEqual([]);
  });
});
