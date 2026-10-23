import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { DowngradeNotSupportedError } from "../../src/lib/billing/errors.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { planSetInTransaction, type PlanSetArgs } from "../../src/workers/billing/plan-set.js";

// STORY-077 AC5 on the OTHER plan writer (review round 1). The Stripe webhook is not the only path that changes a plan:
// STORY-151's operator CLI `plan:set` is allowed on a workspace whose Stripe subscription ENDED and was reconciled to
// free — exactly the cancel-to-Free case the cut-over pauses. An operator who then comps that workspace must not leave
// it paused: "resume automatically on a later upgrade" binds every upgrade, and the story's note names the confusion of
// "a customer who upgraded still paused".
//
// Runs as `nominara_app` (FORCE RLS in force), inside the tenant context the CLI itself opens.
describe("STORY-077 · plan:set resumes what a downgrade paused", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    const appUri = new URL(container.getConnectionUri());
    appUri.username = "nominara_app";
    appUri.password = resolvePassword("nominara_app", {});
    pool = new Pool({ connectionString: appUri.toString(), max: 4 });
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  /** A workspace the webhook reconciled to free after its Stripe subscription ended (the row keeps provider = stripe). */
  async function cancelledToFree(provider: "stripe" | "operator" = "stripe"): Promise<string> {
    const id = uuidV7();
    await db.query(
      `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key, billing_email)
       VALUES ($1, $2, $3, 'in_house', 'us-east-1', 'UTC', 'free', 'billing@example.com')`,
      [id, `ws-${id}`, `ws-${id}`],
    );
    await db.query(
      `INSERT INTO subscriptions (id, workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
                                  status, provider, current_period_start, current_period_end)
       VALUES ($1, $2, 'free', 'monthly', $3, $4, 'active', $5, now(), now() + interval '1 month')`,
      [uuidV7(), id, `cus_${id}`, `sub_${id}`, provider],
    );
    return id;
  }

  /** `n` projects the cut-over paused (marked), the i-th created `n - i` hours ago. */
  async function downgradePausedProjects(workspaceId: string, n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const r = await db.query<{ id: string }>(
        `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, status, paused_by_downgrade_at, paused_by_downgrade_from, created_at)
         VALUES ($1, $2, $3, 'https://example.com', 'example.com', 'paused', now(), 'active', now() - ($4 || ' hours')::interval) RETURNING id`,
        [workspaceId, `P${String(i)}`, `p${String(i)}-${uuidV7().slice(-8)}`, String(n - i)],
      );
      ids.push(r.rows[0]!.id);
    }
    return ids;
  }

  const args = (workspaceId: string, planKey: string): PlanSetArgs => ({
    workspaceId,
    planKey,
    operator: "op@example.test",
    ticket: "TICKET-77",
    reason: "comp after cancellation",
    allowNegotiatedTier: false,
  });

  async function planSet(workspaceId: string, planKey: string) {
    const client = await pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => planSetInTransaction(tx, args(workspaceId, planKey)));
    } finally {
      client.release();
    }
  }

  const projects = async (workspaceId: string) =>
    (await db.query<{ id: string; status: string; paused_by_downgrade_at: Date | null }>(
      "SELECT id, status, paused_by_downgrade_at FROM projects WHERE workspace_id = $1 ORDER BY created_at, id",
      [workspaceId],
    )).rows;

  it("cancel to Free, then plan:set to starter: the oldest paused project resumes up to the new limit, audited, and the resume email is returned for after the commit", async () => {
    const ws = await cancelledToFree();
    const ids = await downgradePausedProjects(ws, 2); // starter allows 1 project

    const result = await planSet(ws, "starter");
    expect(result.outcome).toMatchObject({ changed: true, from: "free", to: "starter" });

    expect(await projects(ws)).toEqual([
      expect.objectContaining({ id: ids[0], status: "active", paused_by_downgrade_at: null }),
      expect.objectContaining({ id: ids[1], status: "paused" }),
    ]);
    expect((await projects(ws))[1]!.paused_by_downgrade_at, "still the downgrade's: it resumes on a later upgrade").not.toBeNull();

    const audit = await db.query<{ action: string; actor_ua: string; request_id: string }>(
      "SELECT action, actor_ua, request_id FROM audit_log WHERE workspace_id = $1 AND action = 'billing.downgrade.resumed'",
      [ws],
    );
    expect(audit.rows).toEqual([expect.objectContaining({ actor_ua: "operator:op@example.test", request_id: "TICKET-77" })]);

    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]).toMatchObject({ to: "billing@example.com" });
    expect(result.notices[0]!.textBody).toContain("P0");

    // STORY-077 owner decision 2026-10-23 (2): the email is RECORDED in the same transaction, keyed by the operator's
    // ticket, for the billing.downgrade_notice job to send (and retry); nothing is sent yet.
    const recorded = await db.query<{ id: string; request_id: string; kind: string; recipient: string; sent_at: Date | null }>(
      "SELECT id, request_id, kind, recipient, sent_at FROM downgrade_notices WHERE workspace_id = $1",
      [ws],
    );
    expect(recorded.rows).toEqual([{ id: result.notices[0]!.id, request_id: "TICKET-77", kind: "resumed", recipient: "billing@example.com", sent_at: null }]);
    // The same ticket run again records nothing new (and so enqueues nothing new).
    await planSet(ws, "growth");
    await planSet(ws, "starter");
    expect((await db.query("SELECT 1 FROM downgrade_notices WHERE workspace_id = $1 AND kind = 'resumed'", [ws])).rowCount).toBe(1);
  });

  it("a full comp (growth: 3 projects) resumes every paused project", async () => {
    const ws = await cancelledToFree();
    await downgradePausedProjects(ws, 3);
    await planSet(ws, "growth");
    expect((await projects(ws)).every((p) => p.status === "active" && p.paused_by_downgrade_at === null)).toBe(true);
  });

  // Evidence against the review's "plan:set can move a non-Stripe workspace from business to starter and pause nothing":
  // plan:set never passes `allowDowngrade`, so applyPlanChange refuses. (An operator-provider workspace: on a Stripe
  // row, business would make it Stripe-tracked and the refusal would be PlanSetStripeTrackedError instead.)
  it("plan:set cannot DOWNGRADE (business -> starter is refused before anything is written), so it never needs to pause", async () => {
    const ws = await cancelledToFree("operator");
    await planSet(ws, "business");
    await expect(planSet(ws, "starter")).rejects.toBeInstanceOf(DowngradeNotSupportedError);
  });
});
