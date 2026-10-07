import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
          // ⚠ THE TWO ENTITLED KEYS ARE PASSED AS CAPTURE-READY ON PURPOSE.
          // `resolveDueEngines` now also filters on capture-readiness, whose
          // production value is EMPTY — so leaving this out would make the
          // assertion below pass because nothing is capture-ready, whether or
          // not the cadence rule works at all. Declaring them ready leaves
          // the MISSING FREE CADENCE as the only thing that can empty this.
          resolveDueEngines(tx, { projectId, kind, now: new Date() }, ["perplexity", "chatgpt"]),
        );
        expect(due, `free has no ${kind} cadence, so the scheduler must pick up nothing`).toEqual([]);
      }
    } finally {
      client.release();
    }
  });

  // ==========================================================================
  // ⚠ THE CATALOG IS DATA, AND DATA THAT NOTHING PINS IS DATA THAT DRIFTS.
  //
  // Everything else in this file tests the RULES over the catalog — the floor,
  // the override, the cadence. All of it would keep passing if somebody
  // changed a TTL from 28800 to 3600, or "corrected" a cadence back to a
  // figure the references state in a different vocabulary. These are
  // customer-visible and money-adjacent: `cache_ttl_seconds` decides whether a
  // cell is served from cache (and a cached cell is not charged), and
  // `cadence_by_plan` is the interval divisor the scheduler runs on.
  //
  // Each row cites the reference it was transcribed from. A future editor who
  // disagrees has to change a test that names its source, which is a decision,
  // instead of editing a migration nobody re-reads.
  // ==========================================================================
  describe("the seeded catalog matches the references, field for field", () => {
    // tracking-engine.md §3 (mode, TTL, fidelity) and plans-and-entitlements.md
    // §11 (the floor). TTLs there are stated in hours: 8/4/4/12/8/24.
    const ACTIVE = [
      ["perplexity", "Perplexity", "Perplexity", "api", 28800, "high", "free"],
      ["google_aio", "AI Overviews", "Google", "licensed_serp", 14400, "very_high", "starter"],
      ["google_ai_mode", "AI Mode", "Google", "licensed_serp", 14400, "very_high", "growth"],
      ["chatgpt", "ChatGPT", "OpenAI", "api", 43200, "high", "free"],
      ["gemini", "Gemini", "Google", "api", 28800, "high", "business"],
      ["claude", "Claude", "Anthropic", "api", 86400, "medium", "business"],
    ] as const;

    it.each(ACTIVE)(
      "%s is %s by %s — %s, ttl %i, %s volatility, sold from %s",
      async (key, displayName, vendor, captureMode, ttl, band, floor) => {
        const row = await db.query(
          `SELECT display_name, vendor, capture_mode, cache_ttl_seconds,
                  volatility_band, min_plan_key, status, adapter_version, model_fingerprint
             FROM engines WHERE key = $1`,
          [key],
        );
        expect(row.rows[0]).toMatchObject({
          display_name: displayName,
          vendor,
          capture_mode: captureMode,
          cache_ttl_seconds: ttl,
          volatility_band: band,
          min_plan_key: floor,
          status: "active",
          // Provenance, not a guess: each adapter story bumps its own version
          // in the commit that binds a real adapter, and the fingerprint is
          // vendor-reported at capture time.
          adapter_version: "0.1.0",
          model_fingerprint: null,
        });
      },
    );

    it("the four reserved keys exist and are disabled — status is the enabling mechanism", async () => {
      const rows = await db.query<{ key: string; status: string; cadence_by_plan: unknown }>(
        "SELECT key, status, cadence_by_plan FROM engines WHERE key = ANY($1::text[]) ORDER BY key",
        [["copilot", "deepseek", "grok", "meta_ai"]],
      );
      expect(rows.rows.map((r) => r.key)).toEqual(["copilot", "deepseek", "grok", "meta_ai"]);
      for (const row of rows.rows) {
        expect(row.status, `${row.key} must ship disabled`).toBe("disabled");
        expect(row.cadence_by_plan, `${row.key} is not scheduled by any plan`).toEqual({});
      }
    });

    // ⚠ NO ENGINE HAS A `free` KEY, AND THAT IS THE "TOOLS ONLY" TIER.
    // STORY-130 §57. Asserted over the whole table rather than per engine,
    // because the claim is about the catalog, not about any one row.
    it("no engine carries a free cadence — free schedules nothing at all", async () => {
      const withFree = await db.query<{ key: string }>(
        "SELECT key FROM engines WHERE cadence_by_plan ? 'free'",
      );
      expect(withFree.rows.map((r) => r.key)).toEqual([]);
    });

    // ⚠ THE ONE FIGURE THAT DEVIATES FROM A NUMBER PRINTED IN THE REFERENCES,
    // AND THE REASON IS ARITHMETIC RATHER THAN PREFERENCE.
    //
    // `schemas/captures-and-facts.md`:31's worked example shows
    // `"business":{"full":4,"priority":26}`. This column is a DIVISOR:
    // engine-cadence.ts computes `intervalMs = CYCLE_MS / runs_per_cycle`, so
    // 26 over a 30-day cycle is a 27.7-hour interval that slides ~4 hours a
    // day through the diurnal cycle that §5's jitter budget exists to protect.
    // 30 is one run a day, which is what §5's prose ("daily on the priority
    // subset") actually says.
    //
    // The two numbers are different vocabularies, not a contradiction, and
    // `plans.entitlements."scan.runs_per_cycle"` is deliberately left as
    // "4_full_plus_26_priority": 4 full-set days plus 26 priority-only days
    // IS 30 run-days. Nothing needs correcting there.
    it("business priority cadence is 30 — a divisor, not a run-day count", async () => {
      const row = await db.query<{ priority: string | null }>(
        "SELECT cadence_by_plan -> 'business' ->> 'priority' AS priority FROM engines WHERE key = 'perplexity'",
      );
      expect(row.rows[0]?.priority).toBe("30");
    });

    it("enterprise is 720 priority and 30 full-set, per §5", async () => {
      const row = await db.query<{ cadence: { full: number; priority: number } }>(
        "SELECT cadence_by_plan -> 'enterprise' AS cadence FROM engines WHERE key = 'perplexity'",
      );
      // STORY-130's draft proposed {"full":4,"priority":720}; §5 says
      // "720 priority + 30 full-set". Transcription error, caught and seeded
      // as 30.
      expect(row.rows[0]?.cadence).toEqual({ full: 30, priority: 720 });
    });

    // ⚠ AND THE DATABASE REFUSES TO STORE ONE THAT WOULD NOT. Seeding the
    // catalog armed a cast that was dormant while `engines` was empty:
    // `(cadence ->> kind)::int` does not fail closed on a non-integer, it
    // RAISES, and the raise reaches the customer as a 500 on the whole
    // Project Overview — not merely a missing cadence. `cadence_by_plan` is
    // edited by hand-written operator migrations, which is exactly where a
    // "4.5" comes from.
    // ⚠ THE FIRST VERSION OF THIS LIST WAS WRITTEN FROM THE IMPLEMENTATION
    // AND SO REPRODUCED ITS BLIND SPOT. It asserted exactly the three inputs
    // the constraint caught, and the constraint tested "is an integral JSON
    // number" rather than "does ::int accept this text". A review found two
    // values in the gap by trying them, and both still 500'd the Project
    // Overview: `4.0`, which is how an operator most naturally writes a
    // cadence in JSON, and an integer too large for int4.
    //
    // The list is now written from the CAST's contract — the cases are the
    // ways `'<text>'::int` can fail — rather than from what the function
    // happens to check. The last two are the regression cases.
    it.each([
      ["a fraction", '{"business":{"full":4.5}}'],
      ["a string", '{"business":{"full":"daily"}}'],
      ["a scalar where an object belongs", '{"business":4}'],
      ["⚠ a whole number written with a decimal point", '{"business":{"full":4.0}}'],
      ["⚠ an integer beyond int4", '{"business":{"full":99999999999}}'],
      ["⚠ a negative beyond int4", '{"business":{"full":-99999999999}}'],
      ["a trailing-zero fraction", '{"business":{"full":4.50}}'],
      ["null where a number belongs", '{"business":{"full":null}}'],
    ])("refuses %s in cadence_by_plan at write time", async (_label, value) => {
      await expect(
        db.query("UPDATE engines SET cadence_by_plan = $1::jsonb WHERE key = 'perplexity'", [value]),
      ).rejects.toThrow(/engines_cadence_by_plan_castable/u);
    });

    // ⚠ AND THE CONSTRAINT IS CHECKED AGAINST THE CAST ITSELF, NOT AGAINST MY
    // READING OF IT. Postgres decides what `::int` accepts; this asserts the
    // two agree over the exact strings above, so the constraint cannot drift
    // from the thing it is protecting.
    //
    // ⚠ THE LITERAL IS NOT THE STORED TEXT, AND `4e2` IS WHY THIS TEST EXISTS
    // IN THIS FORM. jsonb normalises some numeric literals and preserves
    // others: `4e2` is stored as `400` and casts cleanly, while `4.0` and
    // `4.50` are stored verbatim and do not. I had `4e2` in the refusal list
    // above on the assumption that it looked un-castable; the database
    // disagreed. So the comparison below asks POSTGRES what `::int` does with
    // the text jsonb actually stored, and requires the constraint to give the
    // same answer — rather than encoding my reading of either one.
    //
    // ⚠ ONE-DIRECTIONAL: ACCEPTED ⇒ CASTS. The first version asserted
    // equality, and equality is FALSE in general — the constraint is
    // deliberately stricter for JSON strings and JSON null, which `::int`
    // would happily take:
    //
    //   '"4"'   stores as `4`   -> constraint refuses, ::int accepts
    //   '" 4 "' stores as ` 4 ` -> constraint refuses, ::int accepts
    //   'null'  stores as NULL  -> constraint refuses, ::int accepts
    //
    // It passed only because no JSON string was in the list. A reviewer
    // adding `'"4"'` — an entirely reasonable "cover strings too" — would get
    // a red whose obvious fix is to LOOSEN the constraint, which is the exact
    // move this whole guard exists to prevent. The implication is the real
    // safety property, it is true for every input, and it catches `4.0` just
    // as well.
    it.each([
      "4.0",
      "4.50",
      "99999999999",
      "-99999999999",
      "4e2",
      "4",
      "0",
      "-1",
      "2147483647",
      "2147483648",
      '"4"',
      '" 4 "',
      "null",
    ])(
      "nothing the constraint accepts can raise in the reader: %s",
      async (literal) => {
        const stored = await db
          .query<{ t: string }>("SELECT ($1::jsonb) #>> '{}' AS t", [literal])
          .then((r) => r.rows[0]!.t);

        const actuallyCasts = await db
          .query("SELECT ($1::text)::int", [stored])
          .then(() => true)
          .catch(() => false);

        const accepted = await db
          .query<{ ok: boolean }>("SELECT app.cadence_by_plan_is_castable($1::jsonb) AS ok", [
            `{"business":{"full":${literal}}}`,
          ])
          .then((r) => r.rows[0]!.ok);

        // The implication, not the equivalence. Stricter is safe; the
        // forbidden combination is accepted-and-raises.
        if (accepted) {
          expect(
            actuallyCasts,
            `the constraint ACCEPTED ${literal} (stored as "${stored}"), which ::int rejects — this is a 500 in the reader`,
          ).toBe(true);
        }
      },
    );

    // And the implication must not be vacuous: if the constraint refused
    // everything, every case above would pass. These are the values it is
    // REQUIRED to accept, because the readers' `> 0` depends on them being
    // storable (capture-engine-cadence.spec.ts seeds a 0 to prove the
    // fail-closed rule).
    it.each(["4", "0", "-1", "2147483647", "-2147483648", "4e2"])("still accepts %s", async (literal) => {
      const accepted = await db
        .query<{ ok: boolean }>("SELECT app.cadence_by_plan_is_castable($1::jsonb) AS ok", [
          `{"business":{"full":${literal}}}`,
        ])
        .then((r) => r.rows[0]!.ok);
      expect(accepted, `${literal} casts cleanly and must remain storable`).toBe(true);
    });

    // ⚠ ZERO AND NEGATIVE STAY LEGAL, DELIBERATELY. They cast cleanly, and the
    // readers' own `> 0` is what excludes them — that IS the fail-closed rule
    // (capture-engine-cadence.spec.ts seeds {"growth":{"full":0}} to prove
    // it). A constraint that forbade them would take over a scheduling
    // decision it has no business making.
    it.each([
      ["zero", '{"business":{"full":0}}'],
      ["a negative", '{"business":{"full":-1}}'],
    ])("still accepts %s — the readers exclude it, not the constraint", async (_label, value) => {
      const original = await db.query<{ c: unknown }>(
        "SELECT cadence_by_plan AS c FROM engines WHERE key = 'perplexity'",
      );
      try {
        await expect(
          db.query("UPDATE engines SET cadence_by_plan = $1::jsonb WHERE key = 'perplexity'", [value]),
        ).resolves.toBeDefined();
      } finally {
        await db.query("UPDATE engines SET cadence_by_plan = $1 WHERE key = 'perplexity'", [
          JSON.stringify(original.rows[0]!.c),
        ]);
      }
    });

    // ⚠ A REGRESSION GUARD ON THE SEED, NOT A PROBE FOR BAD INPUT. It queries
    // the catalog 0027 itself produced, so it can only ever fail if a future
    // edit to the SEED introduces an uncastable value — it structurally cannot
    // encounter a `4.0` an operator writes later, and an earlier version of
    // this file leaned on it as though it could. The constraint tests above
    // are what cover operator input.
    it("every cadence leaf in the seeded catalog survives the ::int cast", async () => {
      // If a seeded leaf were 4.5 or "daily", this query raises rather than
      // returning a row, and both the scheduler and the scorecard read would
      // 500 on it.
      const rows = await db.query<{ key: string }>(
        `SELECT e.key
           FROM engines e,
                LATERAL jsonb_each(e.cadence_by_plan) AS per_plan(plan_key, plan_value),
                LATERAL jsonb_each(per_plan.plan_value) AS per_kind(kind_key, kind_value)
          WHERE (per_kind.kind_value #>> '{}')::int IS NULL`,
      );
      expect(rows.rows).toEqual([]);
    });
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
    afterEach(() => vi.unstubAllEnvs());

    // NEW-A-4: changed from "NONE of them" — Gemini is real once GEMINI_API_KEY is set.
    it("a business project with a Gemini key can capture on gemini ONLY", async () => {
      vi.stubEnv("GEMINI_API_KEY", "test-key-not-a-secret");
      const { workspaceId, projectId } = await projectOnPlan("business");

      expect(await capturableFor(workspaceId, projectId)).toEqual(["gemini"]);
    });

    it("a business project is entitled to six engines and, with no Gemini key, can capture on NONE of them", async () => {
      vi.stubEnv("GEMINI_API_KEY", "");
      const { workspaceId, projectId } = await projectOnPlan("business");

      expect(await enginesFor(workspaceId, projectId)).toHaveLength(6);
      expect(
        await capturableFor(workspaceId, projectId),
        "no vendor adapter exists in this repository — STORY-001 opens the accounts",
      ).toEqual([]);
    });

    it("the capture-ready set is derived from the registry, not listed", () => {
      // Empty keyless; NEW-A-4 made it ["gemini"] when a key is configured.
      vi.stubEnv("GEMINI_API_KEY", "");
      expect(captureReadyEngineKeys()).toEqual([]);
    });
  });
});
