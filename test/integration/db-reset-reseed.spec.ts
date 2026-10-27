import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyDevCredentials, resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { resetDatabase } from "../../src/db/reset-database.js";
import { SYNTHETIC_TENANTS } from "../../src/db/seed/synthetic/constants.js";
import { runSyntheticSeed, type SyntheticSeedPool, type SyntheticSeedPoolClient } from "../../src/db/seed/synthetic/seed-tenants.js";
import { planSetViaCli } from "../../src/db/seed/synthetic/plan-set-cli.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { planSetChildEnv } from "../support/seed-plan-set-env.js";
import { testDek } from "../support/test-dek.js";

// STORY-004 AC7 / test scenario 5 ("Run the reset command -> a clean
// database, then a successful re-seed"). `resetDatabase` is what `pnpm
// db:reset` runs; `applyDevCredentials` is what `pnpm db:dev-credentials`
// runs. The database is deliberately left DIRTY first (seeded, plus a stray
// table and a row the migrations never write) so "clean" means something.

describe("STORY-004 · db:reset then db:seed (scenario 5)", () => {
  let container: StartedPostgreSqlContainer;
  const dekProvisioner = new LocalDekProvisioner(testDek("story-004-reset"), "local:dev");

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 300_000);

  afterAll(async () => {
    await container.stop();
  });

  function appPool(): SyntheticSeedPool {
    return {
      async connect(): Promise<SyntheticSeedPoolClient> {
        const app = new Client({
          host: container.getHost(),
          port: container.getMappedPort(5432),
          database: container.getDatabase(),
          user: "nominara_app",
          password: resolvePassword("nominara_app", {}),
        });
        await app.connect();
        return Object.assign(app, { release: () => void app.end() });
      },
    };
  }

  const setPlan = () => planSetViaCli(planSetChildEnv(container.getHost(), container.getMappedPort(5432), container.getDatabase()));

  async function count(client: Client, sql: string): Promise<number> {
    const result = await client.query<{ n: string }>(sql);
    return Number(result.rows[0]!.n);
  }

  it("STORY-004 AC7 · reset drops everything and re-applies every migration; the seed then succeeds", async () => {
    const client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    try {
      // A half-used local database: migrated, credentialed, seeded, plus debris.
      await migrateUp(client);
      await applyDevCredentials(client, {});
      await runSyntheticSeed({ pool: appPool(), dekProvisioner, setPlan: setPlan(), log: () => {} });
      await client.query("CREATE TABLE public.stray_debris (id int)");
      await client.query(`INSERT INTO users (id, email, status) VALUES (gen_random_uuid(), 'stray@example.test', 'active')`);
      expect(await count(client, "SELECT count(*)::text AS n FROM workspaces")).toBe(3);

      const applied = await resetDatabase(client);

      const migrations = await count(client, "SELECT count(*)::text AS n FROM _migrations.applied");
      expect(applied).toBeGreaterThan(0);
      expect(migrations).toBe(applied);
      expect(await count(client, "SELECT count(*)::text AS n FROM workspaces")).toBe(0);
      expect(await count(client, "SELECT count(*)::text AS n FROM credit_ledger")).toBe(0);
      expect(await count(client, "SELECT count(*)::text AS n FROM users WHERE email = 'stray@example.test'")).toBe(0);
      expect(await count(client, "SELECT count(*)::text AS n FROM pg_tables WHERE tablename = 'stray_debris'")).toBe(0);

      await applyDevCredentials(client, {});
      const outcomes = await runSyntheticSeed({ pool: appPool(), dekProvisioner, setPlan: setPlan(), log: () => {} });

      expect(outcomes.map((outcome) => outcome.workspaceCreated)).toEqual([true, true, true]);
      expect(await count(client, "SELECT count(*)::text AS n FROM workspaces")).toBe(SYNTHETIC_TENANTS.length);
      expect(await count(client, "SELECT count(*)::text AS n FROM credit_ledger WHERE entry_type = 'grant'")).toBe(SYNTHETIC_TENANTS.length);
    } finally {
      await client.end();
    }
  }, 240_000);
});
