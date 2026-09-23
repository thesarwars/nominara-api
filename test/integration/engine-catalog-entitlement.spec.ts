import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { resolveEnabledEngines } from "../../src/lib/capture/plan-cells.js";
import { resolveDueEngines } from "../../src/lib/capture/engine-cadence.js";
import { captureReadyEngineKeys } from "../../src/lib/engines/registry.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-152 — THE TEST THE STORY EXISTS FOR.
//
// ⚠ NOTHING HERE SEEDS `engines`, AND THAT IS THE POINT. Nineteen existing
// spec files hand-write `INSERT INTO engines`, which is exactly how the empty
// catalog survived: every test built the world the product could not. The rows
// under test come from migration 0027, through `migrateUp`, the same way they
// arrive in production.
//
// ⚠ AND NOTHING HERE WRITES `project_engines` EITHER. There is no writer, by
// design — the entitled set is derived per read from the catalog and the plan.
describe("STORY-152 · a project resolves its engines from the catalog", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    const uri = new URL(container.getConnectionUri());
    uri.username = "nominara_app";
    uri.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: uri.toString(), max: 8 });
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  /** Mirrors WorkspacesService.create, then puts the workspace on `plan`. */
  async function projectOnPlan(plan: string): Promise<{ workspaceId: string; projectId: string }> {
    const workspaceId = uuidV7();
    await db.query(
      `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key)
       VALUES ($1,$2,$3,'in_house','us-east-1','UTC',$4)`,
      [workspaceId, `ws-${workspaceId}`, `ws-${workspaceId}`, plan],
    );
    const projectId = uuidV7();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1,$2,'Acme',$3,'https://acme.test','acme.test')`,
      [projectId, workspaceId, `acme-${projectId}`],
    );
    return { workspaceId, projectId };
  }

  /**
   * What the project is ENTITLED to — the view, read as the app role.
   *
   * ⚠ NOT `resolveEnabledEngines`, AND THE SPLIT IS THE POINT. That function
   * returns entitlement ∩ capture-ready, and nothing is capture-ready in this
   * build (see `capture-ready` below). Testing entitlement through it would
   * assert [] everywhere and prove nothing about the catalog.
   */
  async function enginesFor(workspaceId: string, projectId: string): Promise<string[]> {
    const client = await pool.connect();
    try {
      const rows = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        tx.query<{ engine_key: string }>(
          "SELECT engine_key FROM project_entitled_engines WHERE project_id = $1 AND enabled ORDER BY engine_key",
          [projectId],
        ),
      );
      return rows.rows.map((row) => row.engine_key);
    } finally {
      client.release();
    }
  }

  /** What a capture could actually be attempted on. */
  async function capturableFor(workspaceId: string, projectId: string): Promise<string[]> {
    const client = await pool.connect();
    try {
      const resolved = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        resolveEnabledEngines(tx, projectId),
      );
      return resolved.map((engine) => engine.engineKey).sort();
    } finally {
      client.release();
    }
  }

  // ⚠ THE ACCEPTANCE CRITERION. Before this story `resolveEnabledEngines`
  // returned [] for EVERY real project — `project_engines` had no production
  // writer — so a run was planned with zero cells and no scheduled tracking
  // run had ever been possible.
  it.each([
    ["starter", ["chatgpt", "google_aio", "perplexity"]],
    ["growth", ["chatgpt", "google_ai_mode", "google_aio", "perplexity"]],
    ["business", ["chatgpt", "claude", "gemini", "google_ai_mode", "google_aio", "perplexity"]],
  ])("a %s project resolves its entitled engines with no rows written anywhere", async (plan, expected) => {
    const { workspaceId, projectId } = await projectOnPlan(plan);
    expect(await enginesFor(workspaceId, projectId)).toEqual(expected);
  });

  // ⚠ THE TWO HALVES OF "TOOLS ONLY", AND THE FIRST DRAFT OF THIS VIEW GOT IT
  // WRONG — WHICH IS WHY BOTH ARE ASSERTED IN ONE TEST.
  //
  // STORY-130 §57: free gets NO key in any `cadence_by_plan`, so free
  // "never *schedules* either engine — which is what 'tools only' means:
  // reachable on demand from the tools surface, never on a cadence. The
  // distinction is then carried by `min_plan_key`, not by the cadence map."
  //
  // So free is ENTITLED to the two engines whose floor is `free`, and is due
  // ZERO of them. The view briefly also required `cadence_by_plan ? plan_key`,
  // which collapsed those into one and returned [] here — a free workspace
  // entitled to nothing, which is the unenterable product STORY-151 had just
  // finished fixing. Splitting them back apart is the fix; this test is what
  // stops them being merged again, because either half alone still passes.
  it("a free project is entitled to the tools-only engines and is due none of them", async () => {
    const { workspaceId, projectId } = await projectOnPlan("free");

    expect(await enginesFor(workspaceId, projectId), "min_plan_key 'free' is what the tools surface reaches").toEqual([
      "chatgpt",
      "perplexity",
    ]);

    const client = await pool.connect();
    try {
      for (const kind of ["full", "priority"] as const) {
        const due = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
          resolveDueEngines(tx, { projectId, kind, now: new Date() }),
        );
        expect(due, `free has no ${kind} cadence, so the scheduler must pick up nothing`).toEqual([]);
      }
    } finally {
      client.release();
    }
  });

  // ⚠ THE COUNT MATCHES THE PUBLISHED CLAIM, TIER BY TIER. `engines.enabled`
  // has two writes in src/ and ZERO readers — it ships to customers in the
  // entitlements response and is honoured by nobody. This is its first
  // enforcement, and it is structural: nothing checks the number, the number
  // falls out of `min_plan_key` against the plan's `sort_order` and nothing
  // else. Free is in the list because "2" is a claim too — it is the tier
  // whose count a cadence predicate silently turned into 0.
  it.each([
    ["free", 2], ["starter", 3], ["growth", 4], ["business", 6], ["enterprise", 6],
  ])("the %s tier resolves exactly the %i engines its plan sells", async (plan, count) => {
    const { workspaceId, projectId } = await projectOnPlan(plan);
    expect((await enginesFor(workspaceId, projectId)).length).toBe(count);
  });

  // ⚠ THE SAFETY PROPERTY, AND IT IS STRUCTURAL RATHER THAN A CHECK. The
  // view's driving table is `engines` and `project_engines` enters through a
  // LEFT JOIN, so a row for an engine the plan does not buy has nothing to
  // attach to. Under a design that WRITES rows, this row would have granted a
  // starter project a business engine.
  it("an override row cannot ADD an engine the plan does not sell", async () => {
    const { workspaceId, projectId } = await projectOnPlan("starter");
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, weight, sample_count)
       VALUES ($1,$2,'claude',true,1.0,1)`,
      [workspaceId, projectId],
    );
    expect(await enginesFor(workspaceId, projectId), "claude is a business engine").toEqual(
      ["chatgpt", "google_aio", "perplexity"],
    );
  });

  it("an override row CAN narrow the entitled set", async () => {
    const { workspaceId, projectId } = await projectOnPlan("growth");
    await db.query(
      `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, weight, sample_count)
       VALUES ($1,$2,'perplexity',false,1.0,1)`,
      [workspaceId, projectId],
    );
    expect(await enginesFor(workspaceId, projectId)).toEqual(["chatgpt", "google_ai_mode", "google_aio"]);
  });

  // ⚠ AN UPGRADE WIDENS COVERAGE WITH NO BACKFILL, which is the whole argument
  // for deriving. STORY-151 made plan changes possible; under a rows design
  // every one of them would need a re-derivation somebody has to remember.
  it("an upgrade widens the set immediately, with nothing to backfill", async () => {
    const { workspaceId, projectId } = await projectOnPlan("starter");
    expect((await enginesFor(workspaceId, projectId)).length).toBe(3);

    await db.query("UPDATE workspaces SET plan_key = 'business' WHERE id = $1", [workspaceId]);

    expect((await enginesFor(workspaceId, projectId)).length, "no writer ran, and the set widened").toBe(6);
  });

  // ⚠ A CADENCE KEY CANNOT GRANT ENTITLEMENT. This is the other direction of
  // the free-tier test above, and together they fix the cadence map's meaning
  // from both sides: a MISSING key does not revoke entitlement (free is
  // entitled to two engines it never schedules), and a PRESENT key does not
  // confer it (a starter cadence on a business engine sells nothing).
  //
  // The hazard is real rather than theoretical. Cadence changes are
  // hand-written migrations, and the first draft of this view AND-ed the
  // cadence key into the entitlement test, so a stray key was one edit away
  // from selling a business engine at starter prices. The floor is now the
  // only thing that decides, and this is what says so.
  //
  // Mutation-checked: deleting `engine_plan.sort_order <= workspace_plan.
  // sort_order` from the view fails ten of these tests, this one among them.
  //
  // It is worth recording that it once failed ONLY this one. While the view
  // also AND-ed in `cadence_by_plan ? plan_key`, that predicate excluded
  // everything the floor would have — a correctly seeded catalog gives no
  // engine a cadence key below its own floor — so the floor was dead code
  // that nine tests could not see. Removing the cadence predicate is what
  // made the floor load-bearing. This test is the one that did not depend on
  // that, because it seeds the contradiction by hand.
  it("⚠ refuses an engine whose cadence key contradicts its own plan floor", async () => {
    // ⚠ AN EXISTING KEY, MISSEEDED — not a new one. `engines_key_check`
    // restricts the column to the ten permitted keys, which is itself a real
    // control: the catalog is closed, so a wrong catalog is a wrong VALUE on a
    // right key, and that is exactly the hazard this models. `claude` is a
    // business engine; give it a starter cadence and see whether the floor
    // still holds.
    const original = await db.query<{ cadence_by_plan: unknown }>(
      "SELECT cadence_by_plan FROM engines WHERE key = 'claude'",
    );
    await db.query(
      `UPDATE engines SET cadence_by_plan = cadence_by_plan || '{"starter":{"full":4}}'::jsonb
        WHERE key = 'claude'`,
    );
    try {
      const { workspaceId, projectId } = await projectOnPlan("starter");
      expect(
        await enginesFor(workspaceId, projectId),
        "a starter cadence key must not defeat claude's business floor",
      ).toEqual(["chatgpt", "google_aio", "perplexity"]);
    } finally {
      await db.query("UPDATE engines SET cadence_by_plan = $1 WHERE key = 'claude'", [
        JSON.stringify(original.rows[0]!.cadence_by_plan),
      ]);
    }
  });

  // The view is security_invoker, so RLS applies as the querying role. Without
  // it the view would run as its owner and be a cross-tenant read.
  it("does not leak another tenant's project", async () => {
    const mine = await projectOnPlan("business");
    const theirs = await projectOnPlan("business");
    const client = await pool.connect();
    try {
      const rows = await withTenantContext(client, { workspaceId: mine.workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        tx.query<{ project_id: string }>("SELECT DISTINCT project_id FROM project_entitled_engines"),
      );
      expect(rows.rows.map((r) => r.project_id)).toEqual([mine.projectId]);
      expect(rows.rows.map((r) => r.project_id)).not.toContain(theirs.projectId);
    } finally {
      client.release();
    }
  });

  // ⚠ ENTITLED AND CAPTURABLE ARE DIFFERENT, AND TODAY THEY DISAGREE
  // COMPLETELY. Every active engine is bound to a fixture adapter that matches
  // six hard-coded prompt strings by exact equality, so none of them can answer
  // a real project's generated prompt.
  //
  // This is the decision that kept STORY-152 from making the product worse.
  // Seeding the catalog turns the scheduler on; without this filter a cell
  // would be planned for an engine that cannot answer, the fixture adapter
  // would throw a bare Error, the transaction would unwind so that NO capture
  // row of any status survived, all five retries would burn, and every cell
  // would land in the dead-letter queue — behind a healthProbe() that returns
  // ok unconditionally, so the engine board would stay green throughout.
  //
  // The alternative was a ninth failure code recording the attempt. Rejected:
  // tracking-engine.md §2 says the taxonomy is "Fixed, because the circuit
  // breaker and retry ladder branch on it", and the matrix would have rendered
  // "We asked and no answer came back" for an engine we never asked.
  describe("capture-ready", () => {
    it("a business project is entitled to six engines and can capture on NONE of them", async () => {
      const { workspaceId, projectId } = await projectOnPlan("business");

      expect(await enginesFor(workspaceId, projectId)).toHaveLength(6);
      expect(
        await capturableFor(workspaceId, projectId),
        "no vendor adapter exists in this repository — STORY-001 opens the accounts",
      ).toEqual([]);
    });

    it("the capture-ready set is derived from the registry, not listed", () => {
      // Empty today. When an adapter story binds a real adapter it flips its
      // own captureReady flag, and this becomes non-empty in the same commit —
      // which is why the set is derived rather than maintained by hand.
      expect(captureReadyEngineKeys()).toEqual([]);
    });
  });
});
