import { Reflector } from "@nestjs/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduledReportRequestSchema } from "../../../contracts/reports/index.js";
import { API_CONTRACT_KEY } from "../../api/decorators/api-contract.decorator.js";
import { AUDIT_METADATA_KEY } from "../../api/decorators/audit.decorator.js";
import { REQUIRE_PERMISSION_KEY } from "../../api/decorators/require-permission.decorator.js";
import * as tierCaps from "../../lib/usage/tier-caps.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ScheduledReportsController } from "./scheduled-reports.controller.js";
import { ScheduledReportsService } from "./scheduled-reports.service.js";

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
  sent: Array<{ to: string; subject: string; textBody: string }>;
}

function harness(opts: { pdfCap?: unknown; row?: Record<string, unknown>; exportFails?: boolean; projects?: string[]; deliveries?: Array<Record<string, unknown>> } = {}): Harness {
  const sql: Harness["sql"] = [];
  const exportCalls: Harness["exportCalls"] = [];
  const sent: Harness["sent"] = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    sql.push({ text, params });
    if (text.includes("FROM workspaces")) return { rows: [{ timezone: "UTC" }] };
    if (text.includes("FROM projects")) return { rows: (opts.projects ?? [P1, P2]).map((id) => ({ id })) };
    if (text.includes("FROM brand_themes")) return { rows: [] };
    if (text.includes("FROM scheduled_report_deliveries")) return { rows: opts.deliveries ?? [] };
    if (text.includes("FROM scheduled_reports")) return { rows: [opts.row ?? reportRow()] };
    return { rows: [], rowCount: 1 };
  });
  vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({ client: { query }, context: { workspaceId: WS, actorId: "actor" } } as never);
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
  };
  const email = { send: vi.fn(async (m: { to: string; subject: string; textBody: string }) => void sent.push(m)) };
  const service = new ScheduledReportsService(resolver as never, usage as never, exports as never, email as never);
  return { service, sql, exportCalls, sent };
}

describe("NEW-E-100c · STORY-100 send-now", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it("s8 · a run costs zero credits and consumes ONE pdf_exports unit, however many projects it covers", async () => {
    const h = harness();
    const out = await h.service.sendNow(REPORT_ID);
    expect(out.status).toBe("logged");
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

  it("AC3 · delivery goes through the EmailSender port with a link to the artifact, and is recorded 'logged', never 'delivered'", async () => {
    const h = harness();
    const out = await h.service.sendNow(REPORT_ID);
    expect(h.sent.map((m) => m.to)).toEqual(["a@example.test", "b@example.test"]);
    expect(h.sent[0]!.textBody).toContain("0190aaaa-0000-7000-8000-00000000c10");
    expect(out.status).toBe("logged");
    expect(out.recipients).toBe(2);
    expect(out.reason).toBeNull();
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
    const [report] = await h.service.list();
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
