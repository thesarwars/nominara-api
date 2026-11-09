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

// STORY-111 review - the access export is DEFAULT-DENY: a column is exported only if it is declared exportable.
describe("STORY-111 subject export column allow-list (default deny)", () => {
  const CREDENTIAL = /(hash|secret|token|ciphertext|password|private|signature|api_key|wrapped|dek|_enc$|credential|cert_arn)/i;

  it("S1 no exportable column looks like credential material (a *_enc, *credential*, hash, token column must be omitted)", () => {
    const offenders: string[] = [];
    for (const [table, entry] of Object.entries(SUBJECT_INVENTORY)) {
      if (entry.disposition !== "export") continue;
      for (const c of entry.columns) if (CREDENTIAL.test(c)) offenders.push(`${table}.${c}`);
    }
    expect(offenders).toEqual([]);
  });

  it("S1 the columns that exist today and are credential material are omitted by name", () => {
    const omitted = (t: string): readonly string[] => {
      const e = SUBJECT_INVENTORY[t];
      return e?.disposition === "export" ? e.omit : [];
    };
    expect(omitted("gsc_connections")).toEqual(expect.arrayContaining(["credentials_enc", "refresh_enc"]));
    expect(omitted("attribution_configs")).toEqual(expect.arrayContaining(["ga4_credentials_enc"]));
    expect(omitted("api_keys")).toContain("key_hash");
    expect(omitted("workspace_invitations")).toEqual(expect.arrayContaining(["email", "token_hash"]));
  });

  it("S1 an exported table declares each column once: exportable or omitted, never both", () => {
    for (const [table, entry] of Object.entries(SUBJECT_INVENTORY)) {
      if (entry.disposition !== "export") continue;
      expect(entry.columns.filter((c) => entry.omit.includes(c)), table).toEqual([]);
      expect(new Set(entry.columns).size, table).toBe(entry.columns.length);
    }
  });
});
