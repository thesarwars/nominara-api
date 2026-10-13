import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { SourcesService } from "../../src/modules/analytics/sources.service.js";
import { currentTenantStore, withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-054 AC12 / scenario 12 — "Read the index: inside its query budget".
//
// data-model.md §6 "Query budget": "Source index ≤ 25 ms ... None of these may scan a raw partition." and
// testing-strategy.md §8: an EXPLAIN regression test asserts it, so a plan regression fails the build rather than
// surfacing as a slow dashboard. The statements are CAPTURED from the real `SourcesService.sourceIndex` call (not
// re-typed here), so the test cannot drift from the read it guards.
//
// The volume is deliberately not a toy: 20 projects x DOMAINS domains x 3 windows, so the target project is a
// small slice of the table and the planner has a real choice between an index and a sequential scan.

const PROJECTS = 20;
const DOMAINS = 600;
const BUDGET_MS = 25;
const RAW_PARTITIONED = /^(answer_captures|mention_facts|citation_facts)/;

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  Plans?: PlanNode[];
}
const nodesOf = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodesOf)];

describe("STORY-054 AC12 · the source index read meets its query budget", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);

    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [workspaceId, `w-${workspaceId.slice(0, 8)}`]);
    await db.query(
      `INSERT INTO source_domains (workspace_id, domain, source_class, is_seedable)
       SELECT $1, 'site' || g || '.example', 'community_forum', true FROM generate_series(1, $2) g`,
      [workspaceId, DOMAINS],
    );
    for (let p = 0; p < PROJECTS; p += 1) {
      const id = randomUUID();
      if (p === 0) projectId = id;
      await db.query(`INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://acme.com','acme.com')`, [
        id,
        workspaceId,
        `p-${id.slice(0, 8)}`,
      ]);
      await db.query(
        `INSERT INTO project_source_index
           (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days, citation_count, distinct_prompts,
            distinct_urls, context_weight, rank_position, brand_present_on_domain, gap_severity, top_urls)
         SELECT $1, $2, sd.id, 'all', current_date - w.days, w.days, 10, 3, 4, 1.0 / $3, row_number() OVER (PARTITION BY w.days ORDER BY sd.domain),
                false, 'low', '[{"url":"https://x.example/a","count":3,"last_seen":"2026-10-01"}]'::jsonb
           FROM source_domains sd CROSS JOIN (VALUES (7),(30),(90)) AS w(days)
          WHERE sd.workspace_id = $1`,
        [workspaceId, id, DOMAINS],
      );
    }
    await db.query("ANALYZE project_source_index");
    await db.query("ANALYZE source_domains");
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  /** Runs the real read and returns every statement it issued. */
  async function statementsOf(timeframe: "7d" | "30d" | "90d"): Promise<{ text: string; values: unknown[] }[]> {
    return withTenantContext(db, { workspaceId, actorId: randomUUID() }, async () => {
      const client = currentTenantStore()!.client;
      const original = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>;
      const seen: { text: string; values: unknown[] }[] = [];
      const spy = vi.spyOn(client, "query").mockImplementation(((text: string, values?: unknown[]) => {
        seen.push({ text, values: values ?? [] });
        return original(text, values);
      }) as never);
      try {
        const response = await new SourcesService().sourceIndex(projectId, { timeframe });
        expect(response.domains).toHaveLength(DOMAINS); // the read really did return the whole window
      } finally {
        spy.mockRestore();
      }
      return seen;
    }) as Promise<{ text: string; values: unknown[] }[]>;
  }

  it("scenario 12 · issues a fixed number of statements however many domains the window holds (no per-domain query)", async () => {
    const statements = await statementsOf("30d");
    // project window, the ranked index rows, the competitor list: three, for 600 domains.
    expect(statements).toHaveLength(3);
  });

  it(`scenario 12 · every window's read stays inside ${String(BUDGET_MS)} ms, and none scans a raw partition or the whole index`, async () => {
    for (const timeframe of ["7d", "30d", "90d"] as const) {
      const statements = await statementsOf(timeframe);
      let executionMs = 0;
      for (const statement of statements) {
        const explained = await withTenantContext(db, { workspaceId, actorId: randomUUID() }, async () => {
          const client = currentTenantStore()!.client;
          return client.query<{ "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[] }>(
            `EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`,
            statement.values,
          );
        });
        const root = (explained as { rows: { "QUERY PLAN": { Plan: PlanNode; "Execution Time": number }[] }[] }).rows[0]!["QUERY PLAN"][0]!;
        executionMs += root["Execution Time"];

        const nodes = nodesOf(root.Plan);
        // data-model.md §6: "None of these may scan a raw partition."
        expect(nodes.filter((n) => n["Relation Name"] !== undefined && RAW_PARTITIONED.test(n["Relation Name"]))).toEqual([]);
        // The index must be reached by its index, not by reading every project's rows.
        expect(nodes.filter((n) => n["Node Type"] === "Seq Scan" && n["Relation Name"] === "project_source_index")).toEqual([]);
      }
      expect(executionMs, `${timeframe}: summed execution time of the read's statements`).toBeLessThanOrEqual(BUDGET_MS);
    }
  });
});
