import { describe, expect, it } from "vitest";
import { createProjectFieldsSchema, createProjectRequestSchema, OPTIONAL_PROJECT_FIELDS } from "./create-project-request.schema.js";

// STORY-043 scenarios 3, 6, 7, 10 — all of them shape questions, so all of
// them answerable here without a database or an HTTP round trip.
describe("STORY-043 · createProjectRequest", () => {
  it("scenario 1 — accepts a URL alone", () => {
    const result = createProjectRequestSchema.safeParse({ root_url: "https://hubspot.com" });
    expect(result.success).toBe(true);
  });

  it("scenario 3 — accepts every documented optional field together", () => {
    const result = createProjectRequestSchema.safeParse({
      root_url: "https://hubspot.com",
      name: "HubSpot CRM",
      description: "Customer platform with CRM, marketing, and service hubs.",
      brand_aliases: ["HubSpot", "HS CRM"],
      negative_aliases: ["hub"],
      owned_domains: ["hubspot.de"],
      locale: "en-US",
      category_slug: "crm",
      verticals: ["b2b-saas"],
      competitors: [{ name: "Salesforce", root_domain: "salesforce.com", aliases: ["SFDC"] }],
      prompts: [{ text: "most reliable CRM for a 50-rep sales team" }],
      kind: "brand",
    });
    expect(result.success).toBe(true);
  });

  // AC2 — "topics, engines, and cadence are not accepted at creation".
  it.each(["topics", "tags", "engines", "cadence"])("scenario 6 — rejects %s as an unknown field", (key) => {
    const result = createProjectRequestSchema.safeParse({ root_url: "https://hubspot.com", [key]: ["x"] });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain(key);
  });

  // AC3 — derived from root_url, never trusted from the caller.
  it("scenario 7 — rejects a supplied root_domain, naming the offending path", () => {
    const result = createProjectRequestSchema.safeParse({
      root_url: "https://hubspot.com",
      root_domain: "evil.com",
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("root_domain");
  });

  // AC6 — settable only at creation, and only with a parent.
  it("scenario 10 — refuses product_line without a parent, pointing at parent_project_id", () => {
    const result = createProjectRequestSchema.safeParse({ root_url: "https://hubspot.com", kind: "product_line" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes("parent_project_id"))).toBe(true);
  });

  it("accepts product_line WITH a parent", () => {
    const result = createProjectRequestSchema.safeParse({
      root_url: "https://hubspot.com",
      kind: "product_line",
      parent_project_id: "0f9e2a7c-1b3d-4e5f-8a9b-0c1d2e3f4a5b",
    });
    expect(result.success).toBe(true);
  });

  it("requires root_url", () => {
    expect(createProjectRequestSchema.safeParse({}).success).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(createProjectRequestSchema.safeParse({ root_url: "not a url" }).success).toBe(false);
  });

  // The scheme/port/address checks are the guarded fetcher's, not zod's — they
  // resolve DNS and a schema must stay synchronous. Asserted here so the split
  // is deliberate and visible rather than looking like a missing check.
  it("passes a well-formed but unsafe URL through — that refusal is the fetcher's", () => {
    expect(createProjectRequestSchema.safeParse({ root_url: "http://169.254.169.254/" }).success).toBe(true);
  });

  it("trims and rejects whitespace-only strings", () => {
    expect(createProjectRequestSchema.safeParse({ root_url: "https://x.com", name: "   " }).success).toBe(false);
    const ok = createProjectRequestSchema.safeParse({ root_url: "https://x.com", name: "  HubSpot  " });
    expect(ok.success && ok.data.name).toBe("HubSpot");
  });

  it("rejects an unknown key inside a supplied competitor or prompt", () => {
    expect(
      createProjectRequestSchema.safeParse({
        root_url: "https://x.com",
        competitors: [{ name: "S", weight: 3 }],
      }).success,
    ).toBe(false);
    expect(
      createProjectRequestSchema.safeParse({ root_url: "https://x.com", prompts: [{ text: "t", intent: "x" }] }).success,
    ).toBe(false);
  });

  // AC4's echo list must stay in step with the schema. A field added to one and
  // not the other would report a SUPPLIED field as being discovered.
  it("OPTIONAL_PROJECT_FIELDS covers every optional key in the schema, and only those", () => {
    const schemaKeys = Object.keys(createProjectFieldsSchema.shape);
    const optional = schemaKeys.filter((k) => k !== "root_url").sort();
    expect([...OPTIONAL_PROJECT_FIELDS].sort()).toEqual(optional);
  });
});
