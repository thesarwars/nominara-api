import { Reflector } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledReportRequestSchema } from "../../../contracts/reports/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import * as tierCaps from "../../lib/usage/tier-caps.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ScheduledReportsController } from "./scheduled-reports.controller.js";
import { Logger } from "@nestjs/common";
import { DELIVERY_CONNECT_TIMEOUT_MS, DELIVERY_DRAIN_TIMEOUT_MS, STALE_SENDING_MS, ScheduledReportsService } from "./scheduled-reports.service.js";

// NEW-E-100c — STORY-100 scenarios 8, 9, 10, 15 (scenario 7 is test/unit/reports/next-send-at.spec.ts).
// The SQL itself is proved against Postgres in test/integration/scheduled-reports-http.spec.ts.

vi.mock("../../lib/usage/billing-period.js", () => ({ resolveBillingPeriod: vi.fn(async () => ({ start: "2026-10-01", end: "2026-11-01" })) }));
vi.mock("../../lib/usage/tier-caps.js", async (orig) => ({
  ...(await orig<typeof import("../../lib/usage/tier-caps.js")>()),
  provisionUsageCounters: vi.fn(async () => undefined),
  reserveTierCap: vi.fn(async () => ({ ok: true, remaining: 9, alreadyHeld: false })),
  commitTierCap: vi.fn(async () => true),
  releaseTierCap: vi.fn(async () => true),
  readCounter: vi.fn(async () => ({ limitValue: 10, usedValue: 10, reservedValue: 0 })),
}));

applyFakeApiEnv();

const WS = "0190aaaa-0000-7000-8000-000000000001";
const P1 = "0190aaaa-0000-7000-8000-0000000000a1";
const P2 = "0190aaaa-0000-7000-8000-0000000000a2";
const REPORT_ID = "0190aaaa-0000-7000-8000-0000000000b1";

function reportRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REPORT_ID, name: "Monthly", project_ids: [P1, P2], cadence: "monthly", day_of_period: 1, send_hour_local: 8,
    timeframe: "30d", format: "pdf", recipients: ["a@example.test", "b@example.test"], theme_id: null,
    include_sections: ["overview"], next_send_at: null, active: true, ...over,
  };
}

interface Harness {
  service: ScheduledReportsService;
  sql: Array<{ text: string; params: unknown[] }>;
  exportCalls: Array<{ projectId: string; body: Record<string, unknown>; key: unknown }>;
  sent: Array<{ to: string; subject: string; textBody: string; attachments?: Array<{ filename: string; content: Buffer }> }>;
  /** Runs the afterCommit tasks the request registered (i.e. "the transaction committed") and waits for the delivery to finish. */
  commit(): Promise<void>;
  /** The registered afterCommit tasks (for a test that drives timing itself). */
  tasks: Array<() => void>;
  release: ReturnType<typeof vi.fn>;
  arriveLate(): void;
  email: { send: ReturnType<typeof vi.fn>; delivers?: boolean };
}

function harness(opts: { artifactBytes?: number; pdfCap?: unknown; row?: Record<string, unknown>; exportFails?: boolean; projects?: string[]; deliveries?: Array<Record<string, unknown>>; delivers?: boolean; failFor?: string[]; replay?: boolean; poolFails?: boolean; poolHangs?: boolean; finalizeThrows?: Error } = {}): Harness {
  const sql: Harness["sql"] = [];
  const exportCalls: Harness["exportCalls"] = [];
  const sent: Harness["sent"] = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    if (text.includes("FROM workspaces")) return { rows: [{ timezone: "UTC" }] };
    if (text.includes("FROM projects")) return { rows: (opts.projects ?? [P1, P2]).map((id) => ({ id })) };
    if (text.includes("FROM brand_themes")) return { rows: [] };
    if (text.includes("FROM report_artifacts")) {
      return { rows: (params[0] as string[]).map((id) => ({ id, format: "pdf", bytes: opts.artifactBytes ?? 1000, period_end: "2026-10-31" })) };
    }
    if (text.includes("FROM scheduled_report_deliveries")) return { rows: opts.deliveries ?? [] };
    if (text.includes("FROM scheduled_reports")) return { rows: [opts.row ?? reportRow()] };
    return { rows: [], rowCount: 1 };
  });
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: { query }, context: { workspaceId: WS, actorId: "actor", scopeProjectIds: [P1] } } as never);
  const resolver = {
    resolveForWorkspace: async () => ({
      plan_key: "growth",
      entitlements: { "exports.pdf_per_cycle": { value: opts.pdfCap === undefined ? 10 : opts.pdfCap }, "exports.csv": { value: true } },
    }),
  };
  const usage = { minimumPlanFor: async () => "starter" };
  const exports = {
    export: vi.fn(async (projectId: string, body: Record<string, unknown>, key: unknown) => {
      exportCalls.push({ projectId, body, key });
      if (opts.exportFails) throw new Error("render exploded");
      return { export_id: `0190aaaa-0000-7000-8000-00000000c${exportCalls.length}0`, format: body.format };
    }),
    uploaded: vi.fn(async () => undefined),
  };
  const objects = { bind: () => ({ get: async (_ns: string, relative: string) => Buffer.from(`file:${relative}`) }) };
  const email: Harness["email"] = {
    ...(opts.delivers === undefined ? {} : { delivers: opts.delivers }),
    send: vi.fn(async (m: Harness["sent"][number]) => {
      if (opts.failFor?.includes(m.to)) throw new Error("provider down");
      sent.push(m);
    }),
  };
  // The second (post-commit) transaction runs on its own pooled client; both clients record into the same `sql` log.
  const afterCommitTasks: Array<() => void> = [];
  vi.spyOn(tenantContext, "afterCommit").mockImplementation((task) => void afterCommitTasks.push(task));
  const finalClient = { query: vi.fn(async (text: string, params: unknown[] = []) => { sql.push({ text, params }); return { rows: [], rowCount: opts.replay ? 0 : 1 }; }), release: vi.fn() };
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, _ctx, fn) => {
    if (opts.finalizeThrows) throw opts.finalizeThrows;
    return fn(finalClient as never);
  });
  let arrive: (c: typeof finalClient) => void = () => undefined;
  const pool = {
    connect: vi.fn(() => {
      if (opts.poolFails) return Promise.reject(new Error("pool exhausted"));
      if (opts.poolHangs) return new Promise<typeof finalClient>((resolve) => (arrive = resolve));
      return Promise.resolve(finalClient);
    }),
  };
  const service = new ScheduledReportsService(resolver as never, usage as never, exports as never, email as never, pool as never, objects as never);
  return {
    service, sql, exportCalls, sent, email, tasks: afterCommitTasks, release: finalClient.release, arriveLate: () => arrive(finalClient),
    async commit() {
      for (const task of afterCommitTasks.splice(0)) task();
      await service.settled();
    },
  };
}

describe("NEW-E-100c · STORY-100 send-now", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("s8 · a run costs zero credits and consumes ONE pdf_exports unit, however many projects it covers", async () => {
    const h = harness();
    const out = await h.service.sendNow(REPORT_ID);
    expect(out.status).toBe("sending");
    expect(tierCaps.reserveTierCap).toHaveBeenCalledTimes(1);
    expect(vi.mocked(tierCaps.reserveTierCap).mock.calls[0]![1]).toMatchObject({ metric: "pdf_exports", quantity: 1 });
    expect(tierCaps.commitTierCap).toHaveBeenCalledTimes(1);
    expect(h.exportCalls).toHaveLength(2);
    expect(h.exportCalls.every((c) => c.key === undefined)).toBe(true); // the export path must not commit a unit per project
    expect(h.sql.some((s) => /(INSERT INTO|UPDATE)\s+credit/i.test(s.text))).toBe(false);
  });

  it("s8 · a csv-only report consumes no pdf unit", async () => {
    const h = harness({ row: reportRow({ format: "csv" }) });
    await h.service.sendNow(REPORT_ID);
    expect(tierCaps.reserveTierCap).not.toHaveBeenCalled();
    expect(h.exportCalls.every((c) => c.body.format === "csv")).toBe(true);
  });

  it("s9 · a tier with ZERO allowance is 403 feature_not_in_plan: nothing reserved, nothing built, nothing sent", async () => {
    const h = harness({ pdfCap: 0 });
    await expect(h.service.sendNow(REPORT_ID)).rejects.toMatchObject({ code: "feature_not_in_plan" });
    expect(tierCaps.reserveTierCap).not.toHaveBeenCalled();
    expect(h.exportCalls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("s10 · at the cap the run is skipped: a skipped_cap delivery AND a notification naming the cap and the reset date", async () => {
    vi.mocked(tierCaps.reserveTierCap).mockResolvedValueOnce({ ok: false });
    const h = harness();
    const out = await h.service.sendNow(REPORT_ID);
    expect(out.status).toBe("skipped_cap");
    expect(out.reason).toContain("10");
    expect(out.reason).toContain("2026-11-01");
    expect(out.recipients).toBe(0);
    const delivery = h.sql.find((s) => s.text.includes("INSERT INTO scheduled_report_deliveries"));
    expect(delivery?.params).toContain("skipped_cap");
    const note = h.sql.find((s) => s.text.includes("INSERT INTO notifications"));
    expect(note).toBeDefined();
    const flat = note!.text + JSON.stringify(note!.params);
    expect(flat).toContain("report.skipped_cap");
    expect(flat).toContain("10");
    expect(flat).toContain("2026-11-01");
    expect(h.exportCalls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(tierCaps.commitTierCap).not.toHaveBeenCalled();
  });

  it("AC3 · delivery goes through the EmailSender port with the file ATTACHED (8 MiB or less), and is recorded 'logged', never 'delivered', for a sender that delivers to nobody", async () => {
    const h = harness();
    const out = await h.service.sendNow(REPORT_ID);
    expect(h.sent).toHaveLength(0); // nothing is sent until the transaction has committed
    await h.commit();
    expect(h.sent.map((m) => m.to)).toEqual(["a@example.test", "b@example.test"]);
    // STORY-180: the bytes come from the reports bucket; there is no link for a small file and no app-origin link at all.
    expect(h.sent[0]!.attachments!.map((a) => a.content.toString())).toEqual(["file:0190aaaa-0000-7000-8000-00000000c10.pdf", "file:0190aaaa-0000-7000-8000-00000000c20.pdf"]);
    expect(h.sent[0]!.textBody).not.toContain("report-artifacts");
    expect(h.sent[0]!.textBody).not.toContain("report-links");
    expect(h.sql.some((s) => /UPDATE report_artifacts SET link_token_hash/.test(s.text))).toBe(false);
    expect(out.status).toBe("sending");
    const final = h.sql.find((s) => /UPDATE scheduled_report_deliveries SET status/.test(s.text))!;
    expect(final.params.slice(1)).toEqual(["logged", null, 2]);
  });

  it("STORY-180 AC3 · a file over 8 MiB is a 7-day link whose token hash is stored in the request transaction, and is not attached", async () => {
    const h = harness({ artifactBytes: 8_388_609 });
    await h.service.sendNow(REPORT_ID);
    // Stored BEFORE the commit (it is in the request's transaction), one per artifact.
    expect(h.sql.filter((s) => /UPDATE report_artifacts SET link_token_hash/.test(s.text))).toHaveLength(2);
    await h.commit();
    expect(h.sent[0]!.attachments ?? []).toHaveLength(0);
    expect(h.sent[0]!.textBody).toContain(`/v1/report-links/${WS}/`);
    expect(h.sent[0]!.textBody).toContain("7 days");
  });

  it("STORY-180 AC3 · a file exactly 8 MiB is still attached", async () => {
    const h = harness({ artifactBytes: 8_388_608 });
    await h.service.sendNow(REPORT_ID);
    await h.commit();
    expect(h.sent[0]!.attachments).toHaveLength(2);
    expect(h.sent[0]!.textBody).not.toContain("report-links");
  });

  it("a sender that really delivers (Resend) finishes `delivered`", async () => {
    const h = harness({ delivers: true });
    await h.service.sendNow(REPORT_ID);
    await h.commit();
    const final = h.sql.find((s) => /UPDATE scheduled_report_deliveries SET status/.test(s.text))!;
    expect(final.params.slice(1)).toEqual(["delivered", null, 2]);
    expect(h.sql.some((s) => /UPDATE scheduled_reports SET last_sent_at/.test(s.text))).toBe(true);
  });

  it("a partial send finishes `failed` with the N-of-M text, the successes counted, and last_error set", async () => {
    const h = harness({ delivers: true, failFor: ["b@example.test"] });
    await h.service.sendNow(REPORT_ID);
    await h.commit();
    const final = h.sql.find((s) => /UPDATE scheduled_report_deliveries SET status/.test(s.text))!;
    expect(final.params.slice(1)).toEqual(["failed", "1 of 2 recipients could not be sent", 1]);
    expect(h.sql.some((s) => /UPDATE scheduled_reports SET last_error/.test(s.text))).toBe(true);
  });

  it("the request never touches the sender: with the commit withheld, nothing is sent", async () => {
    const h = harness({ delivers: true });
    await h.service.sendNow(REPORT_ID);
    expect(h.email.send).not.toHaveBeenCalled();
  });

  it("the second transaction carries the request's FULL tenant context, project scope included", async () => {
    const h = harness({ delivers: true });
    await h.service.sendNow(REPORT_ID);
    await h.commit();
    expect(vi.mocked(tenantContext.withTenantContext).mock.calls[0]![1]).toEqual({ workspaceId: WS, actorId: "actor", scopeProjectIds: [P1] });
  });

  it("each delivery is counted once, at its FINAL status: `sending` is never counted", async () => {
    const lines: string[] = [];
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => void lines.push(JSON.stringify(m)));
    try {
      const h = harness({ delivers: true });
      await h.service.sendNow(REPORT_ID);
      await h.commit();
    } finally {
      log.mockRestore();
    }
    const counted = lines.filter((l) => l.includes("nominara_reports_scheduled_deliveries_total"));
    expect(counted).toHaveLength(1);
    expect(counted[0]).toContain('"status":"delivered"');
  });

  it("onModuleDestroy waits for an in-flight delivery, and is bounded when one never ends", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ delivers: true });
      let release: () => void = () => undefined;
      h.email.send.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
      await h.service.sendNow(REPORT_ID);
      for (const task of h.tasks.splice(0)) task();
      await vi.advanceTimersByTimeAsync(5); // setImmediate: the delivery starts and blocks in the sender
      let drained = false;
      const draining = h.service.onModuleDestroy().then(() => void (drained = true));
      await vi.advanceTimersByTimeAsync(DELIVERY_DRAIN_TIMEOUT_MS - 1);
      expect(drained, "shutdown did not wait for the in-flight delivery").toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await draining;
      expect(drained).toBe(true); // bounded: the never-ending send did not hold shutdown
      release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shutdown: a delivery that has not begun when onModuleDestroy runs sends NOTHING and is best-effort recorded `failed`", async () => {
    const h = harness({ delivers: true });
    await h.service.sendNow(REPORT_ID);
    await h.service.onModuleDestroy(); // sets `stopping` first; nothing in flight yet
    await h.commit();
    expect(h.email.send).not.toHaveBeenCalled();
    const final = h.sql.find((s) => /UPDATE scheduled_report_deliveries SET status/.test(s.text))!;
    expect(final.params.slice(1)).toEqual(["failed", "server shutting down before send", 0]);
  });

  it("shutdown: if even the best-effort record fails, nothing throws and nothing was sent (the row stays `sending`)", async () => {
    const h = harness({ delivers: true, poolFails: true });
    await h.service.sendNow(REPORT_ID);
    await h.service.onModuleDestroy();
    await expect(h.commit()).resolves.toBeUndefined();
    expect(h.email.send).not.toHaveBeenCalled();
  });

  it("a connection-class failure while recording destroys the connection (release(error)); a normal outcome returns it", async () => {
    const lost = Object.assign(new Error("Connection terminated unexpectedly"), { code: "57P01" });
    const bad = harness({ delivers: true, finalizeThrows: lost });
    await bad.service.sendNow(REPORT_ID);
    await bad.commit();
    expect(bad.release).toHaveBeenCalledTimes(1);
    expect(bad.release.mock.calls[0]![0]).toBe(lost);

    const good = harness({ delivers: true });
    await good.service.sendNow(REPORT_ID);
    await good.commit();
    expect(good.release.mock.calls[0]![0]).toBeUndefined();
  });

  it("recording waits a BOUNDED time for a pooled connection, and a connection that arrives late is released, not leaked", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ delivers: true, poolHangs: true });
      await h.service.sendNow(REPORT_ID);
      for (const task of h.tasks.splice(0)) task();
      await vi.advanceTimersByTimeAsync(5);
      await vi.advanceTimersByTimeAsync(DELIVERY_CONNECT_TIMEOUT_MS + 1);
      await h.service.settled(); // the delivery gave up recording instead of waiting forever
      h.arriveLate();
      await vi.advanceTimersByTimeAsync(5);
      expect(h.release).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a replayed finalisation (row already moved) changes nothing else", async () => {
    const h = harness({ delivers: true, replay: true });
    await h.service.sendNow(REPORT_ID);
    await h.commit();
    expect(h.sql.some((s) => /UPDATE scheduled_reports SET (last_sent_at|last_error)/.test(s.text))).toBe(false);
  });

  it("a `sending` row the DATABASE flags stale reads as `failed`; one it does not flag reads `sending` (staleness is judged on the DB clock, not this host's)", async () => {
    const old = new Date(Date.now() - STALE_SENDING_MS - 60_000).toISOString();
    const fresh = new Date().toISOString();
    const h = harness({
      deliveries: [
        { id: "0190aaaa-0000-7000-8000-0000000000d2", scheduled_report_id: REPORT_ID, attempted_at: fresh, status: "sending", reason: null, recipient_count: 0, stale: false },
        { id: "0190aaaa-0000-7000-8000-0000000000d1", scheduled_report_id: REPORT_ID, attempted_at: old, status: "sending", reason: null, recipient_count: 0, stale: true },
      ],
    });
    const page = await h.service.list({ limit: 10 } as never);
    expect(page.items[0]!.deliveries.map((d) => d.status)).toEqual(["sending", "failed"]);
    // The stale decision is made in SQL, with the window as a bind parameter.
    const q = h.sql.find((s) => /FROM scheduled_report_deliveries/.test(s.text))!;
    expect(q.text).toMatch(/now\(\) - attempted_at > \$2/);
    expect(q.params[1]).toBe(STALE_SENDING_MS);
  });

  it("s15 · a failed build is listed as 'failed' with its reason, the reservation is released, and nobody is emailed", async () => {
    const h = harness({ exportFails: true });
    const out = await h.service.sendNow(REPORT_ID);
    expect(out.status).toBe("failed");
    expect(out.reason).toBeTruthy();
    expect(tierCaps.releaseTierCap).toHaveBeenCalledTimes(1);
    expect(tierCaps.commitTierCap).not.toHaveBeenCalled();
    expect(h.sent).toHaveLength(0);
    expect(h.sql.some((s) => /ROLLBACK TO SAVEPOINT/i.test(s.text))).toBe(true);
  });

  it("send-now of an unknown report is a 404", async () => {
    const h = harness();
    vi.mocked(tenantContext.currentTenantStore as never);
    const store = tenantContext.currentTenantStore()!;
    (store.client.query as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ rows: [] }));
    await expect(h.service.sendNow(REPORT_ID)).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("NEW-E-100c · STORY-100 s15 · delivery history", () => {
  afterEach(() => vi.restoreAllMocks());

  it("s15 · list() returns every attempt with its outcome and failure reason, newest first", async () => {
    const deliveries = [
      { id: "0190aaaa-0000-7000-8000-0000000000d3", scheduled_report_id: REPORT_ID, attempted_at: "2026-10-03T08:00:00.000Z", status: "skipped_cap", reason: "cap of 10 reached; resets 2026-11-01", recipient_count: 0 },
      { id: "0190aaaa-0000-7000-8000-0000000000d2", scheduled_report_id: REPORT_ID, attempted_at: "2026-10-02T08:00:00.000Z", status: "failed", reason: "render exploded", recipient_count: 0 },
      { id: "0190aaaa-0000-7000-8000-0000000000d1", scheduled_report_id: REPORT_ID, attempted_at: "2026-10-01T08:00:00.000Z", status: "logged", reason: null, recipient_count: 2 },
    ];
    const h = harness({ deliveries });
    const [report] = (await h.service.list({ limit: 50 })).items;
    expect(report!.deliveries.map((d) => [d.status, d.reason, d.recipients])).toEqual([
      ["skipped_cap", "cap of 10 reached; resets 2026-11-01", 0],
      ["failed", "render exploded", 0],
      ["logged", null, 2],
    ]);
  });
});

describe("NEW-E-100c · validation and declarations", () => {
  afterEach(() => vi.restoreAllMocks());
  const base = { label: "Monthly", project_ids: [P1], sections: ["overview"], cadence: "monthly", day: 1, hour: 8, format: "pdf", recipients: ["a@example.test"] };

  it("AC2 · recipients are validated as emails, and an unknown key is a 400 (.strict())", () => {
    expect(createScheduledReportRequestSchema.safeParse(base).success).toBe(true);
    expect(createScheduledReportRequestSchema.safeParse({ ...base, recipients: ["not-an-email"] }).success).toBe(false);
    expect(createScheduledReportRequestSchema.safeParse({ ...base, workspace_id: WS }).success).toBe(false);
  });

  it("AC2 · project_ids that are not readable in the tenant context are refused with a field path", async () => {
    const h = harness({ projects: [P1] });
    await expect(h.service.create({ ...base, project_ids: [P1, P2], timeframe: "30d", theme_id: null } as never)).rejects.toMatchObject({ code: "validation_failed" });
    expect(h.sql.some((s) => s.text.includes("INSERT INTO scheduled_reports"))).toBe(false);
  });

  it("AC2 · a day outside the cadence's range (weekly day 9) is refused before any write", async () => {
    const h = harness();
    await expect(h.service.create({ ...base, cadence: "weekly", day: 9, timeframe: "30d", theme_id: null } as never)).rejects.toMatchObject({ code: "validation_failed" });
    expect(h.sql.some((s) => s.text.includes("INSERT INTO scheduled_reports"))).toBe(false);
  });

  it("AC2 · a pinned theme that is not this workspace's is refused", async () => {
    const h = harness();
    await expect(h.service.create({ ...base, timeframe: "30d", theme_id: "0190aaaa-0000-7000-8000-0000000000e1" } as never)).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("AC2/AC4 · every route needs agency:branding; create, update, delete and send-now are audited; each has an ApiContract", () => {
    const reflector = new Reflector();
    for (const name of ["list", "create", "update", "remove", "sendNow"] as const) {
      const handler = ScheduledReportsController.prototype[name];
      expect(reflector.get(REQUIRE_PERMISSION_KEY, handler), name).toBe("agency:branding");
      expect(reflector.get(API_CONTRACT_KEY, handler), name).toBeDefined();
    }
    for (const name of ["create", "update", "remove", "sendNow"] as const) {
      expect(reflector.get(AUDIT_METADATA_KEY, ScheduledReportsController.prototype[name]), name).toBeDefined();
    }
    expect(reflector.get(AUDIT_METADATA_KEY, ScheduledReportsController.prototype.list)).toBeUndefined();
  });
});
