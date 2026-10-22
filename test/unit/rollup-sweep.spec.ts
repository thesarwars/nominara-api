import { describe, expect, it } from "vitest";
import { rollupDirtyKey } from "../../src/lib/cache/valkey-keys.js";
import { decodeDirtyEntry, encodeDirtyEntry, RollupDirtySet, type DirtySetRedis } from "../../src/lib/rollup/dirty-dates.js";
import { nextRollupSweepAfter } from "../../src/lib/rollup/rollup-sweep.js";
import { parseRollupRebuildArgs, RollupRebuildUsageError } from "../../src/workers/rollup/rollup-rebuild.js";

// STORY-042 AC2/AC6/AC10 — the pure parts: the 15-minute cadence, the dirty-set codec and key, the rebuild CLI's refusals.

const WS = "0192f0a0-0000-7000-8000-000000000001";
const PROJECT = "0192f0a0-0000-7000-8000-000000000002";

class FakeRedis implements DirtySetRedis {
  readonly members = new Set<string>();
  async sadd(_key: string, ...members: string[]): Promise<number> {
    let added = 0;
    for (const m of members) if (!this.members.has(m)) { this.members.add(m); added += 1; }
    return added;
  }
  async srem(_key: string, ...members: string[]): Promise<number> {
    let removed = 0;
    for (const m of members) if (this.members.delete(m)) removed += 1;
    return removed;
  }
  async sscan(_key: string, _cursor: string, _countToken: "COUNT", _count: number): Promise<[string, string[]]> {
    return ["0", [...this.members]];
  }
}

describe("STORY-042 AC2 · the sweep cadence is every 15 minutes on the quarter hour", () => {
  it("fires at the next :00/:15/:30/:45 strictly after now", () => {
    expect(nextRollupSweepAfter(new Date("2026-10-22T10:07:00.000Z")).toISOString()).toBe("2026-10-22T10:15:00.000Z");
    expect(nextRollupSweepAfter(new Date("2026-10-22T10:45:59.000Z")).toISOString()).toBe("2026-10-22T11:00:00.000Z");
  });
  it("on a boundary itself, the following quarter", () => {
    expect(nextRollupSweepAfter(new Date("2026-10-22T10:15:00.000Z")).toISOString()).toBe("2026-10-22T10:30:00.000Z");
    expect(nextRollupSweepAfter(new Date("2026-10-22T23:45:00.000Z")).toISOString()).toBe("2026-10-23T00:00:00.000Z");
  });
});

describe("STORY-042 AC6 · the rollup_dirty set", () => {
  it("lives under the environment namespace", () => {
    expect(rollupDirtyKey("production")).toBe("production:global:rollup_dirty");
    expect(rollupDirtyKey("staging")).not.toBe(rollupDirtyKey("production"));
  });

  it("round-trips an entry and refuses anything malformed", () => {
    const entry = { workspaceId: WS, projectId: PROJECT, metricDate: "2026-10-21" };
    expect(decodeDirtyEntry(encodeDirtyEntry(entry))).toEqual(entry);
    for (const bad of ["", "x", `${WS}|${PROJECT}`, `${WS}|${PROJECT}|2026-13-45`, `${WS}|not-a-uuid|2026-10-21`, `${WS}|${PROJECT}|2026-10-21|extra`]) {
      expect(decodeDirtyEntry(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("marking the same date twice is one entry", async () => {
    const redis = new FakeRedis();
    const set = new RollupDirtySet(redis, "k");
    const entry = { workspaceId: WS, projectId: PROJECT, metricDate: "2026-10-21" };
    await set.mark(entry);
    await set.mark(entry);
    expect(redis.members.size).toBe(1);
  });

  it("malformed members are dropped and counted, never returned", async () => {
    const redis = new FakeRedis();
    const set = new RollupDirtySet(redis, "k");
    const entry = { workspaceId: WS, projectId: PROJECT, metricDate: "2026-10-21" };
    await set.mark(entry);
    redis.members.add("garbage");
    const batch = await set.peek(10);
    expect(batch.entries).toEqual([entry]);
    expect(batch.malformed).toBe(1);
    expect(redis.members.has("garbage")).toBe(false);
  });
});

describe("STORY-042 AC10 · rollup:rebuild argument parsing", () => {
  const ok = ["--workspace", WS, "--project", PROJECT, "--from", "2026-09-01", "--to", "2026-09-30", "--operator", "ana", "--ticket", "OPS-1"];
  it("accepts a complete command", () => {
    expect(parseRollupRebuildArgs(ok)).toEqual({ workspaceId: WS, projectId: PROJECT, fromDate: "2026-09-01", toDate: "2026-09-30", operator: "ana", ticket: "OPS-1" });
  });
  it.each(["--workspace", "--project", "--from", "--to", "--operator", "--ticket"])("refuses a command missing %s", (flag) => {
    const argv = [...ok];
    const at = argv.indexOf(flag);
    argv.splice(at, 2);
    expect(() => parseRollupRebuildArgs(argv)).toThrow(RollupRebuildUsageError);
  });
  it("refuses a reversed or impossible range and non-uuid ids", () => {
    const swap = (flag: string, value: string) => ok.map((v, i) => (ok[i - 1] === flag ? value : v));
    expect(() => parseRollupRebuildArgs(swap("--from", "2026-10-01"))).toThrow(RollupRebuildUsageError);
    expect(() => parseRollupRebuildArgs(swap("--to", "2026-02-30"))).toThrow(RollupRebuildUsageError);
    expect(() => parseRollupRebuildArgs(swap("--project", "nope"))).toThrow(RollupRebuildUsageError);
  });
});
