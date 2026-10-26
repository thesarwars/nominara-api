import type { ClientBase } from "pg";
import { describe, expect, it } from "vitest";
import { commitPreparedRun, type PreparedRun, type ReportRunDeps } from "../../../src/lib/reports/run-scheduled-report.js";

// STORY-100 - the workspace timezone that decides the next local send hour is read BY ID, never "the first row RLS lets through":
// on a connection that bypasses RLS an unfiltered read would take an arbitrary workspace's zone.

const WS = "018bcfe5-0000-7000-8000-000000000001";
const REPORT = "018bcfe5-0000-7000-8000-000000000002";

describe("STORY-100 · settling a period", () => {
  it("reads the workspace timezone filtered by the job's workspace id", async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const tx = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        if (/FROM scheduled_reports WHERE id/.test(sql)) {
          return { rows: [{ id: REPORT, name: "r", project_ids: [], cadence: "weekly", day_of_period: 3, send_hour_local: 9, next_send_at: new Date(0), active: true }], rowCount: 1 };
        }
        if (/FROM workspaces/.test(sql)) return { rows: [{ timezone: "UTC" }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as ClientBase;
    const prepared: PreparedRun = { workspaceId: WS, reportId: REPORT, reportName: "r", period: new Date(0), deliveryId: REPORT, recipients: [], artifacts: [], sender: {}, finalAttempt: false };
    await commitPreparedRun(tx, {} as ReportRunDeps, prepared, { sent: 0, failed: 0, suppressed: 0, delivers: true });
    const tz = calls.find((c) => /FROM workspaces/.test(c.sql))!;
    expect(tz.sql).toMatch(/WHERE id = \$1/);
    expect(tz.params).toEqual([WS]);
  });
});
