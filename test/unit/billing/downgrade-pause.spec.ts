import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../../src/db/seed/plan-entitlements.js";
import { pauseLimitsFrom, planDowngradePause, type PauseLimits, type PauseProject, type PausePrompt } from "../../../src/lib/billing/downgrade-pause.js";

// STORY-077 slice A — which projects and prompts the cut-over pauses, and which a later upgrade resumes.
// plans-and-entitlements.md §14: "If the choice is not made by the cut-over, the system pauses — never deletes — the
// most recently created excess projects and prompts". STORY-077 AC5: paused-by-downgrade items are distinguishable from
// user-paused ones and resume automatically on a later upgrade.
//
// The hazards these cases are written from (not from the implementation):
//   * the WRONG rows are paused (oldest instead of newest; an arbitrary order on a created_at tie);
//   * a person's pause is taken over (marked, so a later upgrade resumes something a person paused on purpose);
//   * an upgrade resumes too much (past the new limit) or the wrong end (newest first);
//   * a second delivery of the same state pauses or resumes again (it must be a fixed point);
//   * a project that never finished onboarding is resumed into the scheduler as `active`.

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (hours: number) => new Date(T0 + hours * 3_600_000);
const id = (n: number) => `0194a3d2-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** The microsecond UTC key the SQL reads (`MICROS_FORMAT`): lexicographic order is creation order. */
const key = (hours: number, micros = 0) => at(hours).toISOString().replace("Z", `${String(micros).padStart(3, "0")}Z`);
const project = (n: number, over: Partial<PauseProject> = {}): PauseProject => ({ id: id(n), createdAt: at(n), createdKey: key(n), status: "active", pausedByDowngrade: false, ...over } as PauseProject);
const prompt = (n: number, projectId: string, over: Partial<PausePrompt> = {}): PausePrompt => ({ id: id(1000 + n), projectId, createdAt: at(n), createdKey: key(n), status: "active", pausedByDowngrade: false, ...over } as PausePrompt);
const limits = (over: Partial<PauseLimits> = {}): PauseLimits => ({ projects: null, promptsTotal: null, promptsPerProject: null, ...over });

describe("STORY-077 scenario 3 · the cut-over pauses the MOST RECENTLY CREATED excess", () => {
  it("five projects against a limit of three: the two newest are paused, the three oldest untouched", () => {
    const ps = [project(1), project(2), project(3), project(4), project(5)];
    const plan = planDowngradePause(limits({ projects: 3 }), ps, []);
    expect(plan.pauseProjects).toEqual([id(5), id(4)]);
    expect(plan.resumeProjects).toEqual([]);
  });

  it("the input order does not matter: newest is decided by created_at, then id, never by array position", () => {
    const ps = [project(5), project(1), project(4), project(2), project(3)];
    expect(planDowngradePause(limits({ projects: 3 }), ps, []).pauseProjects).toEqual([id(5), id(4)]);
    // A created_at tie is broken by id, descending — the same order the preview lists them in.
    const tied = [project(1, { createdAt: at(0), createdKey: key(0) } as Partial<PauseProject>), project(2, { createdAt: at(0), createdKey: key(0) } as Partial<PauseProject>), project(3, { createdAt: at(0), createdKey: key(0) } as Partial<PauseProject>)];
    expect(planDowngradePause(limits({ projects: 1 }), tied, []).pauseProjects).toEqual([id(3), id(2)]);
  });

  it("MICROSECONDS decide, as in the preview's SQL (ORDER BY created_at DESC, id DESC): two rows in the same millisecond are not ordered by id", () => {
    // Same millisecond, different microseconds: id(1) is the NEWER row though its id is smaller. A millisecond Date would
    // tie and fall back to id, pausing id(2) - not the project the preview named.
    const ps = [
      project(1, { createdAt: at(0), createdKey: key(0, 900) } as Partial<PauseProject>),
      project(2, { createdAt: at(0), createdKey: key(0, 100) } as Partial<PauseProject>),
    ];
    expect(planDowngradePause(limits({ projects: 1 }), ps, []).pauseProjects).toEqual([id(1)]);
    const prompts = [
      prompt(1, id(1), { createdAt: at(0), createdKey: key(0, 900) } as Partial<PausePrompt>),
      prompt(2, id(1), { createdAt: at(0), createdKey: key(0, 100) } as Partial<PausePrompt>),
    ];
    expect(planDowngradePause(limits({ promptsPerProject: 1 }), [project(1)], prompts).pausePrompts).toEqual([id(1001)]);
  });

  it("an ARCHIVED project counts toward the excess exactly as the guard and the preview count it (every non-deleted project), and is never itself paused", () => {
    // The guard (structural-usage COUNTERS["projects.max"]) and the preview count 4 projects against 2, and the preview
    // names the two newest: P4 and P3. Leaving the archived P2 out would count 3 and pause only P4.
    const ps = [project(1), project(2, { status: "archived" }), project(3), project(4)];
    expect(planDowngradePause(limits({ projects: 2 }), ps, []).pauseProjects).toEqual([id(4), id(3)]);
    // An archived project in the excess is not tracking anything: it is counted, not paused.
    const newestArchived = [project(1), project(2), project(3, { status: "archived" })];
    expect(planDowngradePause(limits({ projects: 2 }), newestArchived, []).pauseProjects).toEqual([]);
  });

  it("BOUNDARY · usage exactly at the limit pauses nothing; one over pauses exactly one", () => {
    expect(planDowngradePause(limits({ projects: 3 }), [project(1), project(2), project(3)], []).pauseProjects).toEqual([]);
    expect(planDowngradePause(limits({ projects: 3 }), [project(1), project(2), project(3), project(4)], []).pauseProjects).toEqual([id(4)]);
  });

  it("a limit of zero (Free: projects.max = 0) pauses every project", () => {
    expect(planDowngradePause(limits({ projects: 0 }), [project(1), project(2)], []).pauseProjects).toEqual([id(2), id(1)]);
  });

  it("a project still onboarding (initializing) in the excess is paused too: it must not become active over the limit", () => {
    const ps = [project(1), project(2, { status: "initializing" })];
    expect(planDowngradePause(limits({ projects: 1 }), ps, []).pauseProjects).toEqual([id(2)]);
  });

  it("a project a PERSON paused is never marked: it is not taken over by the downgrade, and it still counts toward the excess", () => {
    // The newest is user-paused. The excess is the two newest (as the preview named them); only the active one is marked.
    const ps = [project(1), project(2), project(3), project(4, { status: "paused" })];
    const plan = planDowngradePause(limits({ projects: 2 }), ps, []);
    expect(plan.pauseProjects).toEqual([id(3)]);
  });

  it("per project: the newest prompts beyond prompts.max_per_project are paused, project by project", () => {
    const a = id(1);
    const b = id(2);
    const prompts = [prompt(1, a), prompt(2, a), prompt(3, a), prompt(4, b), prompt(5, b)];
    const plan = planDowngradePause(limits({ promptsPerProject: 2 }), [project(1), project(2)], prompts);
    expect(plan.pausePrompts).toEqual([id(1003)]);
  });

  it("workspace-wide: the newest prompts beyond prompts.max_total are paused, across projects", () => {
    const a = id(1);
    const b = id(2);
    const prompts = [prompt(1, a), prompt(2, b), prompt(3, a), prompt(4, b)];
    const plan = planDowngradePause(limits({ promptsTotal: 2 }), [project(1), project(2)], prompts);
    expect(plan.pausePrompts).toEqual([id(1004), id(1003)]);
  });

  it("a prompt a person paused occupies its slot and counts, but is never marked", () => {
    const a = id(1);
    const prompts = [prompt(1, a), prompt(2, a), prompt(3, a, { status: "paused" })];
    expect(planDowngradePause(limits({ promptsPerProject: 1 }), [project(1)], prompts).pausePrompts).toEqual([id(1002)]);
  });

  it("the per-project and workspace-wide excesses are one set: a prompt in both is paused once", () => {
    const a = id(1);
    const prompts = [prompt(1, a), prompt(2, a), prompt(3, a)];
    expect(planDowngradePause(limits({ promptsPerProject: 2, promptsTotal: 2 }), [project(1)], prompts).pausePrompts).toEqual([id(1003)]);
  });

  it("unlimited (null) pauses nothing", () => {
    const plan = planDowngradePause(limits(), [project(1), project(2)], [prompt(1, id(1))]);
    expect(plan).toEqual({ pauseProjects: [], resumeProjects: [], pausePrompts: [], resumePrompts: [] });
  });
});

describe("STORY-077 scenario 5 · an upgrade resumes what the downgrade paused", () => {
  it("a limit that covers everything resumes every downgrade-paused project and prompt", () => {
    const ps = [project(1), project(2, { status: "paused", pausedByDowngrade: true }), project(3, { status: "paused", pausedByDowngrade: true })];
    const prompts = [prompt(1, id(1)), prompt(2, id(1), { status: "paused", pausedByDowngrade: true })];
    const plan = planDowngradePause(limits({ projects: 5, promptsPerProject: 50, promptsTotal: 250 }), ps, prompts);
    expect(plan.resumeProjects).toEqual([id(2), id(3)]);
    expect(plan.resumePrompts).toEqual([id(1002)]);
    expect(plan.pauseProjects).toEqual([]);
    expect(plan.pausePrompts).toEqual([]);
  });

  it("a PARTIAL upgrade resumes the OLDEST downgrade-paused first, up to the new limit, and leaves the newest paused", () => {
    // Five projects, one active, four paused by a move to a 1-project plan. The new plan allows 3.
    const ps = [project(1), ...[2, 3, 4, 5].map((n) => project(n, { status: "paused", pausedByDowngrade: true }))];
    const plan = planDowngradePause(limits({ projects: 3 }), ps, []);
    expect(plan.resumeProjects).toEqual([id(2), id(3)]);
    expect(plan.pauseProjects).toEqual([]);
  });

  it("a project a PERSON paused is never resumed by an upgrade", () => {
    const ps = [project(1, { status: "paused" }), project(2, { status: "paused", pausedByDowngrade: true })];
    expect(planDowngradePause(limits({ projects: 5 }), ps, []).resumeProjects).toEqual([id(2)]);
  });

  it("a prompt a PERSON paused is never resumed by an upgrade", () => {
    const prompts = [prompt(1, id(1), { status: "paused" }), prompt(2, id(1), { status: "paused", pausedByDowngrade: true })];
    expect(planDowngradePause(limits({ promptsPerProject: 50 }), [project(1)], prompts).resumePrompts).toEqual([id(1002)]);
  });

  it("FIXED POINT · the plan applied to the state it produces asks for nothing more (a redelivered event is a no-op)", () => {
    const l = limits({ projects: 2, promptsPerProject: 1 });
    const ps = [project(1), project(2), project(3), project(4)];
    const prompts = [prompt(1, id(1)), prompt(2, id(1)), prompt(3, id(2))];
    const first = planDowngradePause(l, ps, prompts);
    const after = ps.map((p) => (first.pauseProjects.includes(p.id) ? { ...p, status: "paused" as const, pausedByDowngrade: true } : p));
    const afterPrompts = prompts.map((p) => (first.pausePrompts.includes(p.id) ? { ...p, status: "paused" as const, pausedByDowngrade: true } : p));
    expect(planDowngradePause(l, after, afterPrompts)).toEqual({ pauseProjects: [], resumeProjects: [], pausePrompts: [], resumePrompts: [] });
  });
});

describe("STORY-077 · the limits come from the resolved entitlements, never a retyped number", () => {
  it("reads projects.max, prompts.max_total and prompts.max_per_project from the plan through the guards' own reading ('uncapped'/'custom' unlimited, null 0)", () => {
    const growth = pauseLimitsFrom(PLAN_ENTITLEMENTS.growth);
    expect(growth).toEqual({
      projects: PLAN_ENTITLEMENTS.growth["projects.max"]!.value,
      promptsTotal: PLAN_ENTITLEMENTS.growth["prompts.max_total"]!.value,
      promptsPerProject: PLAN_ENTITLEMENTS.growth["prompts.max_per_project"]!.value,
    });
    expect(pauseLimitsFrom(PLAN_ENTITLEMENTS.enterprise)).toEqual({ projects: null, promptsTotal: null, promptsPerProject: null });
    // Free: no allowance at all. Its per-project `null` ("—") is a ceiling of 0, exactly as the guards and the preview
    // read it (structuralLimitFrom), never "unlimited".
    expect(pauseLimitsFrom(PLAN_ENTITLEMENTS.free)).toEqual({ projects: 0, promptsTotal: 0, promptsPerProject: 0 });
  });
});
