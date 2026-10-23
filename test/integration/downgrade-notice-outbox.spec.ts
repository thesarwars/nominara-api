import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { downgradeNoticeJobKey } from "../../src/lib/billing/downgrade-notice-outbox.js";
import { signQueueJobPayload } from "../../src/lib/queue/envelope.js";
import { createBillingDowngradeNoticeHandler } from "../../src/lib/queue/handlers/billing-downgrade-notice.handler.js";
import { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import type { RotatingSigningKeys } from "../../src/lib/queue/signing.js";
import { topologyFor } from "../../src/lib/queue/topology.js";
import { createJobProcessor } from "../../src/lib/queue/worker-factory.js";
import { LoggingEmailSenderAdapter } from "../../src/modules/identity/adapters/logging-email-sender.adapter.js";
import type { EmailMessage, EmailSender } from "../../src/modules/identity/ports/email-sender.js";
import { usePlanChangeFixture } from "../support/plan-change-fixture.js";

// STORY-077 — OWNER DECISION 2026-10-23 (2), end to end on the real ApiModule, a real Postgres with RLS in force and the
// fake Stripe gateway. The downgrade pause/resume email used to be sent inline after the webhook's commit, and a failed
// send was logged and lost. Now the cut-over RECORDS the email in `downgrade_notices` inside its own transaction, keyed
// by the Stripe event id and the kind, and enqueues one signed tenant job `billing.downgrade_notice` after the commit;
// the worker sends it with no transaction open (ADR-0003) and marks it sent. A failed send fails the job, so the queue
// retries it; a sent notice is never sent again, by a retry, a duplicate job or a Stripe redelivery.
//
// The worker is driven here the way src/worker.ts drives it: `createJobProcessor` on the queue's topology entry, a pooled
// connection per phase, a signed envelope. Enqueueing is observed (and stubbed) on QueueProducer.

describe("STORY-077 owner decision 2026-10-23 · the downgrade email goes through a retried, idempotent tenant job", () => {
  const f = usePlanChangeFixture({ drainNotices: false });
  const { gateway, harness } = f;
  const db = () => harness.db();
  const KEYS: RotatingSigningKeys = { current: { kid: "dgnotice-it", key: Buffer.alloc(32, 3) } };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spyEmail(): EmailMessage[] {
    const sent: EmailMessage[] = [];
    vi.spyOn(LoggingEmailSenderAdapter.prototype, "send").mockImplementation(async (message: EmailMessage) => {
      sent.push(message);
    });
    return sent;
  }

  function spyEnqueue() {
    const calls: Array<{ queue: string; workspaceId: string; payload: Record<string, unknown>; key: string }> = [];
    vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockImplementation(async (queue, workspaceId, payload, options) => {
      calls.push({ queue, workspaceId, payload: payload as Record<string, unknown>, key: options.idempotencyKey });
      return { id: options.idempotencyKey } as never;
    });
    return calls;
  }

  /** The worker's own connection: the runtime role, so RLS is in force. */
  function workerPool(): Pool {
    const url = new URL(process.env.DATABASE_URL!);
    url.username = "nominara_app";
    url.password = resolvePassword("nominara_app", {});
    return new Pool({ connectionString: url.toString(), max: 2 });
  }

  function processorFor(pool: Pool, sender: EmailSender) {
    return createJobProcessor(topologyFor("billing.downgrade_notice"), {
      keys: KEYS,
      getClient: () => pool.connect(),
      releaseClient: (client) => (client as unknown as { release(): void }).release(),
      process: createBillingDowngradeNoticeHandler({ pool, env: {} as never }, { sender }),
    });
  }
  const jobFor = (workspaceId: string, payload: Record<string, unknown>): Job =>
    ({ data: signQueueJobPayload({ ...payload, workspaceId, kid: KEYS.current.kid }, KEYS.current.key) }) as unknown as Job;

  /** Five Business projects, a downgrade to Growth scheduled, then Stripe's cut-over delivered as `eventId`. */
  async function cutOver(eventId: string) {
    const { workspaceId, owner } = await f.newWorkspace("business");
    await f.projects(workspaceId, 5);
    const res = await f.post(owner, "/billing/subscription/change", { plan_key: "growth" });
    expect(res.statusCode, res.body).toBe(202);
    const call = gateway.downgrades.at(-1)!;
    const start = f.nowSeconds() - 60;
    f.stripeSubscription(workspaceId, { plan: "growth", metadata: { plan_change_intent_id: String(call.metadata.plan_change_intent_id) }, periodStart: start, periodEnd: start + 30 * 86_400 });
    const delivered = await f.reconcile(workspaceId, eventId);
    expect(delivered.statusCode, delivered.body).toBe(200);
    return workspaceId;
  }

  const notices = async (workspaceId: string) =>
    (await db().query<{ id: string; request_id: string; kind: string; recipient: string; subject: string; text_body: string; sent_at: Date | null }>(
      "SELECT id, request_id, kind, recipient, subject, text_body, sent_at FROM downgrade_notices WHERE workspace_id = $1 ORDER BY created_at, kind",
      [workspaceId],
    )).rows;

  it("the cut-over sends NOTHING inline: it records the email keyed by the Stripe event id and enqueues one signed job carrying ids only", async () => {
    const sent = spyEmail();
    const enqueued = spyEnqueue();
    const eventId = `evt_${randomUUID()}`;
    const workspaceId = await cutOver(eventId);

    expect(sent, "no email is sent on the webhook's path").toHaveLength(0);
    const rows = await notices(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ request_id: eventId, kind: "paused", sent_at: null });
    expect(rows[0]!.text_body).toContain("P3");
    expect(rows[0]!.text_body).toContain("P4");
    expect(enqueued).toEqual([{ queue: "billing.downgrade_notice", workspaceId, payload: { noticeId: rows[0]!.id }, key: downgradeNoticeJobKey(workspaceId, eventId, "paused") }]);
  });

  it("a FAILED send is retried by the job and the email goes out exactly once; another run of the job, and a Stripe redelivery of the same event, send nothing more", async () => {
    spyEmail();
    const enqueued = spyEnqueue();
    const eventId = `evt_${randomUUID()}`;
    const workspaceId = await cutOver(eventId);
    const [notice] = await notices(workspaceId);
    const job = jobFor(workspaceId, enqueued[0]!.payload);

    const pool = workerPool();
    try {
      const attempts: EmailMessage[] = [];
      let fail = true;
      const sender: EmailSender = {
        send: async (message) => {
          // ADR-0003: nothing of the worker's pool is checked out while the provider is called.
          expect(pool.totalCount - pool.idleCount, "no connection is held across the send").toBe(0);
          attempts.push(message);
          if (fail) throw new Error("resend 503");
        },
      };
      const runJob = processorFor(pool, sender);

      await expect(runJob(job), "the first attempt fails the job, so the queue retries it").rejects.toThrow("resend 503");
      expect((await notices(workspaceId))[0]!.sent_at, "still unsent").toBeNull();

      fail = false;
      await runJob(job);
      expect((await notices(workspaceId))[0]!.sent_at, "marked sent").not.toBeNull();
      expect(attempts.map((m) => [m.to, m.subject, m.idempotencyKey])).toEqual([
        [notice!.recipient, notice!.subject, `downgrade-notice/${notice!.id}`],
        [notice!.recipient, notice!.subject, `downgrade-notice/${notice!.id}`],
      ]);

      await runJob(job);
      expect(attempts, "a sent notice is never sent again").toHaveLength(2);

      // Stripe redelivers the SAME event: no second notice, no second job.
      const again = await f.reconcile(workspaceId, eventId);
      expect(again.statusCode, again.body).toBe(200);
      expect(await notices(workspaceId)).toHaveLength(1);
      expect(enqueued).toHaveLength(1);
    } finally {
      await pool.end();
    }
  });

  it("a FAILED enqueue after the commit loses nothing: the notice stays recorded and unsent, for a later job or sweep to send", async () => {
    spyEmail();
    vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockRejectedValue(new Error("valkey down"));
    const workspaceId = await cutOver(`evt_${randomUUID()}`);
    const rows = await notices(workspaceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sent_at).toBeNull();
  });
});
