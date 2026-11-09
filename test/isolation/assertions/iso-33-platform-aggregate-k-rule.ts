import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { type Breaker } from "../support/breakers.js";

// STORY-176 round 2 / owner decisions 88(d), 91 and 93 — the k >= 20 rule, asserted BEHAVIOURALLY on app.refresh_platform_metrics, not on a constant. ISO-15
// holds the table's CHECK (19 rejected, 20 accepted); this holds the function in front of it: 19 distinct workspaces publish NOTHING, 20 publish one row,
// a domain cited by 19 of those 20 is not listed, and the published figures are whole numbers. The probe is rolled back, so nothing remains.
//
// The k = 19 case passes either by "no row" (the function's own guard) or by the table's CHECK raising 23514 (the second guard); a function that
// published 19 and a table that accepted it is what fails. The matching breaker relaxes BOTH, so only this assertion can see it.
const CATEGORY = "iso33_k_rule";

async function probeGroup(client: Client, engineKey: string, workspaces: number, citeRare: (index: number) => boolean): Promise<{ rows: { sample_size: number; median_visibility: string; top_source_domains: unknown }[]; checkRaised: boolean }> {
  await client.query("BEGIN");
  try {
    for (let i = 0; i < workspaces; i++) {
      const [workspaceId, projectId, shared, rare] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      await client.query("INSERT INTO workspaces (id, name, slug, plan_key, timezone) VALUES ($1,'iso33',$2,'growth','UTC')", [workspaceId, `iso33-${workspaceId.slice(0, 8)}`]);
      await client.query(
        // category_slug stays NULL (it is constrained to the taxonomy); the aggregate reads the BENCHMARK category, which is not.
        `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, benchmark_category_slug, aux_score_current)
         VALUES ($1,$2,'P',$3,'https://p.example','p.example',$4,50)`,
        [projectId, workspaceId, `p-${projectId.slice(0, 8)}`, CATEGORY],
      );
      await client.query(
        `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, visibility_score, scoring_version)
         VALUES ($1,$2,$3,'brand',$2,CURRENT_DATE,$4,'v1')`,
        [workspaceId, projectId, engineKey, 10 + i + 0.4],
      );
      await client.query("INSERT INTO source_domains (id, workspace_id, domain) VALUES ($1,$3,'shared.iso33.example'), ($2,$3,'rare.iso33.example')", [shared, rare, workspaceId]);
      const cite = (domainId: string) =>
        client.query(
          `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, context_weight) VALUES ($1,$2,$3,$4,CURRENT_DATE,90,0.25)`,
          [workspaceId, projectId, domainId, engineKey],
        );
      await cite(shared);
      if (citeRare(i)) await cite(rare);
    }
    let checkRaised = false;
    await client.query("SAVEPOINT probe");
    try {
      await client.query("SELECT * FROM app.refresh_platform_metrics(CURRENT_DATE, CURRENT_DATE, ARRAY[$1]::text[], 'v1')", [CATEGORY]);
    } catch (error) {
      if ((error as { code?: string }).code !== "23514") throw error;
      checkRaised = true;
      await client.query("ROLLBACK TO SAVEPOINT probe");
    }
    const rows = await client.query<{ sample_size: number; median_visibility: string; top_source_domains: unknown }>(
      "SELECT sample_size, median_visibility::text, top_source_domains FROM platform_metrics WHERE category_slug = $1",
      [CATEGORY],
    );
    return { rows: rows.rows, checkRaised };
  } finally {
    await client.query("ROLLBACK");
  }
}

export async function assertIso33PlatformAggregateKRule(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const engine = await client.query<{ key: string }>("SELECT key FROM engines ORDER BY key LIMIT 1");
    // Fail closed: with no engine there is nothing to publish a row against, and the assertion would pass for no reason.
    if (engine.rows[0] === undefined) throw new Error("ISO-33: the database has no engine to probe the aggregate with");
    const engineKey = engine.rows[0].key;

    const nineteen = await probeGroup(client, engineKey, 19, () => true);
    if (nineteen.rows.length !== 0) throw new Error(`ISO-33: 19 distinct workspaces published ${nineteen.rows.length} row(s); below 20 there must be none`);

    const twenty = await probeGroup(client, engineKey, 20, (i) => i < 19);
    if (twenty.checkRaised || twenty.rows.length !== 1) throw new Error(`ISO-33: 20 distinct workspaces must publish exactly one row (got ${twenty.rows.length}${twenty.checkRaised ? ", the table CHECK refused it" : ""})`);
    const row = twenty.rows[0]!;
    if (row.sample_size !== 20) throw new Error(`ISO-33: the 20-workspace row records sample_size ${row.sample_size}`);
    // Whole numbers: 20 values 10.4..29.4 have a median of 20.4, published as 20. An exact figure is a difference a caller can solve.
    if (Number(row.median_visibility) !== 20) throw new Error(`ISO-33: the published median is ${row.median_visibility}, not the whole number 20 (percentiles are rounded, decision 93)`);
    const domains = JSON.stringify(row.top_source_domains);
    if (domains.includes("rare.iso33.example")) throw new Error("ISO-33: a domain cited by 19 of 20 workspaces was listed");
    if (!domains.includes("shared.iso33.example")) throw new Error("ISO-33: a domain cited by all 20 workspaces was not listed");
    if (/weight|0\.25/.test(domains)) throw new Error("ISO-33: a source domain carries its context weight");
  } finally {
    await client.end();
  }
}

export const iso33Breaker: Breaker = {
  id: "ISO-33",
  description: "relaxes the minimum inside app.refresh_platform_metrics from 20 workspaces to 1, and drops the table's CHECK behind it",
  apply: async (client) => {
    const def = await client.query<{ d: string }>(
      "SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname = 'refresh_platform_metrics'",
    );
    const original = def.rows[0]!.d;
    const weakened = original.replace(/c_min_workspaces\s+constant\s+integer\s*:=\s*20/u, "c_min_workspaces constant integer := 1");
    if (weakened === original) throw new Error("ISO-33 breaker: the minimum constant was not found in the function body");
    await client.query(weakened);
    await client.query("ALTER TABLE platform_metrics DROP CONSTRAINT platform_metrics_sample_size_check");
  },
  revert: async () => {
    // The change is local to the disposable database.
  },
};
