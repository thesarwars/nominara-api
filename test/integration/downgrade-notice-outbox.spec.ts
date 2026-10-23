import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { downgradeNoticeJobKey, type EnqueueDowngradeNotice } from "../../src/lib/billing/downgrade-notice-outbox.js";
import { NOTICE_RELAY_MAX_AGE_MS, NOTICE_RETENTION_MS, relayUnsentDowngradeNotices } from "../../src/lib/billing/downgrade-notice-relay.js";
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

  // REVIEW ROUND 2 (major) — THE RELAY. The ladder (doubling(5), about 62 s) and a failed enqueue after the commit both
  // used to end with the row at sent_at IS NULL and nothing that would ever read it again, so a Resend outage longer
  // than a minute, or a Valkey blip at the cut-over, lost the email for good. The relay re-enqueues unsent notices older
  // than five minutes and younger than the provider's idempotency window, under a key with an hour suffix (a failed
  // BullMQ job kept under the base key would swallow a same-id re-add), and every re-send carries the same provider key.
  describe("the relay", () => {
    /** Ages a notice: `created_at` moved back by `ms`. */
    const age = async (noticeId: string, ms: number) => {
      await db().query("UPDATE downgrade_notices SET created_at = created_at - ($2 || ' milliseconds')::interval WHERE id = $1", [noticeId, String(ms)]);
    };
    function relayEnqueue() {
      const calls: Array<{ queue: string; workspaceId: string; payload: { noticeId: string }; key: string }> = [];
      const enqueue: EnqueueDowngradeNotice = async (queue, workspaceId, payload, options) => {
        calls.push({ queue, workspaceId, payload: { ...payload }, key: options.idempotencyKey });
      };
      return { calls, enqueue };
    }

    it("(a) the retry LADDER RUNS OUT, then the relay sends the email exactly once, with the same provider key", async () => {
      spyEmail();
      const enqueued = spyEnqueue();
      const eventId = `evt_${randomUUID()}`;
      const workspaceId = await cutOver(eventId);
      const [notice] = await notices(workspaceId);
      const pool = workerPool();
      try {
        const attempts: EmailMessage[] = [];
        let fail = true;
        const runJob = processorFor(pool, { send: async (m) => { attempts.push(m); if (fail) throw new Error("resend 503"); } });
        // Every attempt of the original job fails: the ladder is spent and the job is dead.
        const original = jobFor(workspaceId, enqueued[0]!.payload);
        for (let i = 0; i < topologyFor("billing.downgrade_notice").retry.delaysMs.length + 1; i++) await expect(runJob(original)).rejects.toThrow("resend 503");
        expect((await notices(workspaceId))[0]!.sent_at).toBeNull();

        await age(notice!.id, 10 * 60_000);
        const now = new Date();
        const relay = relayEnqueue();
        const first = await relayUnsentDowngradeNotices(db(), relay.enqueue, now);
        const mine = relay.calls.filter((c) => c.workspaceId === workspaceId);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ queue: "billing.downgrade_notice", payload: { noticeId: notice!.id } });
        expect(mine[0]!.key, "not the base key a dead job may still hold").not.toBe(downgradeNoticeJobKey(workspaceId, eventId, "paused"));
        expect(first.relayed).toBeGreaterThanOrEqual(1);

        fail = false;
        await runJob(jobFor(workspaceId, mine[0]!.payload));
        expect((await notices(workspaceId))[0]!.sent_at, "sent by the relayed job").not.toBeNull();
        const keys = new Set(attempts.map((m) => m.idempotencyKey));
        expect([...keys], "every attempt and the relayed send carry ONE provider key").toEqual([`downgrade-notice/${notice!.id}`]);
        const sentCount = attempts.length;

        // A later tick finds nothing to relay for it; the relayed job delivered twice sends nothing more.
        const later = relayEnqueue();
        await relayUnsentDowngradeNotices(db(), later.enqueue, new Date(now.getTime() + 3_600_000));
        expect(later.calls.filter((c) => c.workspaceId === workspaceId)).toEqual([]);
        await runJob(jobFor(workspaceId, mine[0]!.payload));
        expect(attempts).toHaveLength(sentCount);
      } finally {
        await pool.end();
      }
    });

    it("(b) the ENQUEUE FAILED after the commit, then the relay sends it exactly once", async () => {
      vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockRejectedValue(new Error("valkey down"));
      const workspaceId = await cutOver(`evt_${randomUUID()}`);
      const [notice] = await notices(workspaceId);
      expect(notice!.sent_at).toBeNull();
      await age(notice!.id, 10 * 60_000);

      const relay = relayEnqueue();
      await relayUnsentDowngradeNotices(db(), relay.enqueue, new Date());
      const mine = relay.calls.filter((c) => c.workspaceId === workspaceId);
      expect(mine.map((c) => c.payload)).toEqual([{ noticeId: notice!.id }]);

      const pool = workerPool();
      try {
        const sent: EmailMessage[] = [];
        const runJob = processorFor(pool, { send: async (m) => void sent.push(m) });
        await runJob(jobFor(workspaceId, mine[0]!.payload));
        await runJob(jobFor(workspaceId, mine[0]!.payload));
        expect(sent.map((m) => [m.to, m.idempotencyKey])).toEqual([[notice!.recipient, `downgrade-notice/${notice!.id}`]]);
      } finally {
        await pool.end();
      }
    });

    it("the relay leaves a notice younger than five minutes to its own job, and the same hour's relays share one key", async () => {
      vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockRejectedValue(new Error("valkey down"));
      const workspaceId = await cutOver(`evt_${randomUUID()}`);
      const [notice] = await notices(workspaceId);
      const young = relayEnqueue();
      await relayUnsentDowngradeNotices(db(), young.enqueue, new Date());
      expect(young.calls.filter((c) => c.workspaceId === workspaceId), "too young: its original job may still be running").toEqual([]);

      await age(notice!.id, 10 * 60_000);
      const now = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 + 30 * 60_000 + 3_600_000); // mid-hour, an hour on
      const a = relayEnqueue();
      const b = relayEnqueue();
      await relayUnsentDowngradeNotices(db(), a.enqueue, now);
      await relayUnsentDowngradeNotices(db(), b.enqueue, new Date(now.getTime() + 60_000));
      const c = relayEnqueue();
      await relayUnsentDowngradeNotices(db(), c.enqueue, new Date(now.getTime() + 3_600_000));
      const keyOf = (r: ReturnType<typeof relayEnqueue>) => r.calls.find((x) => x.workspaceId === workspaceId)!.key;
      expect(keyOf(a), "two replicas in one hour: BullMQ drops the second").toBe(keyOf(b));
      expect(keyOf(c), "the next hour is a new attempt").not.toBe(keyOf(a));
    });

    it("the retry is CAPPED by age: a notice past the provider's idempotency window is no longer relayed, but counted", async () => {
      vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockRejectedValue(new Error("valkey down"));
      const workspaceId = await cutOver(`evt_${randomUUID()}`);
      const [notice] = await notices(workspaceId);
      await age(notice!.id, NOTICE_RELAY_MAX_AGE_MS + 60_000);
      const relay = relayEnqueue();
      const result = await relayUnsentDowngradeNotices(db(), relay.enqueue, new Date());
      expect(relay.calls.filter((c) => c.workspaceId === workspaceId)).toEqual([]);
      expect(result.abandoned).toBeGreaterThanOrEqual(1);
      expect(NOTICE_RELAY_MAX_AGE_MS, "inside Resend's 24 h idempotency window").toBeLessThan(24 * 3_600_000);
    });

    // Review round 2 (minor, data minimisation): the table keeps the address and the rendered body (project names). Sent
    // and abandoned rows are deleted once past the retention window; a recent row is kept (it is the dedupe key a Stripe
    // redelivery, at most three days later, relies on).
    it("rows older than the retention window are PURGED, sent or not; recent rows are kept", async () => {
      vi.spyOn(QueueProducer.prototype, "enqueueTenantJob").mockRejectedValue(new Error("valkey down"));
      const oldWs = await cutOver(`evt_${randomUUID()}`);
      const recentWs = await cutOver(`evt_${randomUUID()}`);
      const [oldNotice] = await notices(oldWs);
      const [recentNotice] = await notices(recentWs);
      await db().query("UPDATE downgrade_notices SET sent_at = now() WHERE id = ANY($1::uuid[])", [[oldNotice!.id, recentNotice!.id]]);
      await age(oldNotice!.id, NOTICE_RETENTION_MS + 60_000);
      const result = await relayUnsentDowngradeNotices(db(), relayEnqueue().enqueue, new Date());
      expect(result.purged).toBeGreaterThanOrEqual(1);
      expect(await notices(oldWs)).toEqual([]);
      expect(await notices(recentWs)).toHaveLength(1);
      expect(NOTICE_RETENTION_MS, "longer than Stripe's three-day redelivery window").toBeGreaterThan(3 * 86_400_000);
    });
  });
});
