import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientBase } from "pg";
import type { AuditChainRow } from "../../../src/lib/crypto/audit-chain.js";
import type { AuditExportIncrement, AuditExportSink } from "../../../src/modules/audit/ports/export-sink.js";

// Batch 19 fix 1 - the incremental export's orphan/fork cases, against stubbed data access so the ORDER of the calls is what is asserted:
// an empty run writes no object; the intent is recorded before the objects are committed and the run is recorded after.

const calls: string[] = [];
const state = { rows: [] as AuditChainRow[], linkage: { previousManifestSha256: null as string | null, unrecordedRuns: [] as unknown[] }, recordRunError: null as Error | null };

vi.mock("../../../src/modules/audit/audit-log-reader.js", () => ({
  CHAIN_CHUNK_ROWS: 100,
  listAuditedWorkspaceIds: async () => ["ws-1"],
  iterateWorkspaceChain: async function* () {
    if (state.rows.length > 0) yield state.rows;
  },
}));
vi.mock("../../../src/modules/audit/audit-chain-marks.js", () => ({ readChainHead: async () => null }));
vi.mock("../../../src/modules/audit/audit-export-watermarks.js", () => ({
  chainRowStillMatches: async () => true,
  readWatermarks: async () => new Map(),
  readExportLinkage: async () => state.linkage,
  recordIntent: async () => void calls.push("recordIntent"),
  recordRun: async () => {
    calls.push("recordRun");
    if (state.recordRunError !== null) throw state.recordRunError;
  },
}));

const { runAuditExport } = await import("../../../src/workers/rollup/audit-export.js");

const client = { query: async () => ({ rows: [] }) } as unknown as ClientBase;
const row = (seq: string): AuditChainRow => ({ seq, workspace_id: "ws-1", prev_hash: Buffer.alloc(32), row_hash: Buffer.alloc(32, 1) }) as unknown as AuditChainRow;

/** A sink that follows the port: stream, then ask before committing, then commit and report. */
function sink(onCommit: () => void): AuditExportSink {
  return {
    async export(rows, _options, increment?: AuditExportIncrement) {
      for await (const r of rows) void r;
      if (increment !== undefined && !(await increment.beforeCommit({ dataSha256: "aa".repeat(32), manifestSha256: "bb".repeat(32) }))) return null;
      onCommit();
      calls.push("commit");
      increment?.recordWritten({ dataSha256: "aa".repeat(32), manifestSha256: "bb".repeat(32) });
      return "loc";
    },
  };
}

describe("batch 19 fix 1 - incremental export orphan and fork", () => {
  beforeEach(() => {
    calls.length = 0;
    state.rows = [];
    state.linkage = { previousManifestSha256: null, unrecordedRuns: [] };
    state.recordRunError = null;
  });

  it("STORY-020: every pending chain turning out empty returns null, never commits an object, records no intent", async () => {
    const onCommit = vi.fn();
    await expect(runAuditExport(client, sink(onCommit), { incremental: true })).resolves.toBeNull();
    expect(onCommit).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("STORY-020: the intent is recorded before the objects are committed, and the run after", async () => {
    state.rows = [row("1")];
    await expect(runAuditExport(client, sink(() => undefined), { incremental: true })).resolves.toBe("loc");
    expect(calls).toEqual(["recordIntent", "commit", "recordRun"]);
  });

  it("STORY-020: objects written but recordRun failing surfaces the failure and leaves the intent behind (the next run lists it)", async () => {
    state.rows = [row("1")];
    state.recordRunError = new Error("db down");
    await expect(runAuditExport(client, sink(() => undefined), { incremental: true })).rejects.toThrow("db down");
    expect(calls).toEqual(["recordIntent", "commit", "recordRun"]);
  });

  it("STORY-020: the next run hands the sink the last recorded manifest and the unrecorded runs it must list", async () => {
    state.rows = [row("1")];
    const orphan = { runId: "r1", manifestSha256: "cc".repeat(32), dataSha256: "dd".repeat(32) };
    state.linkage = { previousManifestSha256: "ee".repeat(32), unrecordedRuns: [orphan] };
    let seen: AuditExportIncrement | undefined;
    const spy: AuditExportSink = {
      async export(rows, options, increment) {
        seen = increment;
        return sink(() => undefined).export(rows, options, increment);
      },
    };
    await runAuditExport(client, spy, { incremental: true });
    expect(seen!.previousManifestSha256).toBe("ee".repeat(32));
    expect(seen!.unrecordedRuns).toEqual([orphan]);
  });
});
