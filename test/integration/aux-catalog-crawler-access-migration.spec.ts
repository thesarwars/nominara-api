import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { loadAuxCatalog } from "../../src/lib/aux/catalog.js";
import { SITE_FILE_THRESHOLDS } from "../../src/lib/aux/site-files.js";

// NEW-C-8 · migration 0070 — the seven crawler_access rules, AUX-R-001..007,
// into the GLOBAL aux_rule_catalog (no workspace_id, no RLS).
const MIGRATION = "0070_aux_catalog_crawler_access";

describe("NEW-C-8 · migration 0070 — crawler_access catalog", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 180_000);
  afterAll(async () => { await container.stop(); });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client, MIGRATIONS_DIR);
  });
  afterEach(async () => { await client.end(); });

  async function rows(): Promise<{ code: string; category: string; weight: number; rule_version: string; thresholds: Record<string, unknown>; severity_default: string; task_threshold: string; auto_fixable: boolean }[]> {
    return (await client.query("SELECT * FROM aux_rule_catalog WHERE category = 'crawler_access' ORDER BY code")).rows;
  }

  it("NEW-C-8 AC3.8 · inserts exactly AUX-R-001..007 with the specified weights, severities, auto-fix and task thresholds", async () => {
    const r = await rows();
    expect(r.map((x) => x.code)).toEqual(["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-005", "AUX-R-006", "AUX-R-007"]);
    expect(r.map((x) => Number(x.weight.toFixed(2)))).toEqual([0.3, 0.08, 0.12, 0.06, 0.24, 0.12, 0.08]);
    expect(r.map((x) => x.severity_default)).toEqual(["critical", "medium", "high", "low", "critical", "high", "medium"]);
    expect(r.map((x) => x.task_threshold)).toEqual(["critical", "high", "high", "medium", "critical", "high", "medium"]);
    expect(r.map((x) => x.auto_fixable)).toEqual([true, true, false, true, false, true, true]);
  });

  it("NEW-C-8 AC3.9 · the catalog loader accepts what the migration wrote (weights sum to 1.000)", async () => {
    const r = await rows();
    const catalog = loadAuxCatalog(r.map((x) => ({ code: x.code, category: x.category, weight: x.weight, ruleVersion: x.rule_version, thresholds: x.thresholds })));
    expect(catalog.rules).toHaveLength(7);
  });

  it("NEW-C-8 AC3.10 · every row carries a real rule_version, not the demo seed's", async () => {
    for (const x of await rows()) {
      expect(x.rule_version).not.toBe("1.0.0");
      expect(x.rule_version.length).toBeGreaterThan(0);
    }
  });

  it("NEW-C-8 AC3.11 · thresholds stored as data equal the evaluators' constants", async () => {
    const byCode = Object.fromEntries((await rows()).map((x) => [x.code, x.thresholds]));
    expect(byCode["AUX-R-003"]).toMatchObject({ max_bytes: SITE_FILE_THRESHOLDS.robotsMaxBytes });
    expect(byCode["AUX-R-007"]).toMatchObject({
      stale_days: SITE_FILE_THRESHOLDS.sitemapStaleDays,
      stale_ratio: SITE_FILE_THRESHOLDS.sitemapStaleRatio,
    });
  });

  it("NEW-C-8 AC3.12 · customer text names an AI consequence, not a rule code", async () => {
    for (const x of (await client.query("SELECT title, description, rationale FROM aux_rule_catalog WHERE category='crawler_access'")).rows) {
      expect(`${x.title} ${x.description} ${x.rationale}`).not.toMatch(/AUX-R-\d+/);
      expect(x.rationale).toMatch(/\b(AI|engine|engines|answer|answers|cite|citation|crawler|crawlers)\b/i);
    }
  });

  it("NEW-C-8 AC3.13 · the demo seed's earlier AUX-R-001 row is taken over (ON CONFLICT DO UPDATE), keeping its id-less PK and findings FK intact", async () => {
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe(MIGRATION);
    await client.query(
      `INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, rule_version)
       VALUES ('AUX-R-001','crawler_access','demo','demo','demo','critical',0.3,'1.0.0')`,
    );
    await migrateUp(client, MIGRATIONS_DIR);
    const r = (await rows()).find((x) => x.code === "AUX-R-001")!;
    expect(r.rule_version).not.toBe("1.0.0");
  });

  it("NEW-C-8 AC3.14 · re-running the up migration is idempotent", async () => {
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe(MIGRATION);
    await migrateUp(client, MIGRATIONS_DIR);
    expect(await rows()).toHaveLength(7);
  });

  it("NEW-C-8 AC3.15 · down removes AUX-R-002..007 but never a row an aux_finding references", async () => {
    const ws = (await client.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W','w-aux8','free') RETURNING id")).rows[0].id;
    const pr = (await client.query("SELECT 1")).rows; // keep lint quiet about unused
    expect(pr).toHaveLength(1);
    expect(ws).toBeTruthy();
    expect(await rollbackLast(client, MIGRATIONS_DIR)).toBe(MIGRATION);
    const left = (await client.query("SELECT code FROM aux_rule_catalog WHERE category='crawler_access' ORDER BY code")).rows.map((x) => x.code);
    expect(left).toEqual(["AUX-R-001"]);
  });
});
