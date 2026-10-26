import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

// STORY-100 AC12 (owner decision 7): the last-attempt recovery must settle the period even when its own first move fails.
const run = vi.hoisted(() => ({
  commitPreparedRun: vi.fn(),
  settleAfterFailure: vi.fn(),
  prepareScheduledRun: vi.fn(),
  sendPreparedRun: vi.fn(),
}));
vi.mock("../../reports/run-scheduled-report.js", () => run);

import { createReportBuildHandler } from "./report-build.handler.js";
import { phasesOf } from "../worker-factory.js";

const ids = { workspaceId: "0192f0a0-0000-7000-8000-000000000001", reportId: "0192f0a0-0000-7000-8000-000000000002" };
const job = { attemptsMade: 3, opts: { attempts: 4 }, data: { payload: { ...ids, kid: "k", period: "2026-10-01T00:00:00.000Z" } } } as unknown as Job;
const prepared = { workspaceId: ids.workspaceId, reportId: ids.reportId } as never;
const fetched = { sent: 1, failed: 0 } as never;

function recover() {
  const handler = createReportBuildHandler({ pool: {} } as never, { run: {} as never, sender: {} as never });
  const phases = phasesOf(handler);
  if (phases?.recover === undefined) throw new Error("no recover hook");
  return phases.recover.bind(phases);
}
const tx = () => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  return { tx: { query } as unknown as ClientBase, query };
};

beforeEach(() => vi.resetAllMocks());

describe("STORY-100 report.build recover", () => {
  it("AC12: a commit-phase fault that recurs falls back to a failed settlement, behind a savepoint", async () => {
    run.commitPreparedRun.mockRejectedValue(new Error("deterministic"));
    const { tx: client, query } = tx();
    const done = await recover()(client, job, { phase: "commit", prepared, fetched, error: new Error("first") });
    expect(done).toBe(true);
    expect(run.settleAfterFailure).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls.map((c) => String(c[0]));
    expect(sql.some((s) => /^SAVEPOINT/.test(s))).toBe(true);
    expect(sql.some((s) => /^ROLLBACK TO SAVEPOINT/.test(s))).toBe(true);
  });

  it("AC12: a commit-phase fault that clears is settled by the commit, not as failed", async () => {
    run.commitPreparedRun.mockResolvedValue(undefined);
    const { tx: client } = tx();
    expect(await recover()(client, job, { phase: "commit", prepared, fetched, error: new Error("first") })).toBe(true);
    expect(run.settleAfterFailure).not.toHaveBeenCalled();
  });

  it("AC12: a run-phase failure says the number sent is unknown rather than reporting 0", async () => {
    const { tx: client } = tx();
    await recover()(client, job, { phase: "run", prepared, error: new Error("boom") });
    expect(run.settleAfterFailure).toHaveBeenCalledWith(client, expect.anything(), expect.objectContaining({ sentUnknown: true }));
  });
});
