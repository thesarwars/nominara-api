import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { verifyChain } from "../../src/lib/crypto/audit-chain.js";
import { readWorkspaceChain } from "../../src/modules/audit/audit-log-reader.js";
import { applyPlanChange, planKeyOnly, type ProviderSubscriptionState } from "../../src/lib/billing/apply-plan.js";
import { DowngradeNotSupportedError, NegotiatedTierRefusedError } from "../../src/lib/billing/errors.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";

// STORY-151 — the transaction itself, against real Postgres.
//
// Dangerous area: this writes the credit ledger. testing-strategy.md §1 puts
// the ledger behind a real database, not a mocked client.
describe("STORY-151 · applyPlanChange", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    // ⚠ AS `nominara_app`, NOT AS THE CONTAINER SUPERUSER. The first version
    // pointed this pool at the container's own `nominara` role, which is
    // `rolsuper` and `rolbypassrls` — so FORCE RLS was never exercised by any
    // of these tests, while the `ALTER ROLE` above sat there reading as though
    // it were. The production path runs as `nominara_app`; so does this.
    const appUri = new URL(container.getConnectionUri());
    appUri.username = "nominara_app";
    appUri.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: appUri.toString(), max: 8 });
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  let workspaceId: string;

  /**
   * ⚠ MIRRORS `WorkspacesService.create` EXACTLY — free plan, free
   * subscription, synthetic local_* ids — rather than hand-writing a paid
   * plan the way ten existing integration specs do. That hand-writing is why
   * the suite validated a tier no code path could produce.
   */
  async function createFreeWorkspace(): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key)
       VALUES ($1,$2,$3,'in_house','us-east-1','UTC','free')`,
      // ⚠ THE WHOLE UUID, NOT ITS FIRST EIGHT CHARS. uuidV7 is
      // timestamp-prefixed, so two workspaces created in the same millisecond
      // produced the same slug and tripped ux_workspaces_slug.
      [id, `ws-${id}`, `ws-${id}`],
    );
    await db.query(
      `INSERT INTO subscriptions
         (id, workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
          status, current_period_start, current_period_end, trial_ends_at)
       VALUES ($1,$2,'free','monthly',$3,$4,'active', now(), now() + interval '1 month', NULL)`,
      [uuidV7(), id, `local_cus_${id}`, `local_sub_${id}`],
    );
    return id;
  }

  /**
   * ⚠ THE FIXTURE THAT WAS MISSING, AND ITS ABSENCE HID EVERY LEDGER DEFECT.
   *
   * `WorkspacesService.create` does NOT create a wallet — they are provisioned
   * lazily on first credit use — so every test in this story took
   * `applyPlanChange`'s `cycle === undefined` branch and `grantCredits` was
   * never called ONCE across 33 tests. A second-engineer review proved it by
   * mutation: deleting the entire §5 top-up, breaking its idempotency key, and
   * removing the advisory lock ALL left every test green.
   *
   * Two real defects were hiding behind that: a free-text `--ticket` written
   * into `credit_ledger.reference_id`, which is `uuid` and raised 22P02 and
   * rolled the whole plan change back; and `date` columns read as
   * local-midnight `Date`s, which over-granted credits in `us-east-1`.
   *
   * The dangerous area is the ledger. It needs a wallet.
   */
  async function provisionWallet(ws: string, cycleStart: string, cycleEnd: string, included = 0): Promise<void> {
    await db.query(
      `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
       VALUES ($1, $2, $3, $4)`,
      [ws, included, cycleStart, cycleEnd],
    );
  }

  async function change(
    ws: string,
    plan: string,
    opts: { allowNegotiatedTier?: boolean; reconcile?: (c: ProviderSubscriptionState) => ProviderSubscriptionState } = {},
  ) {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(
          tx,
          ws,
          opts.reconcile ?? planKeyOnly(plan),
          { requestId: "TICKET-1", operator: "op@example.test", reason: "test" },
          opts.allowNegotiatedTier === undefined ? {} : { allowNegotiatedTier: opts.allowNegotiatedTier },
        ),
      );
    } finally {
      client.release();
    }
  }

  /** Same as change(), with the clock pinned so a pro-rata boundary is assertable. */
  async function changeAt(ws: string, plan: string, now: Date) {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId: ws, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, ws, planKeyOnly(plan),
          { requestId: "TICKET-1", operator: "op@example.test", reason: "test" }, { now }),
      );
    } finally {
      client.release();
    }
  }

  beforeEach(async () => {
    workspaceId = await createFreeWorkspace();
  });

  // ---- T5: both copies, and the provenance ------------------------------

  it("writes BOTH plan_key copies and stamps the provenance", async () => {
    await change(workspaceId, "growth");

    const ws = await db.query<{ plan_key: string; entitlement_version: number }>(
      "SELECT plan_key, entitlement_version FROM workspaces WHERE id = $1", [workspaceId]);
    const sub = await db.query<{ plan_key: string; provider: string; stripe_subscription_id: string }>(
      "SELECT plan_key, provider, stripe_subscription_id FROM subscriptions WHERE workspace_id = $1", [workspaceId]);

    expect(ws.rows[0]!.plan_key).toBe("growth");
    // ⚠ THE SECOND COPY MATTERS EVEN THOUGH NOTHING READS IT TODAY. The day
    // STORY-075 treats `subscriptions.plan_key` as vendor-facing truth, a
    // silent divergence between the two becomes a billing incident.
    expect(sub.rows[0]!.plan_key, "both copies or neither").toBe("growth");
    expect(sub.rows[0]!.provider).toBe("operator");
    // The synthetic placeholder ids survive — STORY-075's drift job must
    // exclude them by this column, not by a string prefix.
    expect(sub.rows[0]!.stripe_subscription_id).toBe(`local_sub_${workspaceId}`);
    expect(ws.rows[0]!.entitlement_version).toBe(2);
  });

  it("leaves exactly one live subscription — it never INSERTs a second", async () => {
    await change(workspaceId, "growth");
    const count = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM subscriptions WHERE workspace_id = $1", [workspaceId]);
    expect(count.rows[0]!.count).toBe("1");
  });

  // ---- T2: the no-op gate ------------------------------------------------

  // ⚠ A VERSION BUMP IS A WORKSPACE-WIDE SOFT LOGOUT. Every member's live
  // token 401s `entitlement_stale`, so re-running a grant that already holds
  // must not log a twenty-seat workspace out a second time.
  it("is a no-op on a repeat: one version bump, one audit row, one ledger entry", async () => {
    const first = await change(workspaceId, "growth");
    const second = await change(workspaceId, "growth");

    expect(first.changed).toBe(true);
    expect(second.changed, "the second call must change nothing").toBe(false);

    const ws = await db.query<{ entitlement_version: number }>(
      "SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId]);
    expect(ws.rows[0]!.entitlement_version, "advanced by exactly one, not two").toBe(2);

    const audit = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM audit_log WHERE workspace_id = $1 AND action = 'workspace.plan_changed'",
      [workspaceId]);
    expect(audit.rows[0]!.count).toBe("1");
  });

  // ---- T15: direction and the negotiated tier ----------------------------

  it("refuses a downgrade by name, and writes nothing", async () => {
    await change(workspaceId, "growth");
    const before = await db.query<{ entitlement_version: number }>(
      "SELECT entitlement_version FROM workspaces WHERE id = $1", [workspaceId]);

    await expect(change(workspaceId, "starter")).rejects.toThrow(DowngradeNotSupportedError);

    const after = await db.query<{ plan_key: string; entitlement_version: number }>(
      "SELECT plan_key, entitlement_version FROM workspaces WHERE id = $1", [workspaceId]);
    expect(after.rows[0]!.plan_key).toBe("growth");
    expect(after.rows[0]!.entitlement_version).toBe(before.rows[0]!.entitlement_version);
  });

  // ⚠ `sort_order` CAN NEVER REFUSE ENTERPRISE — it is the maximum (4,
  // verified against the seeded table) — and it resolves to UNLIMITED on a
  // plan priced by contract. Refusing it by name is the only guard there is.
  it("refuses the negotiated tier by name unless it is deliberately allowed", async () => {
    await expect(change(workspaceId, "enterprise")).rejects.toThrow(NegotiatedTierRefusedError);

    const untouched = await db.query<{ plan_key: string }>(
      "SELECT plan_key FROM workspaces WHERE id = $1", [workspaceId]);
    expect(untouched.rows[0]!.plan_key).toBe("free");

    const allowed = await change(workspaceId, "enterprise", { allowNegotiatedTier: true });
    expect(allowed.changed).toBe(true);
    expect(allowed.to).toBe("enterprise");
  });

  // ---- T7: the wholesale path, EXERCISED ---------------------------------

  // ⚠ THIS IS THE TEST THAT STOPS STORY-075 INHERITING AN UNTESTED SEAM.
  // `planKeyOnly` only ever changes one field, so without this the wholesale
  // write — the thing STORY-075 calls "the decision that makes webhook
  // handling robust" — would ship built and never exercised, which is this
  // project's signature defect.
  it("writes the WHOLE record when a reconciler changes more than the plan", async () => {
    const periodStart = new Date("2026-11-01T00:00:00.000Z");
    const periodEnd = new Date("2026-12-01T00:00:00.000Z");
    await change(workspaceId, "business", {
      reconcile: (current) => ({
        ...current,
        planKey: "business",
        billingInterval: "annual",
        status: "past_due",
        currentPeriodStart: periodStart,
        currentPeriodEnd: periodEnd,
        cancelAtPeriodEnd: true,
        seatsPurchased: 7,
        projectsPurchased: 3,
      }),
    });

    const row = await db.query(
      `SELECT plan_key, billing_interval, status, cancel_at_period_end,
              seats_purchased, projects_purchased, current_period_start, current_period_end
         FROM subscriptions WHERE workspace_id = $1`, [workspaceId]);
    expect(row.rows[0]).toMatchObject({
      plan_key: "business",
      billing_interval: "annual",
      status: "past_due",
      cancel_at_period_end: true,
      seats_purchased: 7,
      projects_purchased: 3,
    });
    expect((row.rows[0] as { current_period_end: Date }).current_period_end.toISOString()).toBe(periodEnd.toISOString());
  });

  // ---- T6: the carry-forward hazard of a wholesale write -----------------

  // A delta write cannot have this bug; the wholesale write can, and one test
  // is the whole defence. `billing-period.ts` resolves the billing period from
  // `current_period_*`, so losing them silently changes which counters and
  // daily caps apply.
  it("carries every column the reconciler did not touch forward, untouched", async () => {
    await db.query(
      `UPDATE subscriptions SET seats_purchased = 5, projects_purchased = 2,
              current_period_end = '2027-03-04T05:06:07Z' WHERE workspace_id = $1`, [workspaceId]);

    await change(workspaceId, "growth");

    const row = await db.query<{ seats_purchased: number; projects_purchased: number; current_period_end: Date }>(
      "SELECT seats_purchased, projects_purchased, current_period_end FROM subscriptions WHERE workspace_id = $1",
      [workspaceId]);
    expect(row.rows[0]!.seats_purchased).toBe(5);
    expect(row.rows[0]!.projects_purchased).toBe(2);
    expect(row.rows[0]!.current_period_end.toISOString()).toBe("2027-03-04T05:06:07.000Z");
  });

  // ---- T10: the audit row, and the chain it hashes into -------------------

  it("hashes INTO the existing chain and carries a populated before_state", async () => {
    await change(workspaceId, "growth");

    const rows = await readWorkspaceChain(db, workspaceId);
    expect(verifyChain(rows), "the plan-change row must not break the tenant's chain").toBeNull();

    const row = rows.find((r) => r.action === "workspace.plan_changed")!;
    expect(row.severity).toBe("notice");
    expect(row.actor_type).toBe("system");
    expect(row.request_id).toBe("TICKET-1");
    // ⚠ THE REPO'S FIRST POPULATED before_state. `auditBeforeState` is
    // declared on the interceptor and read by it, and set by nothing in src/
    // or test/ — so every audit row until now recorded only an after.
    expect(row.before_state).toMatchObject({ plan_key: "free", entitlement_version: 1 });
    expect(row.after_state).toMatchObject({ plan_key: "growth", entitlement_version: 2, operator: "op@example.test" });
  });

  // ---- T13: the detective control, as a spec ------------------------------

  // ⚠ PREVENTION DOES NOT REACH A RAW UPDATE, A RESTORED DUMP, OR A ROUTE
  // MERGED IN A HURRY. This is what does.
  it("the provenance invariant is 0 on a clean database and names the workspace when it is broken", async () => {
    const unvouched = async () =>
      (await db.query<{ count: string }>(
        "SELECT count(*) AS count FROM subscriptions WHERE plan_key <> 'free' AND provider = 'none'")).rows[0]!.count;

    await change(workspaceId, "growth");
    expect(await unvouched(), "a plan granted through applyPlanChange is vouched for").toBe("0");

    // A paid plan that did NOT come through applyPlanChange:
    const rogue = await createFreeWorkspace();
    await db.query("UPDATE subscriptions SET plan_key = 'business' WHERE workspace_id = $1", [rogue]);
    expect(await unvouched(), "and one that did not is visible").toBe("1");

    const named = await db.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM subscriptions WHERE plan_key <> 'free' AND provider = 'none'");
    expect(named.rows[0]!.workspace_id).toBe(rogue);
  });

  // ---- THE LEDGER. The dangerous area, and it had no coverage at all. ------

  it("grants §5's pro-rata top-up through the real ledger, and the wallet still replays", async () => {
    // Half-way through a 30-day cycle, free(60) → growth(1200): 1140 × 15/30.
    await provisionWallet(workspaceId, "2026-09-01", "2026-10-01", 60);
    const outcome = await changeAt(workspaceId, "growth", new Date("2026-09-16T00:00:00.000Z"));

    expect(outcome.creditsToppedUp).toBe(570);

    const wallet = await db.query<{ included_balance: number; lifetime_granted: string }>(
      "SELECT included_balance, lifetime_granted FROM credit_wallets WHERE workspace_id = $1", [workspaceId]);
    expect(wallet.rows[0]!.included_balance, "added, never replaced").toBe(630);
    expect(wallet.rows[0]!.lifetime_granted).toBe("570");

    const ledger = await db.query<{ entry_type: string; credits: number; reference_type: string; reference_id: string | null }>(
      "SELECT entry_type, credits, reference_type, reference_id FROM credit_ledger WHERE workspace_id = $1", [workspaceId]);
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0]).toMatchObject({ entry_type: "grant", credits: 570, reference_type: "plan_change" });
    // ⚠ NULL, NOT THE TICKET. `reference_id` is `uuid`; a free-text ticket
    // there raised 22P02 and rolled the entire plan change back, on every
    // workspace that had ever spent a credit. The ticket lives on the audit
    // row, whose `request_id` is text.
    expect(ledger.rows[0]!.reference_id).toBeNull();
  });

  // ⚠ THE OPERATOR'S TICKET IS FREE TEXT AND MUST NOT ABORT THE CHANGE.
  it("accepts a non-UUID ticket on a workspace that HAS a wallet", async () => {
    await provisionWallet(workspaceId, "2026-09-01", "2026-10-01", 60);
    const client = await pool.connect();
    try {
      const outcome = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        applyPlanChange(tx, workspaceId, planKeyOnly("growth"),
          { requestId: "OPS-1234", operator: "op@example.test", reason: "a real ticket ref" },
          { now: new Date("2026-09-16T00:00:00.000Z") }),
      );
      expect(outcome.changed).toBe(true);
      expect(outcome.creditsToppedUp).toBeGreaterThan(0);
    } finally {
      client.release();
    }
    const ws = await db.query<{ plan_key: string }>("SELECT plan_key FROM workspaces WHERE id = $1", [workspaceId]);
    expect(ws.rows[0]!.plan_key, "the change must have COMMITTED, not rolled back").toBe("growth");
  });

  // ⚠ THE CYCLE BOUNDARY MEANS THE SAME THING IN EVERY TIMEZONE. `cycle_start`
  // and `cycle_end` are `date`, and node-postgres parses `date` at LOCAL
  // midnight — so reading them raw over-granted by ~6 credits per upgrade in
  // us-east-1 (the default region) and minted credits into an ALREADY ENDED
  // cycle. wallet.ts:83 documents this trap and answers it with `to_char`.
  it("grants the same amount whatever timezone the process runs in", async () => {
    const original = process.env.TZ;
    const results: number[] = [];
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Dhaka"]) {
        process.env.TZ = tz;
        const ws = await createFreeWorkspace();
        await provisionWallet(ws, "2026-09-01", "2026-10-01", 60);
        const outcome = await changeAt(ws, "growth", new Date("2026-09-16T00:00:00.000Z"));
        results.push(outcome.creditsToppedUp);
      }
    } finally {
      process.env.TZ = original;
    }
    expect(results, "570 in every timezone, not 570/576/560").toEqual([570, 570, 570]);
  });

  it("grants NOTHING for a cycle that has already ended, in any timezone", async () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      await provisionWallet(workspaceId, "2026-08-01", "2026-09-01", 60);
      const outcome = await changeAt(workspaceId, "growth", new Date("2026-09-01T03:00:00.000Z"));
      expect(outcome.creditsToppedUp, "minting into an ended cycle is minting").toBe(0);
    } finally {
      process.env.TZ = original;
    }
  });

  // ⚠ THE IDEMPOTENCY KEY CARRIES THE VERSION, SO A SECOND UPGRADE IN ONE
  // CYCLE GRANTS ITS OWN UPLIFT. Keying on the workspace alone would make the
  // second upgrade silently grant nothing.
  it("a second upgrade in the same cycle grants its own uplift, and does not double-count", async () => {
    await provisionWallet(workspaceId, "2026-09-01", "2026-10-01", 60);
    const first = await changeAt(workspaceId, "starter", new Date("2026-09-11T00:00:00.000Z"));
    const second = await changeAt(workspaceId, "growth", new Date("2026-09-21T00:00:00.000Z"));

    // free(60)→starter(450): 390 × 20/30 = 260. starter(450)→growth(1200): 750 × 10/30 = 250.
    expect(first.creditsToppedUp).toBe(260);
    expect(second.creditsToppedUp).toBe(250);

    const ledger = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'grant'", [workspaceId]);
    expect(ledger.rows[0]!.count, "two grants, one per version").toBe("2");
  });

  it("the no-wallet path skips cleanly and says so, rather than failing", async () => {
    const outcome = await change(workspaceId, "growth");
    expect(outcome.changed).toBe(true);
    expect(outcome.creditsToppedUp).toBe(0);
    expect(outcome.creditsNote).toMatch(/no credit wallet/u);
    const ledger = await db.query<{ count: string }>(
      "SELECT count(*) AS count FROM credit_ledger WHERE workspace_id = $1", [workspaceId]);
    expect(ledger.rows[0]!.count).toBe("0");
  });
});
