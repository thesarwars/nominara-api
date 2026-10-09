import { beforeEach, describe, expect, it, vi } from "vitest";
import { NoopRealtimePublisher } from "../../lib/cache/realtime-publisher.js";
import * as tenantContext from "../../tenancy/tenant-context.js";
import { TasksService } from "./tasks.service.js";

// NEW-E-099b — the portal's task read, STORY-099 scenarios 8, 14. TasksService owns `tasks`, so the portal's read lives
// here (one table, one owning service) and the portal service calls it.
const PROJECT = "0198f6a0-0000-7000-8000-0000000000b1";
const FACT_TABLES = /\b(answer_captures|mention_facts|citation_facts|capture_runs)\b/;

interface Recorded {
  readonly sql: string;
  readonly params: unknown[];
}

describe("NEW-E-099b · TasksService.portalTasks", () => {
  let calls: Recorded[];

  function serviceReading(completed: unknown[], open: unknown[]): TasksService {
    calls = [];
    vi.spyOn(tenantContext, "currentTenantStore").mockReturnValue({
      client: {
        query: vi.fn(async (sql: string, params: unknown[]) => {
          calls.push({ sql, params });
          return { rows: /completed_at DESC/.test(sql) ? completed : open };
        }),
      },
    } as never);
    return new TasksService(new NoopRealtimePublisher());
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("STORY-099 s8 · completed items carry title, completed_at and the milestone's measured impact; open items carry title, severity, status", async () => {
    const at = new Date("2026-10-01T10:00:00Z");
    const svc = serviceReading(
      [{ title: "Add Product schema", completed_at: at, measured_impact: { delta: 4.2 } }],
      [{ title: "Fix robots.txt", severity: "high", status: "todo" }],
    );
    const out = await svc.portalTasks(PROJECT, { hideCompetitors: false, completedSince: null });
    expect(out.completed).toEqual([{ title: "Add Product schema", completed_at: at, measured_impact: { delta: 4.2 } }]);
    expect(out.open).toEqual([{ title: "Fix robots.txt", severity: "high", status: "todo" }]);
  });

  it("STORY-099 s8 · open items are ordered by impact (not by a stored position) and exclude done and dismissed tasks", async () => {
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: false, completedSince: null });
    const open = calls.find((c) => !/completed_at DESC/.test(c.sql))!;
    expect(open.sql).toMatch(/ORDER BY[\s\S]*impact_score\s+DESC/);
    expect(open.sql).toMatch(/status\s+IN\s+\('todo',\s*'in_progress'\)/);
    expect(open.sql).not.toMatch(/'dismissed'/);
    expect(open.sql).toMatch(/deleted_at IS NULL/);
  });

  it("STORY-099 s8 · completed items are tasks in status done, newest first, and a milestone hidden from the portal contributes no measurement (filtered in SQL)", async () => {
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: false, completedSince: null });
    const done = calls.find((c) => /completed_at DESC/.test(c.sql))!;
    expect(done.sql).toMatch(/status\s*=\s*'done'/);
    expect(done.sql).toMatch(/visible_in_portal/);
    expect(done.sql).toMatch(/deleted_at IS NULL/);
  });

  it("STORY-099 s14 · neither statement touches a fact table (answer_captures, mention_facts, citation_facts, capture_runs)", async () => {
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: true, completedSince: new Date() });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.sql, call.sql).not.toMatch(FACT_TABLES);
  });

  it("STORY-099 s8 · the timeframe lock bounds completed work: completedSince is a bind parameter; none means no bound", async () => {
    const since = new Date("2026-09-24T00:00:00Z");
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: false, completedSince: since });
    const locked = calls.find((c) => /completed_at DESC/.test(c.sql))!;
    expect(locked.params).toContainEqual(since);
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: false, completedSince: null });
    const free = calls.find((c) => /completed_at DESC/.test(c.sql))!;
    expect(free.params.some((p) => p instanceof Date)).toBe(false);
  });

  it("STORY-098 s11 · hide_competitors: a task born of a displacement event (it names a competitor) is excluded by the query, not the view", async () => {
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: true, completedSince: null });
    for (const call of calls) {
      expect(call.sql).toMatch(/source_displacement_id/);
      expect(call.params).toContain(true);
    }
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: false, completedSince: null });
    for (const call of calls) expect(call.params).toContain(false);
  });

  it("STORY-099 s8 · the project id is a bind parameter, and an empty project yields two empty lists (not null)", async () => {
    const out = await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: false, completedSince: null });
    for (const call of calls) expect(call.params).toContain(PROJECT);
    expect(out).toEqual({ completed: [], open: [] });
  });

  it("STORY-099 s8 · both statements are bounded (a LIMIT), so a project with thousands of tasks cannot make the portal unbounded", async () => {
    await serviceReading([], []).portalTasks(PROJECT, { hideCompetitors: false, completedSince: null });
    for (const call of calls) expect(call.sql).toMatch(/LIMIT\s+\$\d+|LIMIT\s+\d+/);
  });
});
