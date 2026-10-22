import { describe, expect, it, vi } from "vitest";
import { rollupDirtyKey } from "../../src/lib/cache/valkey-keys.js";
import {
  CLEAR_IF_UNCHANGED_SCRIPT,
  decodeDirtyEntry,
  encodeDirtyEntry,
  MARK_SCRIPT,
  RollupDirtySet,
  type DirtySetRedis,
} from "../../src/lib/rollup/dirty-dates.js";
import { isRealIsoDate } from "../../src/lib/rollup/iso-date.js";
import { closedDaySweepDue, dirtyDateJobKey, nextRollupSweepAfter, RollupSweepRuntime, runDirtyDateSweep } from "../../src/lib/rollup/rollup-sweep.js";
import { parseRollupRebuildArgs, RollupRebuildUsageError } from "../../src/workers/rollup/rollup-rebuild.js";

// STORY-042 AC2/AC6/AC10 — the pure parts: the 15-minute cadence, the dirty-set codec and key, the rebuild CLI's refusals.

const WS = "0192f0a0-0000-7000-8000-000000000001";
const PROJECT = "0192f0a0-0000-7000-8000-000000000002";

/** A sorted set with the two Lua scripts the real set runs, interpreted in JS. */
class FakeRedis implements DirtySetRedis {
  readonly scores = new Map<string, number>();
  get members(): Set<string> {
    return new Set(this.scores.keys());
  }
  failRead = false;
  async eval(script: string, _numKeys: number, _key: string, ...args: Array<string | number>): Promise<unknown> {
    if (script === MARK_SCRIPT) {
      const requested = Number(args[0]);
      const member = String(args[1]);
      const current = this.scores.get(member);
      const score = current !== undefined && current >= requested ? current + 1 : requested;
      this.scores.set(member, score);
      return score;
    }
    if (script === CLEAR_IF_UNCHANGED_SCRIPT) {
      let removed = 0;
      for (let i = 0; i < args.length; i += 2) {
        const member = String(args[i]);
        if (this.scores.get(member) === Number(args[i + 1])) {
          this.scores.delete(member);
          removed += 1;
        }
      }
      return removed;
    }
    throw new Error("unknown script");
  }
  async zrem(_key: string, ...members: string[]): Promise<number> {
    let removed = 0;
    for (const m of members) if (this.scores.delete(m)) removed += 1;
    return removed;
  }
  async zrange(_key: string, _start: number, stop: string, _withScores: "WITHSCORES"): Promise<string[]> {
    if (this.failRead) throw new Error("valkey down");
    const ordered = [...this.scores].sort((a, b) => a[1] - b[1]).slice(0, Number(stop) + 1);
    return ordered.flatMap(([member, score]) => [member, String(score)]);
  }
}

describe("STORY-042 AC2/AC6 · the sweep cadence: a tick every 5 minutes, the closed-day sweep on :05/:20/:35/:50", () => {
  it("fires at the next 5-minute boundary strictly after now", () => {
    expect(nextRollupSweepAfter(new Date("2026-10-22T10:07:00.000Z")).toISOString()).toBe("2026-10-22T10:10:00.000Z");
    expect(nextRollupSweepAfter(new Date("2026-10-22T10:55:59.000Z")).toISOString()).toBe("2026-10-22T11:00:00.000Z");
  });
  it("on a boundary itself, the following one", () => {
    expect(nextRollupSweepAfter(new Date("2026-10-22T10:15:00.000Z")).toISOString()).toBe("2026-10-22T10:20:00.000Z");
    expect(nextRollupSweepAfter(new Date("2026-10-22T23:55:00.000Z")).toISOString()).toBe("2026-10-23T00:00:00.000Z");
  });
  it("the closed-day sweep is due on :05/:20/:35/:50 only — so 00:20 workspace-local is a due tick in every real zone (offsets are multiples of 15 min)", () => {
    const due = (minute: number) => closedDaySweepDue(new Date(Date.UTC(2026, 9, 22, 10, minute)));
    expect([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].filter(due)).toEqual([5, 20, 35, 50]);
    // India (+5:30) 00:20 local is 18:50 UTC; Nepal (+5:45) is 18:35 UTC; Chatham (+13:45 in summer) 00:20 is 10:35 UTC.
    expect(closedDaySweepDue(new Date("2026-10-22T18:50:00Z"))).toBe(true);
    expect(closedDaySweepDue(new Date("2026-10-22T18:35:00Z"))).toBe(true);
  });
  it("a timer that fired a hair early is treated as its slot, not as the minute before", () => {
    expect(closedDaySweepDue(new Date("2026-10-22T10:19:59.990Z"))).toBe(true);
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
    redis.scores.set("garbage", 1);
    const batch = await set.peek(10);
    expect(batch.entries).toMatchObject([entry]);
    expect(batch.malformed).toBe(1);
    expect(redis.scores.has("garbage")).toBe(false);
  });
});

describe("STORY-042 AC6 · a mark that lands between the sweep's enqueue and its clear is never lost", () => {
  const entry = { workspaceId: WS, projectId: PROJECT, metricDate: "2026-10-21" };

  it("clear removes an entry only if its version is the one the sweep read", async () => {
    const set = new RollupDirtySet(new FakeRedis(), "k");
    await set.mark(entry, 1_000);
    const [seen] = (await set.peek(10)).entries;
    await set.mark(entry, 2_000);
    await set.clear([seen!]);
    expect((await set.peek(10)).entries).toHaveLength(1);
    const [again] = (await set.peek(10)).entries;
    await set.clear([again!]);
    expect((await set.peek(10)).entries).toEqual([]);
  });

  it("two marks in the same millisecond still move the version, so the second is not mistaken for the first", async () => {
    const set = new RollupDirtySet(new FakeRedis(), "k");
    await set.mark(entry, 5_000);
    const [first] = (await set.peek(10)).entries;
    await set.mark(entry, 5_000);
    await set.clear([first!]);
    expect((await set.peek(10)).entries).toHaveLength(1);
  });

  it("the sweep keeps an entry re-marked while its job was being enqueued, and asks for a NEW job key for it next time", async () => {
    const set = new RollupDirtySet(new FakeRedis(), "k");
    await set.mark(entry, 1_000);
    const keys: string[] = [];
    const racing = async (_q: "rollup.metric_daily", _w: string, _p: Record<string, unknown>, key: string): Promise<void> => {
      keys.push(key);
      await set.mark(entry, 2_000); // a late fact commits while the job is already reading
    };
    await runDirtyDateSweep(set, racing, new Date("2026-10-22T09:15:00Z"));
    const left = (await set.peek(10)).entries;
    expect(left, "the re-marked entry survives the clear").toHaveLength(1);
    await runDirtyDateSweep(set, async (_q, _w, _p, key) => void keys.push(key), new Date("2026-10-22T09:16:00Z"));
    expect(new Set(keys).size, "a newer mark is a new job — not deduplicated onto the one that missed it").toBe(2);
    expect((await set.peek(10)).entries).toEqual([]);
  });

  it("the same version asks for the same key (replicas ticking one window dedupe), a newer version does not", () => {
    expect(dirtyDateJobKey(PROJECT, "2026-10-21", 7)).toBe(dirtyDateJobKey(PROJECT, "2026-10-21", 7));
    expect(dirtyDateJobKey(PROJECT, "2026-10-21", 7)).not.toBe(dirtyDateJobKey(PROJECT, "2026-10-21", 8));
  });
});

describe("STORY-042 EC-12 · the sweep runtime (fake clock)", () => {
  const entry = { workspaceId: WS, projectId: PROJECT, metricDate: "2026-10-21" };
  const okClient = () => ({
    query: async (sql: string) => ({ rows: sql.includes("pg_roles") ? [{ can_see: true, who: "owner" }] : [] }),
    end: async () => undefined,
  });

  it("a mark at T is enqueued within one 5-minute tick, far inside the 15-minute objective", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-22T10:07:00.000Z") });
    try {
      const redis = new FakeRedis();
      const dirty = new RollupDirtySet(redis, "k");
      const enqueued: string[] = [];
      const runtime = new RollupSweepRuntime({
        connect: async () => okClient() as never,
        enqueue: async (_q, _w, _p, key) => void enqueued.push(key),
        dirty,
      });
      runtime.start();
      await dirty.mark(entry, Date.now());
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      runtime.stop();
      expect(enqueued, "enqueued by T + 5 min").toHaveLength(1);
      expect(Date.now() - new Date("2026-10-22T10:07:00.000Z").getTime()).toBeLessThanOrEqual(15 * 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the closed-day sweep connects only on a due slot; the dirty sweep runs on every tick", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-22T10:07:00.000Z") });
    try {
      let connects = 0;
      const runtime = new RollupSweepRuntime({
        connect: async () => {
          connects += 1;
          return okClient() as never;
        },
        enqueue: async () => undefined,
        dirty: new RollupDirtySet(new FakeRedis(), "k"),
      });
      runtime.start();
      await vi.advanceTimersByTimeAsync(10 * 60_000); // 10:10, 10:15
      expect(connects).toBe(0);
      await vi.advanceTimersByTimeAsync(5 * 60_000); // 10:20 — due
      expect(connects).toBe(1);
      runtime.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a database that cannot be reached does not stop dirty dates being reprocessed", async () => {
    const redis = new FakeRedis();
    const dirty = new RollupDirtySet(redis, "k");
    await dirty.mark(entry, 1);
    const enqueued: string[] = [];
    const runtime = new RollupSweepRuntime({
      connect: async () => {
        throw new Error("db down");
      },
      enqueue: async (_q, _w, _p, key) => void enqueued.push(key),
      dirty,
      clock: () => new Date("2026-10-22T10:20:00.000Z"),
    });
    const result = await runtime.tick();
    expect(result.closedDay).toBeNull();
    expect(result.dirtyDate).toMatchObject({ status: "complete", enqueued: 1 });
    expect(enqueued).toHaveLength(1);
  });

  it("a Valkey that cannot be read does not stop the closed-day sweep", async () => {
    const redis = new FakeRedis();
    redis.failRead = true;
    let connects = 0;
    const runtime = new RollupSweepRuntime({
      connect: async () => {
        connects += 1;
        return okClient() as never;
      },
      enqueue: async () => undefined,
      dirty: new RollupDirtySet(redis, "k"),
      clock: () => new Date("2026-10-22T10:20:00.000Z"),
    });
    const result = await runtime.tick();
    expect(result.dirtyDate).toBeNull();
    expect(result.closedDay).toMatchObject({ status: "complete" });
    expect(connects).toBe(1);
  });
});

describe("STORY-042 AC10 · one date check, shared", () => {
  it("accepts a real date and refuses every impossible one without throwing", () => {
    expect(isRealIsoDate("2024-02-29")).toBe(true);
    expect(isRealIsoDate("2026-10-22")).toBe(true);
    for (const bad of ["2026-13-01", "2026-00-10", "2026-02-30", "2025-02-29", "2026-1-1", "2026-10-32", "", "x"]) expect(isRealIsoDate(bad), bad).toBe(false);
  });
  it("the rebuild CLI reports an impossible month as a usage error, not a RangeError", () => {
    const argv = ["--workspace", WS, "--project", PROJECT, "--from", "2026-13-01", "--to", "2026-13-02", "--operator", "ana", "--ticket", "T"];
    expect(() => parseRollupRebuildArgs(argv)).toThrow(RollupRebuildUsageError);
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
