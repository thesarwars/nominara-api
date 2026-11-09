import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GSC_BACKFILL_MONTHS, GSC_DATA_LAG_DAYS, GSC_RESYNC_WINDOW_DAYS, GSC_SLICE_DAYS, addDays, availableThrough, planSlice, type SlicePlan } from "./sync-plan.js";

// STORY-115 S1/S2/S6 - the frontier is stored, today is never available, backfill is resumable, the lag window is re-synced.
describe("STORY-115 sync planning", () => {
  it("S115-13a: the frontier is today minus the documented lag, never today", () => {
    expect(GSC_DATA_LAG_DAYS).toBe(3);
    expect(availableThrough("2026-11-09")).toBe("2026-11-06");
    for (let offset = 0; offset < 800; offset += 1) {
      const today = addDays("2025-01-01", offset);
      expect(availableThrough(today) < today).toBe(true);
      const plan = planSlice({ today, lastSyncDate: null });
      expect(plan!.to <= availableThrough(today)).toBe(true);
      const next = planSlice({ today, lastSyncDate: availableThrough(today) });
      expect(next!.to <= availableThrough(today)).toBe(true);
    }
  });

  it("S115-13b: a stored date beyond the frontier plans nothing rather than reaching for today", () => {
    expect(planSlice({ today: "2026-11-09", lastSyncDate: "2026-11-09" })).toBeNull();
  });

  it("S115-13c: no gsc source file outside the planner and the handler reads a clock", () => {
    const dir = join(import.meta.dirname);
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".spec.ts") && name !== "sync-plan.ts")
      .filter((name) => /Date\.now\(|new Date\(\)|CURRENT_DATE|now\(\)::date/u.test(readFileSync(join(dir, name), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("S115-7a: the first sync backfills 16 months from the oldest day, in bounded slices, and says more remains", () => {
    expect(GSC_BACKFILL_MONTHS).toBe(16);
    const plan = planSlice({ today: "2026-11-09", lastSyncDate: null })!;
    expect(plan.backfill).toBe(true);
    expect(plan.from).toBe("2025-07-09");
    expect(plan.to).toBe(addDays(plan.from, GSC_SLICE_DAYS - 1));
    expect(plan.more).toBe(true);
  });

  it("S115-7b: resuming after an interruption continues from the stored watermark and finishes at the frontier", () => {
    let last: string | null = null;
    let slices = 0;
    let done = false;
    while (!done) {
      const plan: SlicePlan = planSlice({ today: "2026-11-09", lastSyncDate: last })!;
      slices += 1;
      expect(plan.from <= plan.to).toBe(true);
      last = plan.to;
      done = !plan.more;
      expect(slices).toBeLessThan(40);
    }
    expect(last).toBe("2026-11-06");
    // The watermark is what resumes it: the next slice starts inside the lag window, not at the beginning.
    const resumed = planSlice({ today: "2026-11-09", lastSyncDate: "2026-03-01" })!;
    expect(resumed.backfill).toBe(false);
    expect(resumed.from).toBe(addDays("2026-03-01", -(GSC_RESYNC_WINDOW_DAYS - 1)));
  });

  it("S115-9: an incremental sync re-pulls the lag window, so late-arriving source data is picked up", () => {
    const plan = planSlice({ today: "2026-11-09", lastSyncDate: "2026-11-06" })!;
    expect(plan.from).toBe("2026-11-04");
    expect(plan.to).toBe("2026-11-06");
    expect(plan.more).toBe(false);
    expect(plan.backfill).toBe(false);
  });
});
