import { describe, expect, it } from "vitest";
import { readExportScope } from "./scope.js";

// STORY-185 AC1/AC2 - what the export covers: the purge DATE minus the NEW window, for each window the change shortens.

const DAY = 86_400_000;
const NOW = new Date("2026-11-12T12:00:00Z");
const UNTIL = new Date(NOW.getTime() + 15 * DAY);

function tx(row: Record<string, unknown> | undefined) {
  return { query: async () => ({ rows: row === undefined ? [] : [row] }) } as never;
}
// Arbitrary windows, not the plan matrix's: the scope arithmetic must not depend on any plan's values.
const base = { until: UNTIL, deferred_raw: 100, deferred_rollups: 500, raw: 45, rollups: 200 };

describe("STORY-185 · readExportScope", () => {
  it("AC1 · both windows shortened: each cutoff is the purge date minus the new window", async () => {
    const scope = await readExportScope(tx(base), "w", NOW);
    expect(scope?.purgeNotBefore).toEqual(UNTIL);
    expect(scope?.raw).toEqual({ windowDays: 45, cutoff: new Date(UNTIL.getTime() - 45 * DAY) });
    expect(scope?.rollups).toEqual({ windowDays: 200, cutoff: new Date(UNTIL.getTime() - 200 * DAY) });
  });

  it("AC1 · only the window that moved is in scope", async () => {
    expect((await readExportScope(tx({ ...base, deferred_rollups: 200 }), "w", NOW))?.rollups).toBeNull();
    expect((await readExportScope(tx({ ...base, deferred_raw: 45 }), "w", NOW))?.raw).toBeNull();
    expect((await readExportScope(tx({ ...base, deferred_raw: 45 }), "w", NOW))?.rollups).not.toBeNull();
  });

  it("AC1 · a deferred window of null (the replaced plan never purged) puts the section in scope when the new one is a number", async () => {
    const scope = await readExportScope(tx({ ...base, deferred_rollups: null }), "w", NOW);
    expect(scope?.rollups?.windowDays).toBe(200);
  });

  it("AC1 · cancel to Free: the new plan has no rollup window (null), so only raw is in scope", async () => {
    const scope = await readExportScope(tx({ ...base, deferred_raw: 150, deferred_rollups: 300, raw: 20, rollups: null }), "w", NOW);
    expect(scope?.raw?.windowDays).toBe(20);
    expect(scope?.rollups).toBeNull();
  });

  it("AC1 · a new window that is unlimited purges nothing, so nothing is in scope and there is no export to offer", async () => {
    expect(await readExportScope(tx({ ...base, raw: "unlimited", rollups: "unlimited" }), "w", NOW)).toBeNull();
  });

  it("AC2 · no deferral pending: none. Pending at the very instant it ends still counts (the side that keeps data); one millisecond later it does not", async () => {
    expect(await readExportScope(tx({ ...base, until: null }), "w", NOW)).toBeNull();
    expect(await readExportScope(tx({ ...base, until: NOW }), "w", NOW)).not.toBeNull();
    expect(await readExportScope(tx({ ...base, until: new Date(NOW.getTime() - 1) }), "w", NOW)).toBeNull();
  });

  it("a workspace that is not found (or deleted) has no scope", async () => {
    expect(await readExportScope(tx(undefined), "w", NOW)).toBeNull();
  });
});
