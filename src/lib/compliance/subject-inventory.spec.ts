import { describe, expect, it } from "vitest";
import { TENANT_TABLES } from "../../db/rls/tenant-tables.generated.js";
import { SUBJECT_INVENTORY, unregisteredTenantTables, staleInventoryEntries } from "./subject-inventory.js";

// STORY-111 AC "inventory derived from the same metadata that generates the isolation policies". Scenario 2.
describe("STORY-111 subject inventory registry (scenario 2)", () => {
  it("S2 registers every tenant table the isolation policies cover", () => {
    expect(unregisteredTenantTables(TENANT_TABLES)).toEqual([]);
  });

  it("S2 ADDING A TABLE WITHOUT REGISTERING IT FAILS: the check names it", () => {
    const withNewTable = new Set([...TENANT_TABLES, "brand_new_tenant_table"]);
    expect(unregisteredTenantTables(withNewTable)).toEqual(["brand_new_tenant_table"]);
  });

  it("S2 an inventory entry for a table that no longer exists is stale and reported", () => {
    const without = new Set([...TENANT_TABLES].filter((t) => t !== "tasks"));
    expect(staleInventoryEntries(without)).toContain("tasks");
  });

  it("S2 every entry is either exported or exempt with a stated reason", () => {
    for (const [table, entry] of Object.entries(SUBJECT_INVENTORY)) {
      if (entry.disposition === "exempt") expect(entry.reason.length, table).toBeGreaterThan(10);
      else expect(entry.disposition, table).toBe("export");
    }
  });
});
