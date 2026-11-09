import { describe, expect, it, vi } from "vitest";
import { portalTasksResponseSchema } from "../../../contracts/portal/index.js";
import { ProjectOutOfScopeError } from "../../api/errors/domain-errors.js";
import type { PortalSessionContext } from "../../api/decorators/portal-route.decorator.js";
import { PortalReadsService } from "./portal-reads.service.js";

// NEW-E-099b — PortalReadsService.tasks: scope from the session, hiding, lock, per-token cache, measured mapping.
const WS = "0198f6a0-0000-7000-8000-000000000001";
const P1 = "0198f6a0-0000-7000-8000-0000000000b1";
const P2 = "0198f6a0-0000-7000-8000-0000000000b2";

function session(over: Partial<Omit<PortalSessionContext, "policy">> & { policy?: Partial<PortalSessionContext["policy"]> } = {}): PortalSessionContext {
  const { policy, ...rest } = over;
  return {
    workspaceId: WS,
    tokenId: "0198f6a0-0000-7000-8000-0000000000a1",
    scopeProjectIds: [P1],
    scopeTabs: ["overview", "tasks"],
    themeId: null,
    // Every real session carries its facts (PortalSessionContext.facts is required); the cache key digests the theme.
    facts: { theme: { theme_id: "0198f6a0-0000-7000-8000-0000000000aa", name: "Default" } },
    policy: { label: "L", hideCompetitors: false, hideCosts: false, timeframeLock: null, ...policy },
    ...rest,
  } as unknown as PortalSessionContext;
}

const measured = { visibility_before: 40, visibility_after_14d: 44.2, delta: 4.2, window_days: 14, confidence: "medium", method: "before_after", caveat: "Observational; concurrent changes are not controlled for." };

function build(completed: unknown[] = [], open: unknown[] = []) {
  const portalTasks = vi.fn(async () => ({ completed, open }));
  const tasks = { portalTasks };
  const svc = new PortalReadsService({} as never, {} as never, {} as never, {} as never, tasks as never, {} as never);
  return { svc, portalTasks };
}

describe("NEW-E-099b · PortalReadsService.tasks", () => {
  it("STORY-099 s8 · maps completed work to title, completed_at (ISO) and measured; open work keeps its order; the result satisfies the contract", async () => {
    const { svc } = build(
      [{ title: "Done A", completed_at: new Date("2026-10-01T10:00:00Z"), measured_impact: measured }],
      [{ title: "Open 1", severity: "high", status: "todo" }, { title: "Open 2", severity: null, status: "in_progress" }],
    );
    const out = await svc.tasks(session(), { project: P1 });
    expect(portalTasksResponseSchema.parse(out)).toEqual(out);
    expect(out.completed[0]).toEqual({
      title: "Done A",
      completed_at: "2026-10-01T10:00:00.000Z",
      measured: { delta: 4.2, confidence: "medium", window_days: 14, caveat: "Observational; concurrent changes are not controlled for." },
    });
    expect(out.open.map((o) => o.title)).toEqual(["Open 1", "Open 2"]);
    expect(out.open[1]!.severity).toBeNull();
  });

  it("STORY-099 s8 · measured is null (never 0, never a half-filled object) when the milestone carries no impact or an incomplete one", async () => {
    const { svc } = build([
      { title: "No impact", completed_at: new Date("2026-10-01T10:00:00Z"), measured_impact: null },
      { title: "Partial", completed_at: new Date("2026-10-01T10:00:00Z"), measured_impact: { delta: 3 } },
    ]);
    const out = await svc.tasks(session(), { project: P1 });
    expect(out.completed.map((c) => c.measured)).toEqual([null, null]);
  });

  it("STORY-099 s8 · a completed task with no completed_at keeps null, not the epoch", async () => {
    const { svc } = build([{ title: "x", completed_at: null, measured_impact: null }]);
    expect((await svc.tasks(session(), { project: P1 })).completed[0]!.completed_at).toBeNull();
  });

  it("STORY-098 s10 · a project outside the token's scope is 403 project_out_of_scope, and nothing is read", async () => {
    const { svc, portalTasks } = build();
    await expect(svc.tasks(session(), { project: P2 })).rejects.toBeInstanceOf(ProjectOutOfScopeError);
    expect(portalTasks).not.toHaveBeenCalled();
  });

  it("STORY-098 s10 · a tab outside scope_tabs is 403 project_out_of_scope, and nothing is read", async () => {
    const { svc, portalTasks } = build();
    await expect(svc.tasks(session({ scopeTabs: ["overview"] }), { project: P1 })).rejects.toBeInstanceOf(ProjectOutOfScopeError);
    expect(portalTasks).not.toHaveBeenCalled();
  });

  it("STORY-098 s12 · hide_costs: the payload carries no cost or capture field (key scan), and the hiding flag reaches the read", async () => {
    const { svc, portalTasks } = build([{ title: "t", completed_at: null, measured_impact: measured }], [{ title: "o", severity: "low", status: "todo" }]);
    const out = await svc.tasks(session({ policy: { hideCosts: true, hideCompetitors: true } }), { project: P1 });
    const { findCostFields } = await import("../../lib/portal/portal-view.js");
    expect(findCostFields(out)).toEqual([]);
    expect(portalTasks).toHaveBeenCalledWith(P1, expect.objectContaining({ hideCompetitors: true }));
  });

  it("STORY-098 s13 · a timeframe lock bounds completed work to that many days; no lock means unbounded", async () => {
    const locked = build();
    const before = Date.now();
    await locked.svc.tasks(session({ policy: { timeframeLock: "7d" } }), { project: P1 });
    const arg = (locked.portalTasks.mock.calls[0] as unknown as [string, { completedSince: Date | null }])[1];
    expect(arg.completedSince).toBeInstanceOf(Date);
    expect(before - arg.completedSince!.getTime()).toBeGreaterThanOrEqual(7 * 86_400_000 - 1000);
    expect(before - arg.completedSince!.getTime()).toBeLessThanOrEqual(7 * 86_400_000 + 5000);
    const free = build();
    await free.svc.tasks(session(), { project: P1 });
    expect((free.portalTasks.mock.calls[0] as unknown as [string, { completedSince: Date | null }])[1].completedSince).toBeNull();
  });

  it("STORY-099 s15 · the per-token cache: a second read by the same token is served from it; another token reads afresh", async () => {
    const { svc, portalTasks } = build();
    await svc.tasks(session(), { project: P1 });
    await svc.tasks(session(), { project: P1 });
    expect(portalTasks).toHaveBeenCalledTimes(1);
    await svc.tasks(session({ tokenId: "0198f6a0-0000-7000-8000-0000000000a2" }), { project: P1 });
    expect(portalTasks).toHaveBeenCalledTimes(2);
  });
});
