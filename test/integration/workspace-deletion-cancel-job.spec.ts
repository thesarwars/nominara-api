import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import type { Job } from "bullmq";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createBillingCancelOnDeletionHandler } from "../../src/lib/queue/handlers/billing-cancel-on-deletion.handler.js";
import type { RotatingSigningKeys } from "../../src/lib/queue/signing.js";
import { topologyFor } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { usePlanChangeFixture } from "../support/plan-change-fixture.js";

// Decision 83(a) — `billing.cancel_on_deletion` against a real Postgres with RLS in force (the runtime role) and the fake Stripe
// gateway: a workspace with a live subscription produces exactly one cancel-at-period-end request, a replay of the job after the
// webhook reconciled produces no second one, a workspace with no subscription produces none, and a workspace that is not
// pending_deletion is never touched.

describe("decision 83(a) · billing.cancel_on_deletion against the real database", () => {
  const f = usePlanChangeFixture();
  const { gateway, harness } = f;
  const KEYS: RotatingSigningKeys = { current: { kid: "delcancel-it", key: Buffer.alloc(32, 5) } };
  const pools: Pool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((p) => p.end()));
  });

  /** The worker's own connection: the runtime role, so RLS is in force. */
  function workerPool(): Pool {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "nominara_app";
    url.password = resolvePassword("nominara_app", {});
    const pool = new Pool({ connectionString: url.toString(), max: 2 });
    pools.push(pool);
    return pool;
  }
  function run(workspaceId: string): Promise<unknown> {
    const pool = workerPool();
    const processor = createJobProcessor(topologyFor("billing.cancel_on_deletion"), {
      keys: KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as unknown as { release(): void }).release(),
      process: createBillingCancelOnDeletionHandler({ pool, env: {} as never }, { gateway }),
    });
    return processor({ data: signQueueJobPayload({ workspaceId, kid: KEYS.current.kid }, KEYS.current.key) } as unknown as Job);
  }
  const markPendingDeletion = (workspaceId: string) => harness.db().query("UPDATE workspaces SET status = 'pending_deletion' WHERE id = $1", [workspaceId]);

  it("D83A-I-1 a live Stripe subscription: exactly one cancel-at-period-end request, for THAT subscription", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    await markPendingDeletion(workspaceId);
    gateway.cancelAtPeriodEnd.length = 0;
    expect(await run(workspaceId)).toBe("cancel_scheduled");
    expect(gateway.cancelAtPeriodEnd).toEqual([{ subscriptionId: f.subIdOf(workspaceId) }]);
  });

  it("D83A-I-2 a subscription already set to cancel at period end (e.g. the customer did it in the portal first) makes no request", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    await markPendingDeletion(workspaceId);
    await harness.db().query("UPDATE subscriptions SET cancel_at_period_end = true WHERE workspace_id = $1", [workspaceId]);
    gateway.cancelAtPeriodEnd.length = 0;
    expect(await run(workspaceId)).toBe("already_cancelling");
    expect(gateway.cancelAtPeriodEnd).toEqual([]);
  });

  it("D83A-I-6 the webhook Stripe sends after the cancel is ACKNOWLEDGED, not a 500 Stripe would retry for days, and changes nothing for a pending_deletion workspace", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    await markPendingDeletion(workspaceId);
    const before = await f.planOf(workspaceId);
    const start = f.nowSeconds() - 60;
    f.stripeSubscription(workspaceId, { plan: "growth", cancelAtPeriodEnd: true, periodStart: start, periodEnd: start + 30 * 86_400 });
    const res = await f.reconcile(workspaceId);
    expect(res.statusCode, res.body).toBe(200);
    expect(await f.planOf(workspaceId)).toEqual(before);
  });

  it("D83A-I-3 a workspace that never went to Stripe (the local placeholder subscription) produces no request", async () => {
    const ownerId = await f.createUser();
    const ws = await (harness.app().get(
      // the same service the API uses, so the placeholder row is the one production writes
      (await import("../../src/modules/workspaces/workspaces.service.js")).WorkspacesService,
    ) as { create(userId: string, input: { name: string }, meta: unknown): Promise<{ id: string }> }).create(ownerId, { name: `Free ${Date.now()}` }, f.meta);
    await markPendingDeletion(ws.id);
    gateway.cancelAtPeriodEnd.length = 0;
    expect(await run(ws.id)).toBe("no_subscription");
    expect(gateway.cancelAtPeriodEnd).toEqual([]);
  });

  it("D83A-I-4 INVARIANT: a workspace that is not pending_deletion is never cancelled", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    gateway.cancelAtPeriodEnd.length = 0;
    expect(await run(workspaceId)).toBe("not_pending_deletion");
    expect(gateway.cancelAtPeriodEnd).toEqual([]);
  });

  it("D83A-I-5 a Stripe outage fails the job so the ladder retries it, and the retry then succeeds exactly once", async () => {
    const { workspaceId } = await f.newWorkspace("growth");
    await markPendingDeletion(workspaceId);
    gateway.cancelAtPeriodEnd.length = 0;
    gateway.failFetchWith = new Error("stripe 503");
    try {
      await expect(run(workspaceId)).rejects.toThrow("stripe 503");
    } finally {
      gateway.failFetchWith = undefined;
    }
    expect(gateway.cancelAtPeriodEnd).toEqual([]);
    expect(await run(workspaceId)).toBe("cancel_scheduled");
    expect(gateway.cancelAtPeriodEnd).toHaveLength(1);
  });
});
