import { describe, expect, it } from "vitest";
import { businessCategoriesResponseSchema } from "./business-categories.schema.js";

const entry = { slug: "crm", name: "CRM Software", parent_slug: "software", parent_name: "Software", description: "Customer relationship management tools." };

describe("GET /business-categories response", () => {
  it("accepts entries with and without a parent", () => {
    expect(businessCategoriesResponseSchema.safeParse({ categories: [entry, { ...entry, slug: "nonprofit_charities", parent_slug: null, parent_name: null }] }).success).toBe(true);
  });
  it("refuses an empty list: the taxonomy is never empty, so an empty body is a fault and not an answer", () => {
    expect(businessCategoriesResponseSchema.safeParse({ categories: [] }).success).toBe(false);
  });
  it("is strict: nothing tenant-shaped can ride along", () => {
    expect(businessCategoriesResponseSchema.safeParse({ categories: [{ ...entry, workspace_id: "x" }] }).success).toBe(false);
    expect(businessCategoriesResponseSchema.safeParse({ categories: [entry], extra: 1 }).success).toBe(false);
  });
  it("refuses an entry missing its description", () => {
    const { description: _d, ...rest } = entry;
    expect(businessCategoriesResponseSchema.safeParse({ categories: [rest] }).success).toBe(false);
  });
});
