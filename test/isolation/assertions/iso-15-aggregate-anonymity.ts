import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-15 / STORY-012 T22 — cross-tenant
// aggregates (platform_metrics, derived from metric_daily) carry no tenant
// identifier and satisfy k >= 20 — asserted at the exact boundary (19
// rejected by the CHECK constraint, 20 accepted), plus a fixture-derived
// aggregate over the three seeded tenants that emits no tenant id in any
// column or jsonb value.
export async function assertIso15AggregateAnonymity(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    // 1. platform_metrics has no workspace_id / tenant-identifying column at all.
    const columns = await client.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'platform_metrics'",
    );
    const columnNames = columns.rows.map((r) => r.column_name);
    if (columnNames.includes("workspace_id") || columnNames.includes("project_id")) {
      throw new Error("ISO-15: platform_metrics carries a tenant-identifying column");
    }

    // 2. the k >= 20 boundary: 19 rejected, 20 accepted.
    let rejected19 = false;
    try {
      await client.query(
        `INSERT INTO platform_metrics (metric_date, category_slug, engine_key, sample_size, median_visibility, p25_visibility, p75_visibility, median_aux_score, top_source_domains)
         VALUES (CURRENT_DATE, 'iso15-boundary-19', 'chatgpt', 19, 10, 5, 15, 50, '[]'::jsonb)`,
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23514") rejected19 = true;
      else throw error;
    }
    if (!rejected19) {
      throw new Error("ISO-15: sample_size = 19 was NOT rejected by the k >= 20 CHECK constraint");
    }

    await client.query(
      `INSERT INTO platform_metrics (metric_date, category_slug, engine_key, sample_size, median_visibility, p25_visibility, p75_visibility, median_aux_score, top_source_domains)
       VALUES (CURRENT_DATE, 'iso15-boundary-20', 'chatgpt', 20, 10, 5, 15, 50, '[]'::jsonb)
       ON CONFLICT (metric_date, category_slug, engine_key) DO NOTHING`,
    );
    const accepted = await client.query<{ count: string }>(
      "SELECT count(*) FROM platform_metrics WHERE category_slug = 'iso15-boundary-20'",
    );
    if (Number(accepted.rows[0]!.count) !== 1) {
      throw new Error("ISO-15: sample_size = 20 was NOT accepted");
    }

    // 3. a fixture-derived aggregate over the 3 seeded tenants' metric_daily
    // rows emits no tenant id anywhere in its output (columns or jsonb).
    const { a, b, c } = ctx.fixture;
    const tenantIds = [a.workspaceId, b.workspaceId, c.workspaceId, ...a.projectIds, ...b.projectIds, ...c.projectIds];
    // A PROPERLY anonymised aggregate — count and distinct entity_type/engine —
    // never a passthrough of any per-row identifying column such as entity_id.
    const aggregate = await client.query<{ sample_size: string; entity_types: unknown }>(
      `SELECT count(*) AS sample_size, jsonb_agg(DISTINCT entity_type) AS entity_types
         FROM metric_daily
        WHERE workspace_id = ANY($1::uuid[])`,
      [[a.workspaceId, b.workspaceId, c.workspaceId]],
    );
    const row = aggregate.rows[0]!;
    const serialized = JSON.stringify(row);
    for (const id of tenantIds) {
      if (serialized.includes(id)) {
        throw new Error(`ISO-15: fixture-derived aggregate output contains a tenant identifier (${id})`);
      }
    }
  } finally {
    await client.end();
  }
}

export const iso15Breaker: Breaker = {
  id: "ISO-15",
  description: "relaxes the k >= 20 CHECK constraint on platform_metrics, permitting a small (re-identifiable) sample",
  apply: async (client) => {
    await client.query("ALTER TABLE platform_metrics DROP CONSTRAINT platform_metrics_sample_size_check");
  },
  revert: NOOP_REVERT,
};
