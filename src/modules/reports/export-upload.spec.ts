import { afterEach, describe, expect, it, vi } from "vitest";
import * as metrics from "../../lib/telemetry/metrics.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { ExportService } from "./export.service.js";

// STORY-180 AC1 - the upload runs AFTER the request transaction commits, and a second short transaction records the real key.

const WS = "0190cccc-0000-7000-8000-000000000001";
const ID = "0190cccc-0000-7000-8000-0000000000a1";
const context = { workspaceId: WS, actorId: "actor", scopeProjectIds: [] } as never;
const artifact = { id: ID, relativeKey: `${ID}.pdf`, file: Buffer.from("%PDF"), contentType: "application/pdf" };

function build(opts: { putFails?: boolean; recordedRows?: number; recordThrows?: boolean } = {}) {
  const tasks: Array<() => void> = [];
  vi.spyOn(tenantContext, "afterCommit").mockImplementation((t) => void tasks.push(t));
  const recorded: Array<{ text: string; params: unknown[] }> = [];
  const txClient = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      recorded.push({ text, params });
      return { rows: [], rowCount: opts.recordedRows ?? 1 };
    }),
  };
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, _ctx, fn) => {
    if (opts.recordThrows) throw new Error("db down");
    return fn(txClient as never);
  });
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ release })) };
  const order: string[] = [];
  const bound = {
    put: vi.fn(async (_ns: string, relative: string) => {
      order.push("put");
      if (opts.putFails) throw new Error("s3 down");
      return `unit/${WS}/${relative}`;
    }),
    delete: vi.fn(async () => void order.push("delete")),
  };
  const service = new ExportService({} as never, {} as never, {} as never, pool as never, {} as never);
  return { service, bound, tasks, recorded, release, pool, order };
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
    expect(h.recorded[0]!.text).toMatch(/UPDATE report_artifacts SET object_key = \$2 WHERE id = \$1 AND object_key = \$3/);
    expect(h.recorded[0]!.params).toEqual([ID, `unit/${WS}/${ID}.pdf`, `pending:${ID}`]);
    // The put finished before any pooled connection was taken: no connection is held across the upload.
    expect(h.order).toEqual(["put"]);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("a failed put is counted and logged, leaves the row pending (nothing is recorded) and never throws", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ putFails: true });
    h.service.scheduleUpload(h.bound as never, context, artifact);
    h.tasks[0]!();
    await expect(h.service.uploaded([ID])).resolves.toBeUndefined();
    expect(h.recorded).toHaveLength(0);
    expect(h.pool.connect).not.toHaveBeenCalled();
    expect(count).toHaveBeenCalledWith("nominara_reports_artifact_uploads_total", { outcome: "put_failed" });
  });

  it("a failure to record is counted and does not throw", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ recordThrows: true });
    h.service.scheduleUpload(h.bound as never, context, artifact);
    h.tasks[0]!();
    await expect(h.service.uploaded([ID])).resolves.toBeUndefined();
    expect(count).toHaveBeenCalledWith("nominara_reports_artifact_uploads_total", { outcome: "record_failed" });
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("an upload whose row was rolled back away deletes the orphan object", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const h = build({ recordedRows: 0 });
    h.service.scheduleUpload(h.bound as never, context, artifact);
    h.tasks[0]!();
    await h.service.uploaded([ID]);
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
