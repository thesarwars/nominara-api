import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../../src/db/seed/plan-entitlements.js";
import { pauseLimitsFrom, planDowngradePause, type DowngradePausePlan, type PauseLimits, type PauseProject, type PausePrompt } from "../../../src/lib/billing/downgrade-pause.js";

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
const project = (n: number, over: Partial<PauseProject> = {}): PauseProject => ({ id: id(n), createdKey: key(n), status: "active", pausedByDowngrade: false, ...over });
const prompt = (n: number, projectId: string, over: Partial<PausePrompt> = {}): PausePrompt => ({ id: id(1000 + n), projectId, createdKey: key(n), status: "active", pausedByDowngrade: false, ...over });
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
    const tied = [project(1, { createdKey: key(0) }), project(2, { createdKey: key(0) }), project(3, { createdKey: key(0) })];
    expect(planDowngradePause(limits({ projects: 1 }), tied, []).pauseProjects).toEqual([id(3), id(2)]);
  });

  it("MICROSECONDS decide, as in the preview's SQL (ORDER BY created_at DESC, id DESC): two rows in the same millisecond are not ordered by id", () => {
    // Same millisecond, different microseconds: id(1) is the NEWER row though its id is smaller. A millisecond Date would
    // tie and fall back to id, pausing id(2) - not the project the preview named.
    const ps = [
      project(1, { createdKey: key(0, 900) }),
      project(2, { createdKey: key(0, 100) }),
    ];
    expect(planDowngradePause(limits({ projects: 1 }), ps, []).pauseProjects).toEqual([id(1)]);
    const prompts = [
      prompt(1, id(1), { createdKey: key(0, 900) }),
      prompt(2, id(1), { createdKey: key(0, 100) }),
    ];
    expect(planDowngradePause(limits({ promptsPerProject: 1 }), [project(1)], prompts).pausePrompts).toEqual([id(1001)]);
  });

  it("an ARCHIVED project counts toward the excess exactly as the guard and the preview count it (every non-deleted project), and is never itself paused", () => {
    // The guard (structural-usage COUNTERS["projects.max"]) and the preview count 4 projects against 2, and the preview
    // names the two newest: P4 and P3. Leaving the archived P2 out would count 3 and pause only P4.
    const ps = [project(1), project(2, { status: "archived" }), project(3), project(4)];
    expect(planDowngradePause(limits({ projects: 2 }), ps, []).pauseProjects).toEqual([id(4), id(3)]);
    // An archived project is counted, never paused, and HOLDS its slot (STORY-077 D2 review round 1): it ranks first
    // whatever its age or activity, so a newest archived project no longer soaks up the excess for an active one. Slice A
    // let it (nothing paused here); with a keep choice that made the cut-over and the next reconcile disagree.
    const newestArchived = [project(1), project(2), project(3, { status: "archived" })];
    expect(planDowngradePause(limits({ projects: 2 }), newestArchived, []).pauseProjects).toEqual([id(2)]);
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
    // The newest is user-paused. It counts and HOLDS its slot (STORY-077 D2 review round 1: a project that is not tracking
    // ranks first, so it never soaks up the excess for an active one), so the two newest ACTIVE are paused and marked; it
    // is not. Slice A let it take the excess (pausing only P3); with a keep choice that made a later reconcile disagree.
    const ps = [project(1), project(2), project(3), project(4, { status: "paused" })];
    const plan = planDowngradePause(limits({ projects: 2 }), ps, []);
    expect(plan.pauseProjects).toEqual([id(3), id(2)]);
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

  it("a prompt a person paused is never marked and never holds tracked room: the project still tracks all its limit allows", () => {
    const a = id(1);
    // The person's pause is the OLDEST row: counting it would push the excess onto a tracked prompt.
    const prompts = [prompt(1, a, { status: "paused" }), prompt(2, a), prompt(3, a)];
    const plan = planDowngradePause(limits({ promptsPerProject: 2, promptsTotal: 2 }), [project(1)], prompts);
    expect(plan.pausePrompts, "2 active against 2 allowed: nothing to pause").toEqual([]);
    expect(plan.resumePrompts, "a person's pause is never resumed by billing").toEqual([]);
    expect(planDowngradePause(limits({ promptsPerProject: 1 }), [project(1)], prompts).pausePrompts, "one over: only the newest active").toEqual([id(1003)]);
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

// ---- review round 2 ------------------------------------------------------------------------------------------------
//
// Written from the hazards, not from the selection code:
//   * OVER-PAUSING — the customer is left tracking FEWER prompts than the plan allows, because the per-project and the
//     workspace-wide excesses were each worked out against the full list and then unioned (pausing the per-project
//     excess already lowers the workspace total);
//   * a project the cut-over paused keeps its prompts at status 'active': nothing tracks them, but they hold the
//     workspace's ACTIVE room, so prompts in the projects the customer KEPT are paused in their place;
//   * a later reconcile that lowers no limit RE-PAUSES a prompt a person chose to resume (lifecycle.service.ts: a
//     person's status change makes a prompt theirs).

/** The state `plan` produces from (projects, prompts): what reconcileDowngradePause's UPDATEs do. */
function applied(plan: DowngradePausePlan, projects: readonly PauseProject[], prompts: readonly PausePrompt[]) {
  const after = projects.map((p): PauseProject => {
    if (plan.pauseProjects.includes(p.id)) return { ...p, status: "paused", pausedByDowngrade: true, from: p.status } as PauseProject;
    if (plan.resumeProjects.includes(p.id)) return { ...p, status: (p as { from?: PauseProject["status"] }).from ?? "active", pausedByDowngrade: false };
    return p;
  });
  const afterPrompts = prompts.map((p): PausePrompt => {
    if (plan.pausePrompts.includes(p.id)) return { ...p, status: "paused", pausedByDowngrade: true };
    if (plan.resumePrompts.includes(p.id)) return { ...p, status: "active", pausedByDowngrade: false };
    return p;
  });
  return { projects: after, prompts: afterPrompts };
}

const activeIn = (prompts: readonly PausePrompt[], projectId?: string) => prompts.filter((p) => p.status === "active" && (projectId === undefined || p.projectId === projectId)).length;
const NOTHING = { pauseProjects: [], resumeProjects: [], pausePrompts: [], resumePrompts: [] };

describe("STORY-077 review round 2 · the cut-over pauses the excess, never excess plus overlap", () => {
  it("per-project AND workspace-wide excess together: pausing the per-project excess counts toward the workspace excess (probe: total 15, per project 10, A 20 old, B 5 newer -> 15 tracked)", () => {
    const a = id(1);
    const b = id(2);
    const ps = [...Array.from({ length: 20 }, (_, i) => prompt(i, a)), ...Array.from({ length: 5 }, (_, i) => prompt(100 + i, b))];
    const plan = planDowngradePause(limits({ promptsTotal: 15, promptsPerProject: 10 }), [project(1), project(2)], ps);
    const after = applied(plan, [project(1), project(2)], ps).prompts;
    expect(activeIn(after, a)).toBe(10);
    expect(activeIn(after, b)).toBe(5);
    expect(activeIn(after), "the plan allows 15 and 25 occupy: 15 tracked").toBe(15);
    // The ten paused are A's ten newest.
    expect(plan.pausePrompts).toEqual(ps.slice(10, 20).map((p) => p.id).reverse());
  });

  it("the seed values: Business -> Growth with A=50, B=40, C=40 and B holding the ten newest leaves 120 tracked of the 120 allowed, not 110", () => {
    const [a, b, c] = [id(1), id(2), id(3)];
    const ps = [
      ...Array.from({ length: 50 }, (_, i) => prompt(i, a)),
      ...Array.from({ length: 40 }, (_, i) => prompt(200 + i, c)),
      ...Array.from({ length: 40 }, (_, i) => prompt(400 + i, b)),
    ];
    const growth = pauseLimitsFrom(PLAN_ENTITLEMENTS.growth);
    const projects = [project(1), project(2), project(3)];
    const after = applied(planDowngradePause(growth, projects, ps), projects, ps).prompts;
    expect([activeIn(after, a), activeIn(after, b), activeIn(after, c)]).toEqual([40, 40, 40]);
    expect(activeIn(after)).toBe(120);
  });

  it("a PARTIAL upgrade resumes up to the new limits under the same arithmetic, never fewer", () => {
    const a = id(1);
    const b = id(2);
    // After a cut-over to (15, 10): A tracks 10 and has 10 marked; B tracks 5. The new plan allows 22 and 12 per project.
    const ps = [
      ...Array.from({ length: 10 }, (_, i) => prompt(i, a)),
      ...Array.from({ length: 10 }, (_, i) => prompt(10 + i, a, { status: "paused", pausedByDowngrade: true })),
      ...Array.from({ length: 5 }, (_, i) => prompt(100 + i, b)),
    ];
    const plan = planDowngradePause(limits({ promptsTotal: 22, promptsPerProject: 12 }), [project(1), project(2)], ps);
    expect(plan.resumePrompts, "the two oldest marked: A reaches its 12").toEqual([id(1010), id(1011)]);
    expect(activeIn(applied(plan, [project(1), project(2)], ps).prompts)).toBe(17);
  });
});

describe("STORY-077 review round 2 · a project the cut-over pauses takes its prompts with it", () => {
  it("probe 2 (Growth -> Starter): A has 20 old prompts and 10 recent, B was created in between with 20. B is paused WITH its prompts, and A tracks all 30 Starter allows", () => {
    const a = project(1);
    const b = project(2);
    const ps = [
      ...Array.from({ length: 20 }, (_, i) => prompt(i, a.id, { createdKey: key(10 + i) })),
      ...Array.from({ length: 20 }, (_, i) => prompt(100 + i, b.id, { createdKey: key(50 + i) })),
      ...Array.from({ length: 10 }, (_, i) => prompt(200 + i, a.id, { createdKey: key(100 + i) })),
    ];
    const starter = pauseLimitsFrom(PLAN_ENTITLEMENTS.starter);
    const plan = planDowngradePause(starter, [a, b], ps);
    expect(plan.pauseProjects).toEqual([b.id]);
    const after = applied(plan, [a, b], ps).prompts;
    expect(activeIn(after, a.id), "the kept project tracks up to its cap").toBe(30);
    expect(activeIn(after, b.id), "nothing in a paused project holds the active room").toBe(0);
    expect(after.filter((p) => p.projectId === b.id).every((p) => p.status === "paused" && p.pausedByDowngrade)).toBe(true);
  });

  it("and an upgrade that resumes the project resumes its prompts with it", () => {
    const a = project(1);
    const b = project(2, { status: "paused", pausedByDowngrade: true });
    const ps = [prompt(1, a.id), prompt(2, b.id, { status: "paused", pausedByDowngrade: true }), prompt(3, b.id, { status: "paused", pausedByDowngrade: true })];
    const plan = planDowngradePause(limits({ projects: 3, promptsTotal: 120, promptsPerProject: 40 }), [a, b], ps);
    expect(plan.resumeProjects).toEqual([b.id]);
    expect(plan.resumePrompts).toEqual([id(1002), id(1003)]);
  });

  it("a project still paused by the downgrade keeps its marked prompts paused even when the prompt limits have room", () => {
    const a = project(1);
    const b = project(2, { status: "paused", pausedByDowngrade: true });
    const ps = [prompt(1, a.id), prompt(2, b.id, { status: "paused", pausedByDowngrade: true })];
    expect(planDowngradePause(limits({ projects: 1, promptsTotal: 120, promptsPerProject: 40 }), [a, b], ps)).toEqual(NOTHING);
  });

  it("the workspace excess is taken first from prompts in a project nothing tracks (person-paused, archived), before a kept, tracking project", () => {
    const a = project(1);
    const b = project(2, { status: "paused" }); // a person paused it: not the downgrade's, not tracked
    const ps = [prompt(1, b.id), prompt(2, b.id), prompt(3, a.id), prompt(4, a.id)];
    const plan = planDowngradePause(limits({ promptsTotal: 2 }), [a, b], ps);
    expect(plan.pauseProjects).toEqual([]);
    expect(plan.pausePrompts).toEqual([id(1002), id(1001)]);
  });
});

describe("STORY-077 review round 2 · a reconcile that lowers no limit never re-pauses a person's resume", () => {
  it("the probe: per-project cap 5, p0 paused by a person, p1-p6 active -> only p6 is paused (5 tracked, not 4)", () => {
    const a = id(1);
    const ps = [prompt(0, a, { status: "paused" }), ...[1, 2, 3, 4, 5, 6].map((n) => prompt(n, a))];
    const plan = planDowngradePause(limits({ promptsPerProject: 5 }), [project(1)], ps);
    expect(plan.pausePrompts).toEqual([id(1006)]);
  });

  it("after a person swapped a tracked prompt for a marked one, a later reconcile under the same limits changes nothing", () => {
    const a = id(1);
    // Cap 5. The cut-over paused p6 and p7. A person paused p1 and resumed p7 (its marker cleared).
    const ps = [
      prompt(1, a, { status: "paused" }),
      ...[2, 3, 4, 5].map((n) => prompt(n, a)),
      prompt(6, a, { status: "paused", pausedByDowngrade: true }),
      prompt(7, a),
    ];
    expect(planDowngradePause(limits({ promptsPerProject: 5 }), [project(1)], ps)).toEqual(NOTHING);
  });
});

describe("STORY-077 review round 2 · invariants over random workspaces (seeded, reproducible)", () => {
  /** A small deterministic PRNG (mulberry32): no dependency, the same cases on every run. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it("after any plan: per-project and workspace ACTIVE within the caps, nothing active in a downgrade-paused project, no marked prompt left that fits, person pauses untouched, and a fixed point", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
      const nProjects = 1 + Math.floor(r() * 5);
      const projects: PauseProject[] = Array.from({ length: nProjects }, (_, i) => {
        const status = pick(["active", "active", "active", "initializing", "paused", "archived"] as const);
        const marked = status === "paused" && r() < 0.5;
        return project(i + 1, { createdKey: key(Math.floor(r() * 50), Math.floor(r() * 999)), status, pausedByDowngrade: marked, ...(marked ? { from: "active" } : {}) } as Partial<PauseProject>);
      });
      const prompts: PausePrompt[] = [];
      for (let i = 0; i < Math.floor(r() * 40); i++) {
        const roll = r();
        const over: Partial<PausePrompt> = roll < 0.65 ? {} : roll < 0.85 ? { status: "paused", pausedByDowngrade: true } : { status: "paused" };
        prompts.push(prompt(i, pick(projects).id, { createdKey: key(Math.floor(r() * 50), Math.floor(r() * 999)), ...over }));
      }
      const capOrNull = (max: number) => (r() < 0.2 ? null : Math.floor(r() * max));
      const l = limits({ projects: capOrNull(5), promptsTotal: capOrNull(30), promptsPerProject: capOrNull(12) });

      const plan = planDowngradePause(l, projects, prompts);
      const after = applied(plan, projects, prompts);
      const ctx = `seed ${String(seed)} limits ${JSON.stringify(l)}`;
      const markedProjects = new Set(after.projects.filter((p) => p.pausedByDowngrade).map((p) => p.id));
      const wsActive = activeIn(after.prompts);

      if (l.promptsTotal !== null) expect(wsActive, ctx).toBeLessThanOrEqual(l.promptsTotal);
      for (const p of after.projects) {
        if (l.promptsPerProject !== null) expect(activeIn(after.prompts, p.id), ctx).toBeLessThanOrEqual(l.promptsPerProject);
        if (markedProjects.has(p.id)) expect(activeIn(after.prompts, p.id), `${ctx}: active prompt in a downgrade-paused project`).toBe(0);
      }
      for (const p of after.prompts.filter((x) => x.pausedByDowngrade && !markedProjects.has(x.projectId))) {
        const projectFull = l.promptsPerProject !== null && activeIn(after.prompts, p.projectId) >= l.promptsPerProject;
        const workspaceFull = l.promptsTotal !== null && wsActive >= l.promptsTotal;
        expect(projectFull || workspaceFull, `${ctx}: ${p.id} is paused although it fits`).toBe(true);
      }
      for (const before of prompts.filter((x) => x.status === "paused" && !x.pausedByDowngrade)) {
        expect(after.prompts.find((x) => x.id === before.id), `${ctx}: a person's pause was touched`).toEqual(before);
      }
      expect(planDowngradePause(l, after.projects, after.prompts), `${ctx}: not a fixed point`).toEqual(NOTHING);
    }
  });
});
