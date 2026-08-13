import type { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { type PgBouncerFixture, startPgBouncerFixture } from "../support/pgbouncer-fixture.js";

// STORY-010 · THE most important test in EPIC-01. A real pgBouncer
// (edoburu/pgbouncer:v1.25.2-p0, the exact image docker-compose.yml pins) in
// front of a real Postgres, pool size ONE, two clients authenticated as the
// SAME role (nominara_app) — different roles would land in different pools
// and this test would pass regardless of whether the bug exists — proving
// tenant context set via set_config(..., true) (SET LOCAL) cannot bleed
// across two tenants sharing one pooled server connection, and that a
// session-scoped set_config(..., false) DOES bleed (the mandatory negative
// control: without it, "no bleed" could mean the harness never shared a
// connection at all).
//
// Deliberately does NOT depend on RLS or on app.current_workspace() /
// app.current_actor() / app.current_scope_projects() — none of those exist
// until STORY-011. The pooling property is asserted directly via
// current_setting/set_config against a custom GUC placeholder, which needs
// no function and no policy.
describe("STORY-010 · pgBouncer transaction-mode pooling", () => {
  let fixture: PgBouncerFixture;

  beforeAll(async () => {
    fixture = await startPgBouncerFixture({ defaultPoolSize: 1 });
  }, 180_000);

  afterAll(async () => {
    await fixture.stop();
  });

  // ---- scenario 5 ----------------------------------------------------------

  it("scenario 5 — the pooler's own admin console (SHOW CONFIG) reports pool_mode = transaction", async () => {
    const admin = fixture.connectAdmin();
    await admin.connect();
    try {
      // Simple query protocol — required for pgBouncer's admin console.
      const result = await admin.query("SHOW CONFIG");
      const poolModeRow = result.rows.find((r: { key: string }) => r.key === "pool_mode");
      expect(poolModeRow?.value).toBe("transaction");
    } finally {
      await admin.end();
    }
  });

  it("the container actually loaded the SHIPPED pgbouncer.ini, not a test-only substitute — only default_pool_size and [databases] host/dbname were overridden", () => {
    expect(fixture.effectiveIniContent).toMatch(/^pool_mode = transaction$/m);
    expect(fixture.effectiveIniContent).toMatch(/^default_pool_size = 1$/m);
    expect(fixture.effectiveIniContent).toMatch(/^server_reset_query_always = 0$/m);
    expect(fixture.effectiveIniContent).toMatch(/^auth_type = scram-sha-256$/m);
  });

  // ---- post-review fix #12 — every runtime role actually authenticates
  // through the pooler, not just nominara_app; break-glass is rejected -------

  it.each(RUNTIME_ROLES)(
    "post-review fix #12 — %s can connect through the pooler and run SELECT 1",
    async (role) => {
      const c = fixture.connectThroughPooler(role);
      await c.connect();
      try {
        await expect(c.query("SELECT 1")).resolves.toBeDefined();
      } finally {
        await c.end();
      }
    },
  );

  it("post-review fix #12 — nominara_breakglass, deliberately absent from userlist.txt, is REJECTED when attempting to connect through the pooler", async () => {
    const c = fixture.connectThroughPooler(BREAKGLASS_ROLE);
    await expect(c.connect()).rejects.toThrow();
  });

  // ---- post-review fix #11 — connection limits are sized so one role
  // cannot exhaust the POOLER, not just the raw Postgres role limit ----------

  it("post-review fix #11 — saturating nominara_app's pool (default_pool_size=1) does not block nominara_report from being served through the SAME pooler", async () => {
    // AC line 24 claims connection limits are "sized so one role cannot
    // exhaust THE POOL" — the previous version of this story's test suite
    // only ever exercised the raw Postgres role CONNECTION LIMIT on
    // nominara_breakglass, which doesn't go through the pooler at all. This
    // proves separate per-(database,role) pools: one role's server
    // connection being held does not block a DIFFERENT role's connections.
    const holder = fixture.connectThroughPooler("nominara_app");
    await holder.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1");

    try {
      const queuedClient = fixture.connectThroughPooler("nominara_app");
      await queuedClient.connect();
      let queuedSettled = false;
      const queuedPromise = queuedClient
        .query("SELECT 1")
        .finally(() => {
          queuedSettled = true;
        });

      // A DIFFERENT role, through the SAME pooler, must still be served
      // promptly — proving nominara_app exhausting its own pool does not
      // exhaust nominara_report's separate pool.
      const reportClient = fixture.connectThroughPooler("nominara_report");
      await reportClient.connect();
      await expect(reportClient.query("SELECT 1")).resolves.toBeDefined();
      await reportClient.end();

      expect(
        queuedSettled,
        "the second nominara_app client should still be queued behind the held transaction",
      ).toBe(false);

      await holder.query("COMMIT");
      await queuedPromise;
      await queuedClient.end();
    } finally {
      await holder.end();
    }
  });

  // ---- scenario 6 ------------------------------------------------------------

  it("scenario 6 — two tenants interleaved through ONE pooled connection at pool size one do not bleed context, and pg_backend_pid proves they shared one server connection", async () => {
    const clientA: Client = fixture.connectThroughPooler("nominara_app");
    const clientB: Client = fixture.connectThroughPooler("nominara_app");
    await clientA.connect();
    await clientB.connect();

    try {
      // 1. A begins, sets its tenant context via SET LOCAL (set_config(...,
      //    true)), reads it back, and captures the backend pid.
      await clientA.query("BEGIN");
      await clientA.query(
        "SELECT set_config('app.current_workspace_id', $1::text, true)",
        ["11111111-1111-1111-1111-111111111111"],
      );
      const aFirstRead = await clientA.query(
        "SELECT current_setting('app.current_workspace_id', true) AS ws",
      );
      expect(aFirstRead.rows[0]!.ws).toBe("11111111-1111-1111-1111-111111111111");
      const aPidResult = await clientA.query("SELECT pg_backend_pid() AS pid");
      const aPid = aPidResult.rows[0]!.pid;

      // 2. Before A commits, issue B's BEGIN + read WITHOUT awaiting, then
      //    assert B's promise has NOT settled — proving both clients are
      //    queued on the SAME single server connection (pool size 1).
      let bSettled = false;
      const bPromise = (async () => {
        await clientB.query("BEGIN");
        const row = await clientB.query(
          "SELECT current_setting('app.current_workspace_id', true) AS ws",
        );
        return row.rows[0]!.ws as string | null;
      })();
      bPromise.finally(() => {
        bSettled = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(bSettled, "B's BEGIN resolved before A committed — pool size 1 is not actually being enforced").toBe(
        false,
      );

      // 3. Commit A, then await B.
      await clientA.query("COMMIT");
      const bFirstRead = await bPromise;

      // B's first read, right after its own BEGIN, must be null/empty — NOT
      // A's value. SET LOCAL reverts at COMMIT, so nothing should survive.
      expect(bFirstRead == null || bFirstRead === "").toBe(true);

      // B sets and reads its own value, and captures its own backend pid.
      await clientB.query(
        "SELECT set_config('app.current_workspace_id', $1::text, true)",
        ["22222222-2222-2222-2222-222222222222"],
      );
      const bSecondRead = await clientB.query(
        "SELECT current_setting('app.current_workspace_id', true) AS ws",
      );
      expect(bSecondRead.rows[0]!.ws).toBe("22222222-2222-2222-2222-222222222222");
      const bPidResult = await clientB.query("SELECT pg_backend_pid() AS pid");
      const bPid = bPidResult.rows[0]!.pid;

      // 4. Identity check: without this, "no bleed" could be vacuously true
      //    because the two clients happened to land on DIFFERENT server
      //    connections that never shared any state to begin with.
      expect(bPid).toBe(aPid);

      await clientB.query("COMMIT");

      // 5. A opens a THIRD transaction — must read null/empty, not B's
      //    value (no leak in either direction).
      await clientA.query("BEGIN");
      const aThirdRead = await clientA.query(
        "SELECT current_setting('app.current_workspace_id', true) AS ws",
      );
      expect(aThirdRead.rows[0]!.ws == null || aThirdRead.rows[0]!.ws === "").toBe(true);
      await clientA.query("COMMIT");
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });

  it("cross-check — SHOW POOLS on the pgBouncer admin console shows exactly one server connection for the (database, nominara_app) pool", async () => {
    const workingClient = fixture.connectThroughPooler("nominara_app");
    await workingClient.connect();
    await workingClient.query("BEGIN");
    await workingClient.query("SELECT 1");
    await workingClient.query("COMMIT");
    await workingClient.end();

    const admin = fixture.connectAdmin();
    await admin.connect();
    try {
      const result = await admin.query("SHOW POOLS");
      const row = result.rows.find(
        (r: { database: string; user: string }) => r.database === "nominara" && r.user === "nominara_app",
      );
      expect(row, "no SHOW POOLS row for (nominara, nominara_app)").toBeDefined();
      const totalServerConnections =
        Number(row.sv_active) + Number(row.sv_idle) + Number(row.sv_used) + Number(row.sv_login);
      expect(totalServerConnections).toBe(1);
    } finally {
      await admin.end();
    }
  });

  // ---- mandatory negative control ---------------------------------------
  // Without this, every "no bleed" assertion above is meaningless: it would
  // be equally consistent with a harness that (accidentally) never shared a
  // connection at all. Session-scoped set_config(..., false) is exactly what
  // NFR-SEC-02 bans in application code — this proves WHY.

  it("negative control — session-scoped set_config(..., false) DOES leak across two clients sharing the pooled connection", async () => {
    const clientA = fixture.connectThroughPooler("nominara_app");
    const clientB = fixture.connectThroughPooler("nominara_app");
    await clientA.connect();
    await clientB.connect();

    try {
      // Autocommit (no explicit BEGIN): pgBouncer releases the server
      // connection back to the pool as soon as this single statement's
      // implicit transaction ends. With default_pool_size = 1 there is only
      // ONE server connection to ever hand out, so B's next query is
      // guaranteed to land on the exact same backend A just used.
      await clientA.query(
        "SELECT set_config('app.leak_test_marker', $1::text, false)",
        ["leaked-from-A"],
      );
      const aPid = (await clientA.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;

      const bRead = await clientB.query(
        "SELECT current_setting('app.leak_test_marker', true) AS v",
      );
      const bPid = (await clientB.query("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;

      // Same identity check as the positive test — the leak assertion below
      // only means something if both clients demonstrably shared one server
      // connection.
      expect(bPid).toBe(aPid);
      expect(bRead.rows[0]!.v).toBe("leaked-from-A");

      // Post-review fix #17: reset the leaked GUC on the shared server
      // connection before releasing it back to the pool. Harmless only by
      // accident today (current file/test ordering happens not to depend on
      // it), and would otherwise silently leak into whichever test runs
      // next and happens to land on this same pooled server connection —
      // this makes it safe under reordering/shuffling too.
      // set_config(name, NULL, false) is equivalent to RESET.
      await clientB.query("SELECT set_config('app.leak_test_marker', NULL, false)");
    } finally {
      await clientA.end();
      await clientB.end();
    }
  });
});
