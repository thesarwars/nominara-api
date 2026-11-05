import { afterEach, describe, expect, it, vi } from "vitest";
import * as afterTx from "../../api/after-transaction.js";
import { DegradedError } from "../../api/errors/domain-errors.js";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { ExportService } from "./export.service.js";

// STORY-180 AC1 - the upload runs AFTER the request transaction commits, and a second short transaction records the real key.
// Round 5 (owner decision 60 (c)): the export WAITS for the upload and fails when it fails; a failed upload marks the row failed.

const WS = "0190cccc-0000-7000-8000-000000000001";
const ID = "0190cccc-0000-7000-8000-0000000000a1";
const context = { workspaceId: WS, actorId: "actor", scopeProjectIds: [] } as never;
const artifact = { id: ID, relativeKey: `${ID}.pdf`, file: Buffer.from("%PDF"), contentType: "application/pdf" };
const UNIT_KEY = "idem-key-1";
const pdfArtifact = { ...artifact, pdfUnitKey: UNIT_KEY };

function build(opts: { putFails?: boolean; recordedRows?: number; recordThrows?: boolean; deleteFails?: boolean; markFails?: boolean } = {}) {
  const order: string[] = [];
  const tasks: Array<() => void> = [];
  vi.spyOn(tenantContext, "afterCommit").mockImplementation((t) => void tasks.push(t));
  const recorded: Array<{ text: string; params: unknown[] }> = [];
  const txClient = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      recorded.push({ text, params });
      return { rows: [], rowCount: opts.recordedRows ?? 1 };
    }),
  };
  const requestTasks: Array<() => Promise<void>> = [];
  vi.spyOn(afterTx, "afterTransaction").mockImplementation((t) => (requestTasks.push(t), true));
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, _ctx, fn) => {
    // The record (UPDATE ... SET object_key = $2 ...) may fail; the mark-failed statement has its own switch.
    return fn({
      query: async (text: string, params: unknown[]) => {
        if (text.includes("SET state = 'committed'")) order.push("commit_unit");
        if (text.includes("SET state = 'released'")) order.push("release_unit");
        const isMark = typeof params[1] === "string" && (params[1] as string).startsWith("failed:");
        if (isMark) {
          order.push("mark_failed");
          if (opts.markFails) throw new Error("db down");
        } else if (opts.recordThrows) {
          throw new Error("db down");
        }
        return txClient.query(text, params);
      },
    } as never);
  });
  const audits: Array<{ action: string; afterState: unknown }> = [];
  vi.spyOn(AuditChainService.prototype, "append").mockImplementation(async (_c, input) => {
    order.push(`audit:${input.action}`);
    audits.push({ action: input.action, afterState: input.afterState });
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ release })) };
  const bound = {
    put: vi.fn(async (_ns: string, relative: string) => {
      order.push("put");
      if (opts.putFails) throw new Error("s3 down");
      return `unit/${WS}/${relative}`;
    }),
    delete: vi.fn(async () => {
      order.push("delete");
      if (opts.deleteFails) throw new Error("s3 down");
    }),
  };
  const service = new ExportService({} as never, {} as never, {} as never, pool as never, {} as never, "https://api.example.test");
  return { service, bound, tasks, recorded, release, pool, order, requestTasks, audits, txClient };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-180 AC1 · the artifact upload", () => {
  it("uploads nothing until the transaction has committed (the task is only registered)", async () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, artifact);
    expect(h.tasks).toHaveLength(1);
    expect(h.bound.put).not.toHaveBeenCalled();
    h.tasks[0]!();
    await h.service.uploaded([ID]);
    expect(h.bound.put).toHaveBeenCalledWith("reports", `${ID}.pdf`, artifact.file, { contentType: "application/pdf" });
  });

  it("records the real key in a SECOND transaction, only while the row still reads pending, and releases the connection", async () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, artifact);
    h.tasks[0]!();
    await h.service.uploaded([ID]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.text).toMatch(/UPDATE report_artifacts SET object_key = \$2 WHERE id = \$1 AND object_key = \$3 AND workspace_id = app\.current_workspace\(\)/);
    expect(h.recorded[0]!.params).toEqual([ID, `unit/${WS}/${ID}.pdf`, `pending:${ID}`]);
    // The put finished before any pooled connection was taken: no connection is held across the upload.
    expect(h.order).toEqual(["put"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("an upload whose row was rolled back away deletes the orphan object", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ recordedRows: 0 });
    h.service.scheduleUpload(h.bound as never, context, artifact);
    h.tasks[0]!();
    await expect(h.service.uploaded([ID])).rejects.toBeInstanceOf(DegradedError);
    expect(h.bound.delete).toHaveBeenCalledWith("reports", `${ID}.pdf`);
    expect(count).toHaveBeenCalledWith("nominara_reports_artifact_uploads_total", { outcome: "orphan_removed" });
  });

  it("success is counted once, and uploaded() resolves at once for an id this process never uploaded", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build();
    await expect(h.service.uploaded(["0190cccc-0000-7000-8000-0000000000ff"])).resolves.toBeUndefined();
    h.service.scheduleUpload(h.bound as never, context, artifact);
    h.tasks[0]!();
    await h.service.uploaded([ID]);
    expect(count.mock.calls.filter((c) => c[0] === "nominara_reports_artifact_uploads_total" && (c[1] as { outcome: string }).outcome === "ok")).toHaveLength(1);
  });
});

describe("STORY-180 r5 (c) + r6 · the export waits for the upload and fails when it fails", () => {
  // r6: the HTTP path does its upload INSIDE the afterTransaction task (post-commit, post-release); it registers nothing with afterCommit.
  it("registers ONE request-side task and NO afterCommit task; the put happens only when that task runs (after the connection is released)", async () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    expect(h.requestTasks).toHaveLength(1);
    expect(h.tasks).toHaveLength(0);
    expect(h.bound.put).not.toHaveBeenCalled();
    await expect(h.requestTasks[0]!()).resolves.toBeUndefined();
    expect(h.bound.put).toHaveBeenCalledTimes(1);
  });

  it("does not resolve before the put has finished (the response cannot beat the upload)", async () => {
    const h = build();
    let release!: () => void;
    h.bound.put.mockImplementation(() => new Promise<string>((r) => { release = () => r(`unit/${WS}/${ID}.pdf`); }));
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    let settled = false;
    const wait = h.requestTasks[0]!().then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    release();
    await wait;
    expect(settled).toBe(true);
  });

  it("a failed put fails the request with 503 degraded, marks the row failed (never left pending), and counts it", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ putFails: true });
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]!.text).toMatch(/SET object_key = \$2 WHERE id = \$1 AND object_key = \$3 AND workspace_id = app\.current_workspace\(\)/);
    expect(h.recorded[0]!.params).toEqual([ID, `failed:${ID}`, `pending:${ID}`]);
    expect(count).toHaveBeenCalledWith("nominara_reports_artifact_uploads_total", { outcome: "put_failed" });
    await expect(h.service.uploaded([ID])).rejects.toBeInstanceOf(DegradedError);
  });

  it("a put that landed but could not be recorded: the object is deleted FIRST (no connection held), then the row is marked failed, and the request fails", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ recordThrows: true });
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.order).toEqual(["put", "delete", "mark_failed", "audit:report.export_failed"]);
    expect(h.bound.delete).toHaveBeenCalledWith("reports", `${ID}.pdf`);
    expect(count).toHaveBeenCalledWith("nominara_reports_artifact_uploads_total", { outcome: "record_failed" });
  });

  it("when the orphan cannot be deleted the row is NOT marked (it stays pending for the retention sweep, which deletes the object first)", async () => {
    const h = build({ recordThrows: true, deleteFails: true });
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.order).toEqual(["put", "delete", "audit:report.export_failed"]);
  });

  it("a failure to mark the row failed still fails the request and never throws out of the upload", async () => {
    const h = build({ putFails: true, markFails: true });
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.release).toHaveBeenCalled();
  });

  it("the scheduled path (no awaitInRequest) registers NO request-side wait: it waits through uploaded() and holds no response", () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, artifact);
    expect(h.requestTasks).toHaveLength(0);
    expect(h.tasks).toHaveLength(1);
  });

  it("STORY-180 r6 · an awaiting export outside a request transaction THROWS (it must not answer without waiting for the file)", () => {
    const h = build();
    vi.spyOn(afterTx, "afterTransaction").mockReturnValue(false);
    expect(() => h.service.scheduleUpload(h.bound as never, context, artifact, true)).toThrow(/request transaction/);
    expect(h.tasks).toHaveLength(0);
  });
});

describe("STORY-180 r6 · the pdf_exports unit follows the stored file", () => {
  it("success: the unit is COMMITTED in the same short transaction that records the key, right after the record", async () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, pdfArtifact, true);
    await h.requestTasks[0]!();
    expect(h.order).toEqual(["put", "commit_unit", "audit:report.exported"]);
    const commit = h.recorded.find((r) => r.text.includes("SET state = 'committed'"))!;
    expect(commit.params).toEqual([WS, "pdf_exports", UNIT_KEY]);
    expect(h.recorded.some((r) => r.text.includes("SET state = 'released'"))).toBe(false);
  });

  it("an upload whose row was gone does not commit the unit (orphan_removed): the unit is RELEASED", async () => {
    const h = build({ recordedRows: 0 });
    h.service.scheduleUpload(h.bound as never, context, pdfArtifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.order).not.toContain("commit_unit");
    expect(h.order).toContain("release_unit");
    expect(h.recorded.find((r) => r.text.includes("SET state = 'released'"))!.params).toEqual([WS, "pdf_exports", UNIT_KEY]);
  });

  it("put_failed: the unit is RELEASED and never committed", async () => {
    const h = build({ putFails: true });
    h.service.scheduleUpload(h.bound as never, context, pdfArtifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.order).toContain("release_unit");
    expect(h.order).not.toContain("commit_unit");
  });

  it("record_failed: the unit is RELEASED and never committed", async () => {
    const h = build({ recordThrows: true });
    h.service.scheduleUpload(h.bound as never, context, pdfArtifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.order).toContain("release_unit");
    expect(h.order).not.toContain("commit_unit");
  });

  it("a release that itself fails never throws out of the upload (the reservation stands: the safe direction for a ceiling)", async () => {
    const h = build({ putFails: true });
    const connect = h.pool.connect as ReturnType<typeof vi.fn>;
    connect.mockResolvedValueOnce({ release: h.release }).mockRejectedValue(new Error("db down"));
    h.service.scheduleUpload(h.bound as never, context, pdfArtifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
  });

  it("a CSV (no unit key) never touches the unit", async () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    await h.requestTasks[0]!();
    expect(h.order.filter((o) => o.endsWith("_unit"))).toEqual([]);
  });
});

describe("STORY-180 r6 · the audit trail tells the truth about the outcome", () => {
  it("a failed upload appends report.export_failed (and no report.exported), carrying the outcome", async () => {
    const h = build({ putFails: true });
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    await expect(h.requestTasks[0]!()).rejects.toBeInstanceOf(DegradedError);
    expect(h.audits.map((a) => a.action)).toEqual(["report.export_failed"]);
    expect(h.audits[0]!.afterState).toEqual({ outcome: "put_failed" });
  });

  it("a stored upload appends report.exported in the SAME transaction as the record (before the connection is released)", async () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, artifact, true);
    await h.requestTasks[0]!();
    expect(h.audits.map((a) => a.action)).toEqual(["report.exported"]);
    expect(h.audits[0]!.afterState).toEqual({ outcome: "ok", format: "pdf" });
  });

  it("the scheduled path appends no audit row of its own (no actor asked for the export)", async () => {
    const h = build();
    h.service.scheduleUpload(h.bound as never, context, artifact);
    h.tasks[0]!();
    await h.service.uploaded([ID]);
    expect(h.audits).toEqual([]);
  });
});
