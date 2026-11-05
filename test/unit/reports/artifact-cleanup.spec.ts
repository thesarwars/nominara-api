import { afterEach, describe, expect, it, vi } from "vitest";
import { runReportArtifactCleanup, STALE_UPLOAD_MS } from "../../../src/lib/reports/artifact-cleanup.js";
import * as metrics from "../../../src/lib/telemetry/metrics.js";
import { StorageTenancyError } from "../../../src/lib/storage/storage-keys.js";
import * as tenantContext from "../../../src/tenancy/tenant-context.js";

// STORY-180 r5 (b) - the nightly report cleanup: delete the OBJECT first (no transaction open), then mark the row purged.

const WS_A = "0190ffff-0000-7000-8000-00000000000a";
const WS_B = "0190ffff-0000-7000-8000-00000000000b";
const ID1 = "0190ffff-0000-7000-8000-0000000000a1";
const ID2 = "0190ffff-0000-7000-8000-0000000000a2";
const ID3 = "0190ffff-0000-7000-8000-0000000000b1";

interface Due { id: string; workspace_id: string }
interface Row { id: string; format: string; object_key: string }

function build(opts: { discovered: Due[]; rows: Record<string, Row[]>; deleteFails?: (relative: string) => boolean; refused?: (relative: string) => boolean; markFails?: boolean }) {
  const order: string[] = [];
  const queries: Array<{ text: string; params: unknown[]; workspace: string | undefined }> = [];
  let inTx = false;
  const owner = {
    query: vi.fn(async (text: string, params: unknown[]) => {
      queries.push({ text, params, workspace: undefined });
      order.push("discover");
      return { rows: opts.discovered };
    }),
  };
  const release = vi.fn();
  const pool = { connect: vi.fn(async () => ({ release })) };
  let current: string | undefined;
  vi.spyOn(tenantContext, "withTenantContext").mockImplementation(async (_c, ctx, fn) => {
    current = ctx.workspaceId;
    inTx = true;
    try {
      return await fn({
        query: async (text: string, params: unknown[]) => {
          queries.push({ text, params, workspace: current });
          if (text.startsWith("SELECT")) {
            order.push(`select:${current}`);
            return { rows: opts.rows[current!] ?? [] };
          }
          const refuse = text.includes("'refused:'");
          order.push(`${refuse ? "refuse" : "mark"}:${current}`);
          if (opts.markFails) throw new Error("db down");
          return { rows: [], rowCount: (params[1] as string[]).length };
        },
      } as never);
    } finally {
      inTx = false;
    }
  });
  const deleted: string[] = [];
  const txOpenDuringDelete: boolean[] = [];
  const bindFor = (ws: string) => ({
    delete: vi.fn(async (_ns: string, relative: string) => {
      txOpenDuringDelete.push(inTx);
      order.push(`delete:${ws}:${relative}`);
      if (opts.deleteFails?.(relative)) throw new Error("s3 down");
      deleted.push(`${ws}/${relative}`);
    }),
    deleteStored: vi.fn(async (_ns: string, stored: string) => {
      txOpenDuringDelete.push(inTx);
      order.push(`deleteStored:${ws}:${stored}`);
      if (opts.refused?.(stored)) throw new StorageTenancyError("key outside the workspace prefix");
      if (opts.deleteFails?.(stored)) throw new Error("s3 down");
      deleted.push(stored);
    }),
  });
  const store = { bind: vi.fn(() => bindFor(current!)) };
  const run = () => runReportArtifactCleanup(owner as never, pool as never, store as never, {});
  return { run, order, queries, deleted, txOpenDuringDelete, release, pool, owner };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-180 r5 (b) · runReportArtifactCleanup", () => {
  it("discovers expired rows and stale pending/failed rows across tenants, by ids only, never an already purged row", async () => {
    const h = build({ discovered: [], rows: {} });
    await h.run();
    const q = h.queries[0]!;
    // STORY-180 r6: "due" is decided by the DATABASE clock, so a worker host with a skewed clock cannot purge a live link early or hold an
    // expired one. No timestamp travels from this process.
    expect(q.text).toContain("expires_at < now()");
    expect(q.text).toContain("object_key ~ '^(pending|failed):'");
    expect(q.text).toContain("created_at < now() - make_interval(secs => $1)");
    expect(q.text).toContain("object_key !~ '^(purged|refused):'");
    expect(q.params[0]).toBe(STALE_UPLOAD_MS / 1000);
    expect(q.params.some((p) => p instanceof Date)).toBe(false);
    expect(q.text).not.toContain("methodology_footer");
  });

  it("the stale cutoff is 24 hours: far beyond any upload, and beyond a job's retry ladder", () => {
    expect(STALE_UPLOAD_MS).toBe(24 * 3_600_000);
  });

  it("deletes the object FIRST, with no transaction open, and only then marks the row purged", async () => {
    const stored = `inttest/${WS_A}/${ID1}.pdf`;
    const h = build({ discovered: [{ id: ID1, workspace_id: WS_A }], rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: stored }] } });
    const result = await h.run();
    expect(h.order).toEqual(["discover", `select:${WS_A}`, `deleteStored:${WS_A}:${stored}`, `mark:${WS_A}`]);
    expect(h.txOpenDuringDelete).toEqual([false]);
    const mark = h.queries.at(-1)!;
    expect(mark.text).toContain("object_key = 'purged:' || id::text");
    expect(mark.text).toContain("workspace_id = app.current_workspace()");
    expect(result).toMatchObject({ status: "complete", purged: 1, failed: 0, workspaces: 1 });
  });

  it("every tenant statement carries workspace_id = app.current_workspace()", async () => {
    const h = build({ discovered: [{ id: ID1, workspace_id: WS_A }], rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: `inttest/${WS_A}/${ID1}.pdf` }] } });
    await h.run();
    for (const q of h.queries.filter((x) => x.workspace !== undefined)) expect(q.text, q.text).toContain("workspace_id = app.current_workspace()");
  });

  it("a stale pending or failed row has no key: the object at the deterministic {id}.{format} is deleted, then the row marked", async () => {
    const h = build({
      discovered: [{ id: ID1, workspace_id: WS_A }, { id: ID2, workspace_id: WS_A }],
      rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: `pending:${ID1}` }, { id: ID2, format: "csv", object_key: `failed:${ID2}` }] },
    });
    await h.run();
    expect(h.deleted).toEqual([`${WS_A}/${ID1}.pdf`, `${WS_A}/${ID2}.csv`]);
    expect(h.order.at(-1)).toBe(`mark:${WS_A}`);
  });

  it("each workspace is handled in its OWN context: one workspace's objects are never deleted under another's binding", async () => {
    const a = `inttest/${WS_A}/${ID1}.pdf`;
    const b = `inttest/${WS_B}/${ID3}.pdf`;
    const h = build({
      discovered: [{ id: ID1, workspace_id: WS_A }, { id: ID3, workspace_id: WS_B }],
      rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: a }], [WS_B]: [{ id: ID3, format: "pdf", object_key: b }] },
    });
    await h.run();
    expect(h.deleted).toEqual([a, b]);
    expect(h.queries.filter((q) => q.workspace === WS_A).every((q) => !JSON.stringify(q.params).includes(ID3))).toBe(true);
  });

  it("a row the in-workspace re-check no longer finds due is not deleted or marked (RLS and the predicate decide, not the discovery)", async () => {
    const h = build({ discovered: [{ id: ID1, workspace_id: WS_A }], rows: { [WS_A]: [] } });
    const result = await h.run();
    expect(h.deleted).toEqual([]);
    expect(h.order).toEqual(["discover", `select:${WS_A}`]);
    expect(result.purged).toBe(0);
  });

  it("an object that cannot be deleted leaves its row UNMARKED (retried tomorrow), is counted, and does not stop the rest", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const bad = `inttest/${WS_A}/${ID1}.pdf`;
    const good = `inttest/${WS_A}/${ID2}.pdf`;
    const h = build({
      discovered: [{ id: ID1, workspace_id: WS_A }, { id: ID2, workspace_id: WS_A }],
      rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: bad }, { id: ID2, format: "pdf", object_key: good }] },
      deleteFails: (k) => k === bad,
    });
    const result = await h.run();
    expect(result).toMatchObject({ status: "partial", purged: 1, failed: 1 });
    const mark = h.queries.at(-1)!;
    expect(mark.params[1]).toEqual([ID2]);
    expect(count).toHaveBeenCalledWith("nominara_reports_cleanup_objects_total", { outcome: "delete_failed" });
    expect(count).toHaveBeenCalledWith("nominara_reports_cleanup_objects_total", { outcome: "purged" });
  });

  it("STORY-180 r6 · a row refused for TENANCY reasons is quarantined as refused:<id> (not retried nightly), counted, logged, and does not fail the job or starve the batch", async () => {
    const count = vi.spyOn(metrics, "incrementCounter");
    const foreign = `inttest/${WS_B}/${ID1}.pdf`;
    const good = `inttest/${WS_A}/${ID2}.pdf`;
    const h = build({
      discovered: [{ id: ID1, workspace_id: WS_A }, { id: ID2, workspace_id: WS_A }],
      rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: foreign }, { id: ID2, format: "pdf", object_key: good }] },
      refused: (k) => k === foreign,
    });
    const result = await h.run();
    expect(result).toMatchObject({ status: "complete", purged: 1, failed: 0 });
    expect(h.deleted).toEqual([good]);
    const refuse = h.queries.find((q) => q.text.includes("'refused:'"))!;
    expect(refuse.text).toContain("object_key = 'refused:' || id::text");
    expect(refuse.text).toContain("workspace_id = app.current_workspace()");
    expect(refuse.params[1]).toEqual([ID1]);
    expect(count).toHaveBeenCalledWith("nominara_reports_cleanup_objects_total", { outcome: "refused" });
    expect(count).not.toHaveBeenCalledWith("nominara_reports_cleanup_objects_total", { outcome: "delete_failed" });
  });

  it("STORY-180 r6 · a quarantine that cannot be written fails the workspace (reported), never silently", async () => {
    const foreign = `inttest/${WS_B}/${ID1}.pdf`;
    const h = build({ discovered: [{ id: ID1, workspace_id: WS_A }], rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: foreign }] }, refused: () => true, markFails: true });
    const result = await h.run();
    expect(result.status).toBe("partial");
  });

  it("a failing workspace does not stop the others, and its failure is reported", async () => {
    const h = build({
      discovered: [{ id: ID1, workspace_id: WS_A }, { id: ID3, workspace_id: WS_B }],
      rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: `inttest/${WS_A}/${ID1}.pdf` }], [WS_B]: [{ id: ID3, format: "pdf", object_key: `inttest/${WS_B}/${ID3}.pdf` }] },
      markFails: true,
    });
    const result = await h.run();
    expect(result.status).toBe("partial");
    expect(result.workspaces).toBe(2);
    expect(result.failed).toBe(2);
    expect(h.deleted).toHaveLength(2); // both objects were attempted; the next run re-deletes (idempotent) and marks
  });

  it("nothing due is a complete run that touches no storage and no tenant", async () => {
    const h = build({ discovered: [], rows: {} });
    await expect(h.run()).resolves.toMatchObject({ status: "complete", purged: 0, workspaces: 0, failed: 0 });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });

  it("releases every pooled connection it takes", async () => {
    const h = build({ discovered: [{ id: ID1, workspace_id: WS_A }], rows: { [WS_A]: [{ id: ID1, format: "pdf", object_key: `inttest/${WS_A}/${ID1}.pdf` }] } });
    await h.run();
    expect(h.release).toHaveBeenCalledTimes(h.pool.connect.mock.calls.length);
  });
});
