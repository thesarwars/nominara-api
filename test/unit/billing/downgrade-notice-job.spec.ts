import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { Job } from "bullmq";
import type { ClientBase, Pool } from "pg";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { downgradeNoticeJobKey } from "../../../src/lib/billing/downgrade-notice-outbox.js";
import { signQueueJobPayload } from "../../../src/lib/queue/envelope.js";
import { handlerFor, type QueueHandlerContext } from "../../../src/lib/queue/handlers.js";
import { createBillingDowngradeNoticeHandler } from "../../../src/lib/queue/handlers/billing-downgrade-notice.handler.js";
import type { RotatingSigningKeys } from "../../../src/lib/queue/signing.js";
import { topologyFor } from "../../../src/lib/queue/topology.js";
import { createJobProcessor, phasesOf } from "../../../src/lib/queue/worker-factory.js";
import type { EmailMessage, EmailSender } from "../../../src/modules/identity/ports/email-sender.js";

// STORY-077 — OWNER DECISION 2026-10-23 (2): the downgrade pause/resume email is RETRIED on failure. The cut-over records
// each email in `downgrade_notices` inside its own transaction (keyed by the Stripe event id or the operator's ticket, and
// the kind), and a signed tenant job `billing.downgrade_notice` sends it. ADR-0003: the send runs in `run`, with no
// transaction and no pooled connection checked out; `commit` marks it sent.
//
// Hazards:
//   * a failed send is swallowed (the old inline path logged it and moved on): the job must FAIL so the queue retries;
//   * a retry, a stalled-job redelivery or a Stripe redelivery sends the same email twice;
//   * the send happens inside an open transaction or with a connection checked out (ADR-0003, NFR-ARCH-04);
//   * the payload carries the address or the body (it carries ids only; the row is read live);
//   * the job key differs between two enqueues of the same notice, so BullMQ cannot drop the duplicate.

const WS = "11111111-1111-7111-8111-111111111111";
const NOTICE = "55555555-5555-7555-8555-555555555555";
const KEYS: RotatingSigningKeys = { current: { kid: "dgnotice-kid", key: Buffer.alloc(32, 9) } };
const ROW = { id: NOTICE, recipient: "billing@example.test", subject: "Some of your projects and prompts were paused by your plan change", text_body: "P3 paused." };

function harness(row: typeof ROW | undefined) {
  const statements: string[] = [];
  let checkedOut = 0;
  let sent = row === undefined;
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (/^\s*SELECT\b/i.test(sql) && sql.includes("downgrade_notices")) return { rows: sent || row === undefined ? [] : [row], rowCount: sent ? 0 : 1 };
      if (/^\s*UPDATE\s+downgrade_notices/i.test(sql)) {
        const changed = sent ? 0 : 1;
        sent = true;
        return { rows: [], rowCount: changed };
      }
      return { rows: [], rowCount: 0 };
    }),
  } as unknown as ClientBase;
  const context = { pool: { connect: vi.fn(async () => client) } as unknown as Pool, env: {} as never } satisfies QueueHandlerContext;
  return {
    statements,
    context,
    get checkedOut() {
      return checkedOut;
    },
    getClient: () => {
      checkedOut += 1;
      return client;
    },
    releaseClient: () => {
      checkedOut -= 1;
    },
  };
}

function signedJob(payload: Record<string, unknown> = {}): Job {
  return { data: signQueueJobPayload({ workspaceId: WS, kid: KEYS.current.kid, noticeId: NOTICE, ...payload }, KEYS.current.key) } as unknown as Job;
}

function senderThat(behaviour: (message: EmailMessage) => Promise<void>): EmailSender & { calls: EmailMessage[] } {
  const calls: EmailMessage[] = [];
  return {
    calls,
    send: vi.fn(async (message: EmailMessage) => {
      calls.push(message);
      await behaviour(message);
    }),
  };
}

function processor(h: ReturnType<typeof harness>, sender: EmailSender) {
  return createJobProcessor(topologyFor("billing.downgrade_notice"), {
    keys: KEYS,
    getClient: h.getClient,
    releaseClient: h.releaseClient,
    process: createBillingDowngradeNoticeHandler(h.context, { sender }),
  });
}

describe("STORY-077 owner decision 2026-10-23 · the downgrade notice is a signed, idempotent, retried tenant job", () => {
  it("the queue is in the topology, tenant-scoped, with a retry ladder, and its handler is registered and PHASED (ADR-0003)", () => {
    const entry = topologyFor("billing.downgrade_notice");
    expect(entry.tenantScoped).toBe(true);
    expect(entry.retry.delaysMs.length, "a failed send is retried").toBeGreaterThanOrEqual(3);
    expect(entry.idempotencyKeyPattern).toBe("dgnotice:{workspace}:{request}:{kind}");
    const factory = handlerFor("billing.downgrade_notice");
    expect(factory, "registered").toBeDefined();
    expect(phasesOf(factory!(harness(ROW).context)), "phased: the send runs with no transaction").toBeDefined();
  });

  it("sends the recorded email once, with NO client checked out during the send, then marks it sent", async () => {
    const h = harness(ROW);
    const sender = senderThat(async () => {
      expect(h.checkedOut, "no pooled connection is held across the send").toBe(0);
    });
    await processor(h, sender)(signedJob());
    expect(sender.calls).toEqual([{ to: ROW.recipient, subject: ROW.subject, textBody: ROW.text_body, idempotencyKey: `downgrade-notice/${NOTICE}` }]);
    const update = h.statements.find((s) => /UPDATE\s+downgrade_notices/i.test(s));
    expect(update, "marked sent").toBeDefined();
    expect(update!, "only if still unsent").toMatch(/sent_at IS NULL/);
  });

  it("a FAILED send fails the job (so the queue retries it) and leaves the notice unsent", async () => {
    const h = harness(ROW);
    const failing = senderThat(async () => {
      throw new Error("resend 503");
    });
    await expect(processor(h, failing)(signedJob())).rejects.toThrow("resend 503");
    expect(h.statements.some((s) => /UPDATE\s+downgrade_notices/i.test(s)), "not marked sent").toBe(false);
    expect(h.checkedOut).toBe(0);

    // The retry sends it, with the SAME provider idempotency key, and marks it.
    const ok = senderThat(async () => undefined);
    await processor(h, ok)(signedJob());
    expect(ok.calls).toHaveLength(1);
    expect(ok.calls[0]!.idempotencyKey).toBe(failing.calls[0]!.idempotencyKey);
    expect(h.statements.some((s) => /UPDATE\s+downgrade_notices/i.test(s))).toBe(true);
  });

  it("a notice already sent (a redelivery, a duplicate enqueue) sends nothing", async () => {
    const h = harness(undefined);
    const sender = senderThat(async () => undefined);
    await processor(h, sender)(signedJob());
    expect(sender.calls).toHaveLength(0);
  });

  it("the payload carries ids only: an address or a body in it is refused before anything is sent", async () => {
    const h = harness(ROW);
    const sender = senderThat(async () => undefined);
    await expect(processor(h, sender)(signedJob({ to: "someone@example.test" }))).rejects.toThrow();
    expect(sender.calls).toHaveLength(0);
  });

  it("the job key is the same for the same event and kind, and differs by event or kind (BullMQ drops the duplicate)", () => {
    expect(downgradeNoticeJobKey(WS, "evt_1", "paused")).toBe(downgradeNoticeJobKey(WS, "evt_1", "paused"));
    expect(downgradeNoticeJobKey(WS, "evt_1", "paused")).not.toBe(downgradeNoticeJobKey(WS, "evt_1", "resumed"));
    expect(downgradeNoticeJobKey(WS, "evt_1", "paused")).not.toBe(downgradeNoticeJobKey(WS, "evt_2", "paused"));
    expect(downgradeNoticeJobKey(WS, "evt_1", "paused")).toMatch(new RegExp(`^dgnotice:${WS}:[0-9a-f]+:paused$`));
  });

  // Review round 2 (minor): the observability convention is one span and log lines that carry the workspace id. The
  // handler's lines carried the notice id only, and it opened no span, unlike billing-customer-email.handler.
  describe("observability", () => {
    const exporter = new InMemorySpanExporter();
    beforeAll(() => {
      trace.setGlobalTracerProvider(new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }));
    });
    afterEach(() => {
      exporter.reset();
      vi.restoreAllMocks();
    });
    function captureLogs(): unknown[] {
      const lines: unknown[] = [];
      for (const level of ["log", "warn", "error"] as const) vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => void lines.push(message));
      return lines;
    }

    it("a sent notice: the 'sent' line carries workspace_id, and one 'billing.downgrade_notice.send' span names the workspace", async () => {
      const lines = captureLogs();
      await processor(harness(ROW), senderThat(async () => undefined))(signedJob());
      expect(lines).toContainEqual(expect.objectContaining({ event: "billing.downgrade_notice.sent", notice_id: NOTICE, workspace_id: WS }));
      const spans = exporter.getFinishedSpans().filter((s) => s.name === "billing.downgrade_notice.send");
      expect(spans).toHaveLength(1);
      expect(spans[0]!.attributes["nominara.workspace_id"]).toBe(WS);
      expect(spans[0]!.status.code).not.toBe(SpanStatusCode.ERROR);
    });

    it("a failed send: the 'send_failed' line carries workspace_id, and the span is marked ERROR", async () => {
      const lines = captureLogs();
      await expect(processor(harness(ROW), senderThat(async () => Promise.reject(new Error("resend 503"))))(signedJob())).rejects.toThrow("resend 503");
      expect(lines).toContainEqual(expect.objectContaining({ event: "billing.downgrade_notice.send_failed", notice_id: NOTICE, workspace_id: WS }));
      const spans = exporter.getFinishedSpans().filter((s) => s.name === "billing.downgrade_notice.send");
      expect(spans).toHaveLength(1);
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    });
  });
});
