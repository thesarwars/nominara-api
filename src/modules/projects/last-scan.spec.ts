import { describe, expect, it } from "vitest";
import { toLastScan, type LastScanRow } from "./projects.service.js";

// STORY-175 AC1 - the row the lateral join returns, as the wire's `last_scan`.

const NONE: LastScanRow = {
  ls_run_id: null,
  ls_status: null,
  ls_trigger: null,
  ls_planned_cells: null,
  ls_skipped_cells: null,
  ls_captured_cells: null,
  ls_failed_cells: null,
  ls_started_at: null,
  ls_finished_at: null,
  ls_rolled_up: null,
};

const RUN: LastScanRow = {
  ls_run_id: "33333333-3333-7333-8333-333333333333",
  ls_status: "partial",
  ls_trigger: "manual",
  ls_planned_cells: 17,
  ls_skipped_cells: 2,
  ls_captured_cells: 11,
  ls_failed_cells: 4,
  ls_started_at: new Date("2026-10-12T13:00:00.000Z"),
  ls_finished_at: new Date("2026-10-12T13:08:00.000Z"),
  ls_rolled_up: true,
};

describe("STORY-175 · toLastScan", () => {
  it("STORY-175 AC1: a project with no capture run is null, not an empty object", () => {
    expect(toLastScan(NONE)).toBeNull();
  });

  it("STORY-175 AC1: settled_cells is captured + failed + skipped; timestamps are ISO strings; completed_at is finished_at", () => {
    expect(toLastScan(RUN)).toEqual({
      run_id: "33333333-3333-7333-8333-333333333333",
      status: "partial",
      trigger: "manual",
      planned_cells: 17,
      settled_cells: 17,
      captured_cells: 11,
      started_at: "2026-10-12T13:00:00.000Z",
      completed_at: "2026-10-12T13:08:00.000Z",
      rolled_up: true,
    });
  });

  it("STORY-175 AC1: a running run keeps null timestamps null and zero counts zero", () => {
    const out = toLastScan({
      ...RUN,
      ls_status: "queued",
      ls_planned_cells: 0,
      ls_skipped_cells: 0,
      ls_captured_cells: 0,
      ls_failed_cells: 0,
      ls_started_at: null,
      ls_finished_at: null,
      ls_rolled_up: false,
    });
    expect(out).toMatchObject({ settled_cells: 0, captured_cells: 0, planned_cells: 0, started_at: null, completed_at: null, rolled_up: false });
  });
});
