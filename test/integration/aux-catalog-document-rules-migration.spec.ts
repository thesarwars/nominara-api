import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { loadAuxCatalog } from "../../src/lib/aux/catalog.js";
import { readCatalogSql } from "../support/aux-catalog-sql.js";

// STORY-051 · migration 0148 — AUX-R-008..034 into the GLOBAL aux_rule_catalog (no workspace_id, no RLS), so all six categories load.
const MIGRATION = "0148_aux_catalog_document_rules";

interface Row { code: string; category: string; weight: number; rule_version: string; thresholds: Record<string, unknown>; auto_fixable: boolean; severity_default: string; task_threshold: string }

describe("STORY-051 · migration 0148 — document-model rule catalog", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
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

  async function rollbackTo0148(): Promise<void> {
    for (let step = 0; step < 50; step += 1) {
      const name = await rollbackLast(client, MIGRATIONS_DIR);
      expect(name, "0148 must be applied on a fully migrated database").not.toBeNull();
      if (name === MIGRATION) return;
    }
    throw new Error(`${MIGRATION} was not reached while rolling back`);
  }
  const all = async (): Promise<Row[]> => (await client.query("SELECT * FROM aux_rule_catalog ORDER BY code")).rows as Row[];

  it("STORY-051 AC6 · the migrated table holds 34 rules and the load-time assertion accepts every category", async () => {
    const rows = await all();
    expect(rows.map((r) => r.code)).toEqual(Array.from({ length: 34 }, (_, i) => `AUX-R-${String(i + 1).padStart(3, "0")}`));
    const catalog = loadAuxCatalog(rows.map((r) => ({ code: r.code, category: r.category, weight: r.weight, ruleVersion: r.rule_version, autoFixable: r.auto_fixable, thresholds: r.thresholds })));
    expect(catalog.rules).toHaveLength(34);
  });

  it("STORY-051 AC5 · the database holds exactly the catalog the unit tests run the rules against", async () => {
    const fromSql = new Map(readCatalogSql().map((r) => [r.code, r]));
    for (const r of await all()) {
      const s = fromSql.get(r.code)!;
      expect(r.weight, r.code).toBeCloseTo(s.weight, 5);
      expect(r.thresholds, r.code).toEqual(s.thresholds);
      expect(r.auto_fixable, r.code).toBe(s.autoFixable);
      expect(r.severity_default, r.code).toBe(s.severityDefault);
      expect(r.task_threshold, r.code).toBe(s.taskThreshold);
      expect(r.rule_version, r.code).toBe(s.ruleVersion);
    }
  });

  it("STORY-051 AC6 · changing a weight in the stored data makes the loader refuse (the check is on load, not in CI)", async () => {
    await client.query("UPDATE aux_rule_catalog SET weight = 0.20 WHERE code = 'AUX-R-021'");
    const rows = await all();
    expect(() => loadAuxCatalog(rows.map((r) => ({ code: r.code, category: r.category, weight: r.weight, ruleVersion: r.rule_version, autoFixable: r.auto_fixable, thresholds: r.thresholds })))).toThrow(/context_fitness/);
  });

  it("STORY-051 · a demo-seed row for a rule is taken over, keeping the primary key", async () => {
    await rollbackTo0148();
    await client.query(`INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, rule_version) VALUES ('AUX-R-008','structured_data','demo','demo','demo','critical',0.14,'1.0.0')`);
    await migrateUp(client, MIGRATIONS_DIR);
    const r = (await all()).find((x) => x.code === "AUX-R-008")!;
    expect(r.rule_version).toBe("2026.10.2");
  });

  it("STORY-051 · re-running the up migration is idempotent", async () => {
    await rollbackTo0148();
    await migrateUp(client, MIGRATIONS_DIR);
    expect(await all()).toHaveLength(34);
  });

  it("STORY-051 · down removes unreferenced rows, restores AUX-R-006, and never deletes a row a finding references", async () => {
    const ws = (await client.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('W','w-aux51','free') RETURNING id")).rows[0].id;
    const pj = (await client.query("INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,'P','p-aux51','https://example.com','example.com') RETURNING id", [ws])).rows[0].id;
    const audit = (await client.query(`INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer) VALUES ($1,$2,'manual',ARRAY['https://example.com/'],'v1','cl100k') RETURNING id`, [ws, pj])).rows[0].id;
    await client.query(`INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, severity, fingerprint, title, evidence, rule_version) VALUES ($1,$2,$3,'AUX-R-021','high',sha256('f'::bytea),'T','{}'::jsonb,'v1')`, [ws, pj, audit]);
    await rollbackTo0148();
    const left = (await all()).map((r) => r.code);
    expect(left).toEqual(["AUX-R-001", "AUX-R-002", "AUX-R-003", "AUX-R-004", "AUX-R-005", "AUX-R-006", "AUX-R-007", "AUX-R-021"]);
    const six = (await all()).find((r) => r.code === "AUX-R-006")!;
    expect(six.thresholds).toEqual({});
    expect(six.rule_version).toBe("2026.10.1");
  });
});
