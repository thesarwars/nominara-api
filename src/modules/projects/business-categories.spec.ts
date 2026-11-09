import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { businessCategoriesResponseSchema } from "../../../contracts/projects/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { BusinessCategoriesController } from "./business-categories.controller.js";
import { BusinessCategoriesService } from "./business-categories.service.js";

// STORY-189 · GET /v1/business-categories — the taxonomy the category override picker lists. Global table, no tenant data, authenticated.

const ROW = { slug: "crm", name: "CRM", parent_slug: "software_sales_marketing", parent_name: "Sales and marketing software", description: "Software where sales teams store contacts." };

describe("GET /business-categories · controller", () => {
  it("is declared with the response contract, behind an authenticated member permission, and takes no path or query input", () => {
    const contract = Reflect.getMetadata(API_CONTRACT_KEY, BusinessCategoriesController.prototype.list) as Record<string, unknown>;
    expect(contract).toMatchObject({ operationId: "listBusinessCategories", responseSchema: businessCategoriesResponseSchema });
    expect(contract.paramsSchema).toBeUndefined();
    expect(contract.querySchema).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, BusinessCategoriesController.prototype.list)).toBe("workspace:read");
  });
});

describe("GET /business-categories · service", () => {
  it("reads the global table in slug order, with no tenant predicate, and answers the documented shape", async () => {
    const query = vi.fn(async () => ({ rows: [ROW, { ...ROW, slug: "nonprofit_charities", parent_slug: null, parent_name: null }] }));
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: { query } } as never);
    const result = await new BusinessCategoriesService().list();
    expect(businessCategoriesResponseSchema.safeParse(result).success).toBe(true);
    expect(result.categories.map((c) => c.slug)).toEqual(["crm", "nonprofit_charities"]);
    const sql = String((query.mock.calls[0] as unknown[])[0]);
    expect(sql).toMatch(/FROM business_categories/);
    expect(sql).toMatch(/ORDER BY slug/);
    expect(sql).not.toMatch(/workspace/);
  });

  it("an empty taxonomy is a fault, not an empty answer", async () => {
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: { query: vi.fn(async () => ({ rows: [] })) } } as never);
    await expect(new BusinessCategoriesService().list()).rejects.toThrow();
  });
});
