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
    const out = (await generateFreeAllowance(db, input())).prompts;
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
    const first = (await generateFreeAllowance(db, input())).prompts;
    const again = (await generateFreeAllowance(db, input())).prompts;
    expect(again.map((p) => p.prompt_id)).toEqual(first.map((p) => p.prompt_id));
    const count = await db.query<{ n: string }>("SELECT count(*) AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(Number(count.rows[0]!.n)).toBe(10);
  });

  it("tops up around prompts the project already holds without colliding on the hash index", async () => {
    await generateFreeAllowance(db, { ...input(), allowance: 4 });
    const out = (await generateFreeAllowance(db, input())).prompts;
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

  // STORY-043 review (round 1), findings 2 and 3 — against the real schema and the real hash index.
  it("counts prompts another writer generated: a project already holding ten gets none, and the payload says 0 remaining", async () => {
    await db.query(`UPDATE projects SET name = 'HubSpot' WHERE id = $1`, [projectId]);
    // The onboarding step's explicit generate writes `generated` rows with no discovery origin.
    for (let i = 0; i < 10; i++) {
      await db.query(
        `INSERT INTO tracked_prompts (id, workspace_id, project_id, generation_batch_id, generation_source, text, text_hash, intent_archetype, funnel_stage, generator_meta, is_priority, status)
         VALUES ($1, $2, $3, $4, 'generated', $5, sha256(convert_to($5, 'UTF8')), 'recommendation', 'consideration', '{}'::jsonb, false, 'archived')`,
        [randomUUID(), workspaceId, projectId, randomUUID(), `explicit prompt ${String(i)}`],
      );
    }
    const out = await generateFreeAllowance(db, input());
    expect(out.prompts).toEqual([]);
    expect(out.remaining).toBe(0);
    const count = await db.query<{ n: string }>("SELECT count(*) AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(Number(count.rows[0]!.n)).toBe(10);
  });

  it("the real URL-only row (name = root_domain, no category, no verticals) generates only what it can fill, never the domain as a brand", async () => {
    await db.query(`UPDATE projects SET name = root_domain, category_slug = NULL, verticals = '{}' WHERE id = $1`, [projectId]);
    const out = await generateFreeAllowance(db, input());
    expect(out.prompts.length).toBeLessThan(10);
    expect(out.remaining).toBe(10 - out.prompts.length);
    const rows = await db.query<{ text: string }>("SELECT text FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(rows.rows).toHaveLength(out.prompts.length);
    for (const row of rows.rows) expect(row.text.toLowerCase()).not.toContain("hubspot.com");
  });

  it("two concurrent deliveries still total at most ten", async () => {
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      await Promise.all([
        (async () => { await db.query("BEGIN"); await generateFreeAllowance(db, input()); await db.query("COMMIT"); })(),
        (async () => { await other.query("BEGIN"); await generateFreeAllowance(other, input()); await other.query("COMMIT"); })(),
      ]);
    } finally {
      await other.end();
    }
    const count = await db.query<{ n: string }>("SELECT count(*) AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(Number(count.rows[0]!.n)).toBe(10);
  });

  // The cross-writer race (generation parked in its naturaliser while discovery writes the free allowance) moved to
  // test/integration/prompt-generation-job.spec.ts (D95a-14): generation is a background job now (owner decision 95a).
});
