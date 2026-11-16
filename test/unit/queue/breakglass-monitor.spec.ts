import { describe, expect, it, vi } from "vitest";
import {
  BREAKGLASS_ALERT_NAME,
  BREAKGLASS_AUDIT_ACTION,
  BreakglassLoginMonitor,
  PLATFORM_AUDIT_WORKSPACE_ID,
  readBreakglassSessions,
  recordBreakglassLogin,
  type BreakglassSession,
} from "../../../src/lib/queue/breakglass-monitor.js";
import type { Pager } from "../../../src/lib/queue/dead-letter.js";
import { MonitorRuntime, type MonitorState, type MonitorStateStore } from "../../../src/lib/queue/monitor-runtime.js";

// STORY-010 AC2 / owner decision 107(a) — a break-glass session is detected by a watcher, audited (immutable
// audit_log row, hash chain) and alerted through the existing pager, once per session.

const CANONICAL = { workspace_id: "00000000-0000-0000-0000-000000000000", actor_id: null, resource_id: null, support_grant_id: null, actor_ip: null };
const rowsFor = (sql: string): unknown[] => (/pg_advisory_xact_lock/.test(sql) ? [CANONICAL] : []);

const session = (pid: number, startMs: number | null = 1_000): BreakglassSession => ({ pid, backendStartMs: startMs });

function monitor(options: { audit?: (s: BreakglassSession) => Promise<void> } = {}) {
  const pages: Array<{ message: string; context: Record<string, unknown> }> = [];
  const pager: Pager = { page: (message, context) => void pages.push({ message, context }) };
  const audited: string[] = [];
  const nowRef = { now: 5_000 };
  const m = new BreakglassLoginMonitor({
    pager,
    clock: () => nowRef.now,
    audit:
      options.audit ??
      (async (s) => {
        audited.push(`${s.pid}`);
      }),
  });
  return { m, pages, audited, nowRef };
}

describe("STORY-010-AC2 · BreakglassLoginMonitor", () => {
  it("STORY-010-AC2 · no break-glass session: nothing is audited or paged", async () => {
    const h = monitor();
    await h.m.observe([]);
    expect(h.pages).toHaveLength(0);
    expect(h.audited).toHaveLength(0);
  });

  it("STORY-010-AC2 · a new session is audited and paged critically, with IDs only", async () => {
    const h = monitor();
    await h.m.observe([session(4242)]);
    expect(h.audited).toEqual(["4242"]);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]!.context).toMatchObject({ alertName: BREAKGLASS_ALERT_NAME, severity: "critical", pid: 4242 });
    expect(h.pages[0]!.context.sessionId).toBe("4242:1000");
  });

  it("STORY-010-AC2 · the same session seen on every later tick is not alerted or audited again", async () => {
    const h = monitor();
    await h.m.observe([session(1)]);
    await h.m.observe([session(1)]);
    await h.m.observe([session(1)]);
    expect(h.pages).toHaveLength(1);
    expect(h.audited).toHaveLength(1);
  });

  it("STORY-010-AC2 · state exported after one tick and imported by another replica does not double-alert", async () => {
    const a = monitor();
    await a.m.observe([session(1)]);
    const b = monitor();
    b.m.importState(a.m.exportState());
    await b.m.observe([session(1)]);
    expect(b.pages).toHaveLength(0);
    expect(b.audited).toHaveLength(0);
  });

  it("STORY-010-AC2 · two sessions at once are two alerts; a new session after one ends is a new alert", async () => {
    const h = monitor();
    await h.m.observe([session(1), session(2)]);
    expect(h.pages).toHaveLength(2);
    await h.m.observe([session(2)]);
    await h.m.observe([session(2), session(3, 9_000)]);
    expect(h.pages).toHaveLength(3);
  });

  it("STORY-010-AC2 · a reused pid with a different backend start is a different session", async () => {
    const h = monitor();
    await h.m.observe([session(1, 1_000)]);
    await h.m.observe([]);
    await h.m.observe([session(1, 8_000)]);
    expect(h.pages).toHaveLength(2);
  });

  it("STORY-010-AC2 · an unknown backend start (null) still alerts once, keyed on the pid", async () => {
    const h = monitor();
    await h.m.observe([session(7, null)]);
    await h.m.observe([session(7, null)]);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]!.context.sessionId).toBe("7");
  });

  it("STORY-010-AC2 · a failed audit write still alerts (once), and the audit is retried next tick without a second alert", async () => {
    let fail = true;
    const attempts: number[] = [];
    const h = monitor({
      audit: async (s) => {
        attempts.push(s.pid);
        if (fail) throw new Error("db down");
      },
    });
    await h.m.observe([session(5)]);
    expect(h.pages).toHaveLength(1);
    fail = false;
    await h.m.observe([session(5)]);
    await h.m.observe([session(5)]);
    expect(attempts).toEqual([5, 5]);
    expect(h.pages).toHaveLength(1);
  });

  it("STORY-010-AC2 · an ended session is forgotten, so the state does not grow", async () => {
    const h = monitor();
    await h.m.observe([session(1)]);
    await h.m.observe([]);
    expect(Object.keys(h.m.exportState().sessions)).toHaveLength(0);
  });
});

describe("STORY-010-AC2 · SQL", () => {
  it("STORY-010-AC2 · reads sessions of the break-glass role other than itself, mapping a null backend_start to null", async () => {
    const query = vi.fn(async () => ({
      rows: [
        { pid: 10, backend_start: new Date(2_000) },
        { pid: 11, backend_start: null },
      ],
    }));
    const sessions = await readBreakglassSessions({ query } as never);
    expect(sessions).toEqual([
      { pid: 10, backendStartMs: 2_000 },
      { pid: 11, backendStartMs: null },
    ]);
    const call = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(call[0]).toMatch(/pg_stat_activity/);
    expect(call[0]).toMatch(/pg_backend_pid\(\)/);
    expect(call[1]).toEqual(["nominara_breakglass"]);
  });

  it("STORY-010-AC2 · the audit row is a critical, system-actor row on the platform chain, set as transaction-local context, in a savepoint", async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const client = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        return { rows: rowsFor(sql), rowCount: 0 };
      }),
    };
    await recordBreakglassLogin(client as never, session(9, 3_000), "s-1");
    const sqls = calls.map((c) => c.sql);
    expect(sqls[0]).toMatch(/SAVEPOINT/);
    const ctx = calls.find((c) => /set_config/.test(c.sql))!;
    expect(ctx.sql).toMatch(/set_config\(\$1, \$2, true\)/);
    expect(ctx.params).toEqual(["app.current_workspace_id", PLATFORM_AUDIT_WORKSPACE_ID]);
    const insert = calls.find((c) => /INSERT INTO audit_log/.test(c.sql))!;
    expect(insert.params).toContain(BREAKGLASS_AUDIT_ACTION);
    expect(insert.params).toContain("critical");
    expect(insert.params).toContain("system");
    expect(insert.params).toContain("breakglass-login:s-1");
    expect(sqls.at(-1)).toMatch(/RELEASE SAVEPOINT/);
  });

  it("STORY-010-AC2 · an audit row already written for the session is not written twice", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        const dup = /request_id = /.test(sql);
        return { rows: dup ? [{ one: 1 }] : rowsFor(sql), rowCount: dup ? 1 : 0 };
      }),
    };
    await recordBreakglassLogin(client as never, session(9, 3_000), "s-1");
    expect(calls.some((s) => /INSERT INTO audit_log/.test(s))).toBe(false);
  });

  it("STORY-010-AC2 · a failed audit rolls back to the savepoint and rethrows", async () => {
    const calls: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql);
        if (/INSERT INTO audit_log/.test(sql)) throw new Error("boom");
        return { rows: rowsFor(sql), rowCount: 0 };
      }),
    };
    await expect(recordBreakglassLogin(client as never, session(9, 3_000), "s-1")).rejects.toThrow("boom");
    expect(calls.at(-1)).toMatch(/ROLLBACK TO SAVEPOINT/);
  });
});

describe("STORY-010-AC2 · through the MonitorRuntime tick", () => {
  function harness(sessions: () => BreakglassSession[]) {
    const client = {
      query: vi.fn(async (sql: string) => ({ rows: (/pg_try_advisory_xact_lock/.test(sql) ? [{ locked: true }] : []) as unknown[], rowCount: 0 })),
      release: vi.fn(),
    };
    let stored: MonitorState | null = null;
    const store: MonitorStateStore = { load: async () => stored, save: async (s) => void (stored = s) };
    const pages: Array<Record<string, unknown>> = [];
    const recorded: string[] = [];
    const runtime = new MonitorRuntime({
      pool: { connect: async () => client } as never,
      store,
      readDlqDepths: async () => new Map(),
      readLastSuccess: async () => new Map(),
      engines: [],
      pager: { page: (_m, c) => void pages.push(c) },
      readBreakglassSessions: async () => sessions(),
      recordBreakglassLogin: async (_db, s) => void recorded.push(String(s.pid)),
    });
    return { runtime, pages, recorded, current: () => stored };
  }

  it("STORY-010-AC2 · two ticks with one live session alert once, and the state carries the session across ticks", async () => {
    const h = harness(() => [session(77)]);
    await h.runtime.tick();
    await h.runtime.tick();
    expect(h.pages.filter((p) => p.alertName === BREAKGLASS_ALERT_NAME)).toHaveLength(1);
    expect(h.recorded).toEqual(["77"]);
    expect(Object.keys(h.current()!.breakglass!.sessions)).toHaveLength(1);
  });

  it("STORY-010-AC2 · a previously stored state with no break-glass section still loads", async () => {
    const h = harness(() => []);
    await expect(h.runtime.tick()).resolves.toBeUndefined();
    expect(h.current()).not.toBeNull();
  });

  it("STORY-010-AC2 · an unreadable session list does not crash the tick and forgets nothing", async () => {
    let boom = false;
    const h = harness(() => {
      if (boom) throw new Error("catalog unreadable");
      return [session(1)];
    });
    await h.runtime.tick();
    boom = true;
    await h.runtime.tick();
    boom = false;
    await h.runtime.tick();
    expect(h.pages.filter((p) => p.alertName === BREAKGLASS_ALERT_NAME)).toHaveLength(1);
  });
});
