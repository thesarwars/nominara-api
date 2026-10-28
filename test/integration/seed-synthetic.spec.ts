import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import {
  SYNTHETIC_GRANT_AUDIT_ACTION,
  SYNTHETIC_GRANT_CREDITS,
  SYNTHETIC_GRANT_IDEMPOTENCY_KEY,
  SYNTHETIC_TENANTS,
} from "../../src/db/seed/synthetic/constants.js";
import { runSyntheticSeed, type SyntheticSeedPool, type SyntheticSeedPoolClient } from "../../src/db/seed/synthetic/seed-tenants.js";
import { verifyWorkspaceWallet } from "../../src/lib/credits/replay.js";
import { promptTextHash } from "../../src/lib/promptgen/text-hash.js";
import { readWallet } from "../../src/lib/credits/wallet.js";
import { planSetViaCli } from "../../src/db/seed/synthetic/plan-set-cli.js";
import { LocalDekProvisioner } from "../../src/modules/workspaces/adapters/local-dek-provisioner.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { verifyWorkspaceChain } from "../../src/workers/rollup/audit-verify.js";
import { planSetChildEnv } from "../support/seed-plan-set-env.js";
import { testDek } from "../support/test-dek.js";

// STORY-004 AC5 / test scenario 4 ("Run the seed twice -> idempotent; no
// duplicate tenants"), end to end against a real Postgres, writing as the
// real runtime role. RLS/tenant context and the credit ledger are two of the
// four dangerous areas, so every write under test goes through `nominara_app`
// (`testPool()`), never the superuser fixture connection, which would pass
// vacuously against RLS. `client` (superuser) only sets up and READS.

describe("STORY-004 · db:seed — three awkward synthetic tenants (scenario 4)", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  const dekProvisioner = new LocalDekProvisioner(testDek("story-004-seed"), "local:dev");

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

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(resolvePassword(role, {}))}`);
    }
  });

  afterEach(async () => {
    await client.end();
  });

  function testPool(): SyntheticSeedPool {
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

  function superuserPool(): SyntheticSeedPool {
    return {
      async connect(): Promise<SyntheticSeedPoolClient> {
        const superuser = new Client({ connectionString: container.getConnectionUri() });
        await superuser.connect();
        return Object.assign(superuser, { release: () => void superuser.end() });
      },
    };
  }

  const seed = (pool: SyntheticSeedPool = testPool()) =>
    runSyntheticSeed({ pool, dekProvisioner, setPlan: planSetViaCli(planSetChildEnv(container.getHost(), container.getMappedPort(5432), container.getDatabase())), log: () => {} });

  const workspaceIds = SYNTHETIC_TENANTS.map((tenant) => tenant.workspaceId);

  /** Row counts of every table the seed writes, scoped to the synthetic workspaces. */
  async function snapshot(): Promise<Record<string, number>> {
    const scoped = [
      "workspaces",
      "workspace_keys",
      "workspace_members",
      "subscriptions",
      "projects",
      "tracked_prompts",
      "competitors",
      "credit_wallets",
      "credit_ledger",
      "audit_log",
    ];
    const counts: Record<string, number> = {};
    for (const table of scoped) {
      const column = table === "workspaces" ? "id" : "workspace_id";
      const result = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE ${column} = ANY($1::uuid[])`, [
        workspaceIds,
      ]);
      counts[table] = Number(result.rows[0]!.n);
    }
    const users = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE email LIKE '%@nominara.test'`);
    counts.users = Number(users.rows[0]!.n);
    return counts;
  }

  it("STORY-004 AC5 · seeds three workspaces, one per paid tier, each owned by its nominara.test owner", async () => {
    await seed();

    for (const tenant of SYNTHETIC_TENANTS) {
      const ws = await client.query<{ plan_key: string; slug: string }>(`SELECT plan_key, slug::text AS slug FROM workspaces WHERE id = $1`, [
        tenant.workspaceId,
      ]);
      expect(ws.rows[0], tenant.key).toEqual({ plan_key: tenant.planKey, slug: tenant.slug });

      const sub = await client.query<{ plan_key: string; status: string }>(
        `SELECT plan_key, status FROM subscriptions WHERE workspace_id = $1`,
        [tenant.workspaceId],
      );
      expect(sub.rows, `${tenant.key} subscription`).toEqual([{ plan_key: tenant.planKey, status: "active" }]);

      const owner = await client.query<{ email: string; role: string; status: string; user_status: string }>(
        `SELECT u.email, m.role, m.status, u.status AS user_status
           FROM workspace_members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1`,
        [tenant.workspaceId],
      );
      expect(owner.rows, `${tenant.key} members`).toEqual([{ email: tenant.ownerEmail, role: "owner", status: "active", user_status: "active" }]);

      const keys = await client.query(`SELECT 1 FROM workspace_keys WHERE workspace_id = $1`, [tenant.workspaceId]);
      expect(keys.rowCount, `${tenant.key} DEK`).toBe(1);
    }
  }, 120_000);

  it("STORY-004 AC5 · the plan is set through the real plan:set path: one audited workspace.plan_changed per tenant", async () => {
    await seed();
    for (const tenant of SYNTHETIC_TENANTS) {
      const rows = await client.query<{ action: string; plan_key: string }>(
        `SELECT action, after_state->>'plan_key' AS plan_key FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.plan_changed'`,
        [tenant.workspaceId],
      );
      expect(rows.rows, tenant.key).toEqual([{ action: "workspace.plan_changed", plan_key: tenant.planKey }]);
    }
  }, 120_000);

  it("STORY-004 AC5 · writes the four awkward shapes", async () => {
    await seed();

    const single = await client.query<{ name: string; prompts: string; prompts_active: number }>(
      `SELECT p.name, p.prompts_active, (SELECT count(*) FROM tracked_prompts t WHERE t.project_id = p.id AND t.deleted_at IS NULL)::text AS prompts
         FROM projects p WHERE p.name = 'Acme Single'`,
    );
    expect(single.rows).toEqual([{ name: "Acme Single", prompts: "1", prompts_active: 1 }]);

    const brands = await client.query<{ name: string }>(
      `SELECT name FROM projects WHERE workspace_id = ANY($1::uuid[]) AND status = 'active' AND deleted_at IS NULL ORDER BY name`,
      [workspaceIds],
    );
    expect(brands.rows.map((row) => row.name)).toEqual(["Acme Single", "Apple", "Blue Ocean Roasters", "Nimbus Hosting"]);

    const pair = await client.query<{ name: string }>(
      `SELECT c.name FROM competitors c JOIN projects p ON p.id = c.project_id
        WHERE p.name = 'Nimbus Hosting' AND c.deleted_at IS NULL ORDER BY c.name`,
    );
    expect(pair.rows.map((row) => row.name)).toEqual(["Cloud", "Cloudflare Systems"]);

    // Every seeded prompt is activated-and-free (STORY-046's activation fact), never an orphan the charge rule has no fact for.
    const orphans = await client.query(
      `SELECT 1 FROM tracked_prompts WHERE workspace_id = ANY($1::uuid[]) AND (first_activated_at IS NULL OR activation_credits <> 0)`,
      [workspaceIds],
    );
    expect(orphans.rowCount).toBe(0);
  }, 120_000);

  it("STORY-004 AC5 · each tenant gets exactly one 500-credit grant through the ledger, audited, and the wallet replays clean", async () => {
    await seed();

    for (const tenant of SYNTHETIC_TENANTS) {
      const ledger = await client.query<{ entry_type: string; credits: number; idempotency_key: string }>(
        `SELECT entry_type, credits, idempotency_key FROM credit_ledger WHERE workspace_id = $1 ORDER BY seq`,
        [tenant.workspaceId],
      );
      expect(ledger.rows, `${tenant.key} ledger`).toEqual([
        { entry_type: "grant", credits: SYNTHETIC_GRANT_CREDITS, idempotency_key: SYNTHETIC_GRANT_IDEMPOTENCY_KEY },
      ]);

      const audit = await client.query<{ credits: string }>(
        `SELECT after_state->>'credits' AS credits FROM audit_log WHERE workspace_id = $1 AND action = $2`,
        [tenant.workspaceId, SYNTHETIC_GRANT_AUDIT_ACTION],
      );
      expect(audit.rows, `${tenant.key} grant audit`).toEqual([{ credits: String(SYNTHETIC_GRANT_CREDITS) }]);

      const app = await testPool().connect();
      try {
        await withTenantContext(app, { workspaceId: tenant.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          const wallet = await readWallet(tx, tenant.workspaceId);
          expect(wallet?.available, `${tenant.key} available`).toBe(SYNTHETIC_GRANT_CREDITS);
          expect(await verifyWorkspaceWallet(tx, tenant.workspaceId), `${tenant.key} replay`).toBeNull();
        });
      } finally {
        app.release();
      }

      expect(await verifyWorkspaceChain(client, tenant.workspaceId), `${tenant.key} audit chain`).toBeNull();
    }
  }, 120_000);

  it("STORY-004 scenario 4 · running the seed twice duplicates nothing and never grants twice", async () => {
    const first = await seed();
    const afterFirst = await snapshot();
    const second = await seed();
    const afterSecond = await snapshot();

    expect(afterSecond).toEqual(afterFirst);
    expect(afterFirst.workspaces).toBe(3);
    expect(afterFirst.users).toBe(3);
    expect(first.every((outcome) => outcome.workspaceCreated && outcome.granted && outcome.planChanged)).toBe(true);
    expect(
      second.every(
        (outcome) =>
          !outcome.workspaceCreated &&
          !outcome.granted &&
          !outcome.planChanged &&
          outcome.projectsCreated === 0 &&
          outcome.promptsCreated === 0 &&
          outcome.competitorsCreated === 0,
      ),
    ).toBe(true);
  }, 180_000);

  it("STORY-004 AC5 · reuses an existing account at an owner address instead of creating a second user", async () => {
    const tenant = SYNTHETIC_TENANTS[0]!;
    // The shape email-OTP sign-up leaves behind: an unverified row, no workspace.
    await client.query(`INSERT INTO users (id, email, status) VALUES (gen_random_uuid(), $1, 'unverified')`, [tenant.ownerEmail]);

    await seed();

    const users = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM users WHERE email = $1`, [tenant.ownerEmail]);
    expect(users.rows[0]!.n).toBe("1");
    const owner = await client.query(
      `SELECT 1 FROM workspace_members m JOIN users u ON u.id = m.user_id WHERE m.workspace_id = $1 AND u.email = $2 AND m.role = 'owner'`,
      [tenant.workspaceId, tenant.ownerEmail],
    );
    expect(owner.rowCount).toBe(1);
  }, 120_000);

  // schemas/projects-and-prompts.md: text_hash is sha256(normalise(text)), the dedupe key behind ux_prompts_project_hash.
  // A seeded row hashed any other way never dedupes against the same question added through the API.
  it("STORY-004 AC5 · every seeded prompt carries the schema's text_hash, sha256(normalise(text)), so API dedupe sees it", async () => {
    await seed();
    const rows = await client.query<{ text: string; text_hash: Buffer }>(
      `SELECT text, text_hash FROM tracked_prompts WHERE workspace_id = ANY($1::uuid[]) ORDER BY text`,
      [workspaceIds],
    );
    const expected = SYNTHETIC_TENANTS.flatMap((tenant) => tenant.projects.flatMap((project) => project.prompts)).length;
    expect(rows.rows).toHaveLength(expected);
    for (const row of rows.rows) {
      expect(row.text_hash.toString("hex"), row.text).toBe(promptTextHash(row.text).bytes.toString("hex"));
    }
  }, 120_000);

  it("STORY-004 AC5 · refuses to attach a workspace to a suspended account at an owner address, writing nothing", async () => {
    const tenant = SYNTHETIC_TENANTS[0]!;
    await client.query(`INSERT INTO users (id, email, status, email_verified_at) VALUES (gen_random_uuid(), $1, 'suspended', now())`, [
      tenant.ownerEmail,
    ]);

    await expect(seed()).rejects.toThrow(/suspended/u);

    const counts = await snapshot();
    expect(counts.workspaces).toBe(0);
    expect(counts.workspace_members).toBe(0);
  }, 120_000);

  // Two seeds at once: the other run has inserted "Cloud" and not yet committed. ux_competitors_project_name makes this
  // run's insert wait for it; once it commits, this run must treat the name as present, not fail on the unique index
  // or write a second row.
  it("STORY-004 scenario 4 · a seed racing another seed's uncommitted competitor waits, then writes no second row and does not fail", async () => {
    await seed();
    const business = SYNTHETIC_TENANTS.find((tenant) => tenant.projects.some((project) => project.name === "Nimbus Hosting"))!;
    const nimbus = business.projects.find((project) => project.name === "Nimbus Hosting")!;
    const cloud = nimbus.competitors.find((competitor) => competitor.name === "Cloud")!;
    // Leave the project as a first run would find it mid-way: prompts present, competitors not yet.
    await client.query(`UPDATE competitors SET deleted_at = now() WHERE project_id = $1`, [nimbus.id]);

    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      await other.query("BEGIN");
      await other.query(
        `INSERT INTO competitors (id, workspace_id, project_id, name, root_domain, aliases, source, is_primary)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, ARRAY[]::text[], 'user', true)`,
        [business.workspaceId, nimbus.id, cloud.name, cloud.rootDomain],
      );

      let done = false;
      const racing = seed().finally(() => {
        done = true;
      });
      racing.catch(() => {});
      // Wait until this run is blocked behind the other's uncommitted row (or has finished without waiting).
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (done) break;
        const waiting = await client.query(`SELECT 1 FROM pg_locks WHERE NOT granted AND locktype = 'transactionid'`);
        if ((waiting.rowCount ?? 0) > 0) break;
        if (Date.now() > deadline) throw new Error("the racing seed neither finished nor waited within 60s");
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await other.query("COMMIT");

      await expect(racing).resolves.toBeDefined();
    } finally {
      await other.end();
    }

    const live = await client.query<{ name: string }>(
      `SELECT name FROM competitors WHERE project_id = $1 AND deleted_at IS NULL ORDER BY name`,
      [nimbus.id],
    );
    expect(live.rows.map((row) => row.name)).toEqual(["Cloud", "Cloudflare Systems"]);
  }, 180_000);

  it("STORY-004 AC5 · refuses a pooled connection that is not nominara_app, before writing anything", async () => {
    await expect(seed(superuserPool())).rejects.toThrow(/not nominara_app/u);
    const counts = await snapshot();
    expect(counts.workspaces).toBe(0);
    expect(counts.users).toBe(0);
  }, 120_000);
});
