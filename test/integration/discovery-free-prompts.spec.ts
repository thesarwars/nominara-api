import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { DISCOVERY_ORIGIN, generateFreeAllowance } from "../../src/lib/discovery/free-prompts.js";

// STORY-043 AC12 (first half) — the free-allowance statements EXECUTED against real migrations and constraints, not asserted as
// strings (the lesson of promptgen-persist.spec.ts). Includes the property the unit stub cannot show: a redelivery writes nothing.

describe("STORY-043 · generateFreeAllowance executes", () => {
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
  }, 240_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tracked_prompts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [workspaceId, `w-${randomUUID().slice(0, 8)}`]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, category_slug, verticals)
       VALUES ($1, $2, 'HubSpot', $3, 'https://hubspot.com', 'hubspot.com', 'crm', ARRAY['saas'])`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  const input = () => ({ workspaceId, projectId, allowance: 10 });

  it("inserts ten archived prompts that carry the discovery origin, and nothing else", async () => {
    const out = await generateFreeAllowance(db, input());
    expect(out).toHaveLength(10);
    const rows = await db.query<{ status: string; generation_source: string; origin: string }>(
      "SELECT status, generation_source, generator_meta->>'origin' AS origin FROM tracked_prompts WHERE project_id = $1",
      [projectId],
    );
    expect(rows.rows).toHaveLength(10);
    for (const row of rows.rows) {
      expect(row.status).toBe("archived");
      expect(row.generation_source).toBe("generated");
      expect(row.origin).toBe(DISCOVERY_ORIGIN);
    }
  });

  it("a redelivery inserts nothing and returns the same ten ids", async () => {
    const first = await generateFreeAllowance(db, input());
    const again = await generateFreeAllowance(db, input());
    expect(again.map((p) => p.prompt_id)).toEqual(first.map((p) => p.prompt_id));
    const count = await db.query<{ n: string }>("SELECT count(*) AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(Number(count.rows[0]!.n)).toBe(10);
  });

  it("tops up around prompts the project already holds without colliding on the hash index", async () => {
    await generateFreeAllowance(db, { ...input(), allowance: 4 });
    const out = await generateFreeAllowance(db, input());
    expect(out).toHaveLength(10);
    const count = await db.query<{ n: string }>("SELECT count(*) AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(Number(count.rows[0]!.n)).toBe(10);
  });

  it("touches no wallet: the credit ledger is unchanged", async () => {
    const before = await db.query<{ n: string }>("SELECT count(*) AS n FROM credit_ledger");
    await generateFreeAllowance(db, input());
    const after = await db.query<{ n: string }>("SELECT count(*) AS n FROM credit_ledger");
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });
});
