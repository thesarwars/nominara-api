import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, listMigrationFiles, migrateUp } from "../../src/db/migrate-runner.js";

// Every other migration suite migrates an EMPTY database, so the additive-only
// guard (which only fires on a populated table) and any data-dependent step
// (a backfill, a VALIDATE CONSTRAINT, a re-pointed FK) were never exercised.
// This suite migrates to a baseline, populates it, then applies everything
// after — the shape of `docker compose up` against an owner's or production's
// existing database.
const BASELINE = "0044_source_presence_unverified";

describe("migrations · upgrade of a POPULATED database", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let baselineDir: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();

    baselineDir = await mkdtemp(path.join(tmpdir(), "nominara-populated-"));
    for (const entry of await readdir(MIGRATIONS_DIR)) {
      if (entry.slice(0, 4) <= BASELINE.slice(0, 4)) {
        await copyFile(path.join(MIGRATIONS_DIR, entry), path.join(baselineDir, entry));
      }
    }
  }, 120_000);

  afterAll(async () => {
    await client?.end();
    await container?.stop();
    if (baselineDir) await rm(baselineDir, { recursive: true, force: true });
  });

  async function seedBaseline(): Promise<void> {
    await client.query(`
      INSERT INTO plans (key, display_name, monthly_price, annual_price, entitlements)
        VALUES ('free', 'Free', 0, 0, '{}') ON CONFLICT (key) DO NOTHING;
      INSERT INTO users (id, email) VALUES
        ('00000000-0000-7000-8000-0000000000a1', 'a@example.test'),
        ('00000000-0000-7000-8000-0000000000a2', 'b@example.test');
      INSERT INTO workspaces (id, name, slug, plan_key)
        VALUES ('00000000-0000-7000-8000-0000000000b1', 'Pop WS', 'pop-ws', 'free');
      INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
        VALUES ('00000000-0000-7000-8000-0000000000c1', '00000000-0000-7000-8000-0000000000b1',
                'P', 'p', 'https://example.test', 'example.test');
      INSERT INTO source_domains (id, workspace_id, domain)
        VALUES ('00000000-0000-7000-8000-0000000000d1', '00000000-0000-7000-8000-0000000000b1', 'example.test');
      INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days)
        SELECT '00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000c1',
               '00000000-0000-7000-8000-0000000000d1', 'engine_' || g, DATE '2026-01-01', 30
          FROM generate_series(1, 10) g;
      INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id,
                                 stripe_subscription_id, status, current_period_start, current_period_end)
        VALUES ('00000000-0000-7000-8000-0000000000b1', 'free', 'monthly', 'cus_x', 'sub_x', 'active', now(), now());
      INSERT INTO geo_analyses (workspace_id, project_id, analysis, window_start, window_days)
        VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000c1',
                'alignment', DATE '2026-01-01', 30);
      INSERT INTO brand_themes (id, workspace_id)
        VALUES ('00000000-0000-7000-8000-0000000000e1', '00000000-0000-7000-8000-0000000000b1');
      INSERT INTO share_tokens (id, workspace_id, label, token_hash, token_prefix, scope_project_ids,
                                scope_tabs, theme_id, created_by)
        VALUES ('00000000-0000-7000-8000-0000000000f1', '00000000-0000-7000-8000-0000000000b1', 'legacy',
                '\\x01', 'pfx', ARRAY['00000000-0000-7000-8000-0000000000c1']::uuid[],
                ARRAY['overview','tracking','aux']::text[], '00000000-0000-7000-8000-0000000000e1',
                '00000000-0000-7000-8000-0000000000a1');
      INSERT INTO share_token_views (workspace_id, share_token_id)
        VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000f1');
      INSERT INTO scheduled_reports (id, workspace_id, name, project_ids, cadence, recipients)
        VALUES ('00000000-0000-7000-8000-000000000101', '00000000-0000-7000-8000-0000000000b1', 'r',
                ARRAY['00000000-0000-7000-8000-0000000000c1']::uuid[], 'weekly', ARRAY['a@example.test']::citext[]);
      INSERT INTO report_artifacts (workspace_id, scheduled_report_id, project_ids, period_start, period_end,
                                    format, object_key, bytes, methodology_footer, expires_at)
        VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-000000000101',
                ARRAY['00000000-0000-7000-8000-0000000000c1']::uuid[], DATE '2026-01-01', DATE '2026-01-31',
                'pdf', 'k', 1, '{}', now() + interval '1 day');
      INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at)
        VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000a1',
                '00000000-0000-7000-8000-0000000000a2', 'metadata', 'j', 't', now() + interval '1 hour');
      INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title)
        VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000c1', now(),
                'competitor_added', 'm');
      INSERT INTO displacement_events (workspace_id, project_id, prompt_id, engine_key, kind,
                                       before_result_id, after_result_id, displaced_by)
        VALUES ('00000000-0000-7000-8000-0000000000b1', '00000000-0000-7000-8000-0000000000c1',
                gen_random_uuid(), 'e', 'presence_lost', gen_random_uuid(), gen_random_uuid(), '[]');
    `);
  }

  it("applies 0045..latest over a populated 0044 database without tripping the additive guard", async () => {
    const baseline = await migrateUp(client, baselineDir);
    expect(baseline.at(-1)).toBe(BASELINE);
    await seedBaseline();

    const all = await listMigrationFiles();
    const expectedPending = all.map((f) => f.name).filter((n) => n.slice(0, 4) > BASELINE.slice(0, 4));
    expect(expectedPending.length).toBeGreaterThan(0);

    const applied = await migrateUp(client);
    expect(applied).toEqual(expectedPending);

    // The 10 existing rows survive and take the column defaults.
    const psi = await client.query(
      `SELECT count(*)::int AS n, bool_and(is_competitor_owned = false) AS comp,
              bool_and(scoring_version = 'v1') AS ver FROM project_source_index`,
    );
    expect(psi.rows[0]).toEqual({ n: 10, comp: true, ver: true });

    // 0051's backfill remapped the legacy scope_tabs on the existing row.
    const tabs = await client.query(`SELECT scope_tabs FROM share_tokens WHERE label = 'legacy'`);
    expect(tabs.rows[0].scope_tabs).not.toContain("tracking");
    expect(tabs.rows[0].scope_tabs).not.toContain("aux");
  }, 180_000);
});
