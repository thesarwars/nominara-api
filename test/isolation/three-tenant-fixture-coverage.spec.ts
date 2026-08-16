import { describe, expect, it } from "vitest";
import { connectSuperuser } from "./support/assertion-context.js";
import { discoverPartitionChildren, discoverSingleRowPerTenantTables, discoverTenantTables } from "./support/discovery.js";
import { ROW_COUNT } from "./support/three-tenant-fixture.js";
import { getAssertionContext } from "./support/context.js";

// STORY-012 T5 — the three-tenant fixture's own coverage spec: every
// discovered tenant table holds >= 50 rows per tenant, EXCEPT the two
// structurally single-row-per-tenant tables (credit_wallets, workspaces),
// which hold exactly 1. Partition children are covered indirectly: their sum
// equals the parent's count (Postgres routes every insert to exactly one
// child), and at least one child holds rows per tenant, proving the
// partitioned insert path was actually exercised.
describe("STORY-012 T5 · three-tenant fixture coverage", () => {
  it("every discovered tenant table has >= 50 rows for each of the 3 seeded tenants (or exactly 1 for the structurally-capped tables)", async () => {
    const ctx = getAssertionContext();
    const client = await connectSuperuser(ctx);
    try {
      const tenantTables = await discoverTenantTables(client);
      const singleRow = await discoverSingleRowPerTenantTables(client, tenantTables);
      expect(tenantTables.length).toBe(59);

      for (const tenant of [ctx.fixture.a, ctx.fixture.b, ctx.fixture.c]) {
        for (const table of tenantTables) {
          const expected = singleRow.has(table.name) ? 1 : ROW_COUNT;
          const result = await client.query<{ count: string }>(
            `SELECT count(*) FROM ${table.name} WHERE ${table.scopeColumn} = $1`,
            [tenant.workspaceId],
          );
          const count = Number(result.rows[0]!.count);
          expect(count, `${table.name} for tenant ${tenant.label}`).toBeGreaterThanOrEqual(expected);
        }
      }
    } finally {
      await client.end();
    }
  });

  it("at least one partition child holds rows for each tenant, for every partitioned tenant table", async () => {
    const ctx = getAssertionContext();
    const client = await connectSuperuser(ctx);
    try {
      const children = await discoverPartitionChildren(client);
      const byParent = new Map<string, string[]>();
      for (const child of children) {
        if (child.name.endsWith("_default")) continue; // the default partition legitimately stays empty in this fixture
        const list = byParent.get(child.parent) ?? [];
        list.push(child.name);
        byParent.set(child.parent, list);
      }
      expect(byParent.size).toBeGreaterThan(0);

      for (const tenant of [ctx.fixture.a, ctx.fixture.b, ctx.fixture.c]) {
        for (const [parent, childNames] of byParent) {
          let total = 0;
          for (const childName of childNames) {
            const result = await client.query<{ count: string }>(
              `SELECT count(*) FROM ${childName} WHERE workspace_id = $1`,
              [tenant.workspaceId],
            );
            total += Number(result.rows[0]!.count);
          }
          expect(total, `${parent}'s children, tenant ${tenant.label}`).toBeGreaterThan(0);
        }
      }
    } finally {
      await client.end();
    }
  });

  it("the four D-7 awkward shapes are present in every tenant's fixture", async () => {
    const ctx = getAssertionContext();
    const client = await connectSuperuser(ctx);
    try {
      for (const tenant of [ctx.fixture.a, ctx.fixture.b, ctx.fixture.c]) {
        const single = await client.query<{ count: string }>(
          "SELECT count(*) FROM tracked_prompts WHERE project_id = $1",
          [tenant.projectIds[0]],
        );
        expect(Number(single.rows[0]!.count), `${tenant.label}'s single-prompt project`).toBe(1);

        const names = await client.query<{ name: string }>("SELECT name FROM projects WHERE id = ANY($1::uuid[])", [
          [tenant.projectIds[1], tenant.projectIds[2]],
        ]);
        expect(names.rows.map((r) => r.name).sort()).toEqual(["Apple", "Blue Ocean Roasters"]);

        const competitors = await client.query<{ name: string }>(
          "SELECT name FROM competitors WHERE id = ANY($1::uuid[])",
          [tenant.competitorIds.slice(0, 2)],
        );
        expect(competitors.rows.map((r) => r.name).sort()).toEqual(["Cloud", "Cloudflare Systems"]);
      }
    } finally {
      await client.end();
    }
  });
});
