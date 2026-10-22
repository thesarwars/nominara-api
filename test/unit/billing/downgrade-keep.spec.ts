import { describe, expect, it } from "vitest";
import { planDowngradePause, type DowngradePausePlan, type PauseLimits, type PauseProject, type PausePrompt } from "../../../src/lib/billing/downgrade-pause.js";
import { keptAfter, validateKeepChoice } from "../../../src/lib/billing/downgrade-keep.js";
import { downgradePausedEmail } from "../../../src/lib/billing/downgrade-pause-notice.js";

// STORY-077 D2 — the keep choice (scenario 2) and the default order when no choice is made (owner decision 2026-10-20:
// keep the MOST RECENTLY ACTIVE, replacing slice A's "pause the most recently created").
//
// "Last active" (contracts/billing/downgrade-keep.schema.ts): a project's latest finished capture run, a prompt's latest
// answer capture; none ranks below any; equal activity falls back to slice A (the older row is kept).
//
// Hazards these cases are written from:
//   * the default still pauses by creation (a project captured yesterday paused because it was created last);
//   * a project that never captured is treated as more active than one that did;
//   * the choice is ignored for a project or prompt the default would have paused, or a chosen paused item stays paused;
//   * a choice smaller than the allowance is undone by the next reconcile (not a fixed point);
//   * the limits fall after the choice (an add-on removed) and the cut-over keeps more than the plan allows;
//   * a choice over the target's limits, or naming a prompt outside the kept projects, or a person's pause, is accepted.

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const key = (hours: number) => new Date(T0 + hours * 3_600_000).toISOString().replace("Z", "000Z");
const id = (n: number) => `0194a3d2-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** Created `n` hours after T0; never active unless `activityKey` is given. */
const project = (n: number, over: Partial<PauseProject> = {}): PauseProject => ({ id: id(n), createdKey: key(n), status: "active", pausedByDowngrade: false, activityKey: null, ...over });
const prompt = (n: number, projectId: string, over: Partial<PausePrompt> = {}): PausePrompt => ({
  id: id(1000 + n),
  projectId,
  createdKey: key(n),
  status: "active",
  pausedByDowngrade: false,
  activityKey: null,
  ...over,
});
const limits = (over: Partial<PauseLimits> = {}): PauseLimits => ({ projects: null, promptsTotal: null, promptsPerProject: null, ...over });
const keep = (projects: readonly string[], prompts: readonly string[] = []) => ({ projectIds: new Set(projects), promptIds: new Set(prompts) });
const NOTHING = { pauseProjects: [], resumeProjects: [], pausePrompts: [], resumePrompts: [] };

function applied(plan: DowngradePausePlan, projects: readonly PauseProject[], prompts: readonly PausePrompt[]) {
  return {
    projects: projects.map((p): PauseProject =>
      plan.pauseProjects.includes(p.id) ? { ...p, status: "paused", pausedByDowngrade: true } : plan.resumeProjects.includes(p.id) ? { ...p, status: "active", pausedByDowngrade: false } : p,
    ),
    prompts: prompts.map((p): PausePrompt =>
      plan.pausePrompts.includes(p.id) ? { ...p, status: "paused", pausedByDowngrade: true } : plan.resumePrompts.includes(p.id) ? { ...p, status: "active", pausedByDowngrade: false } : p,
    ),
  };
}
const strip = (plan: DowngradePausePlan) => ({ pauseProjects: plan.pauseProjects, resumeProjects: plan.resumeProjects, pausePrompts: plan.pausePrompts, resumePrompts: plan.resumePrompts });

describe("STORY-077 scenario 3 (owner 2026-10-20) · with no choice the cut-over keeps the MOST RECENTLY ACTIVE", () => {
  it("a project captured recently is kept although it was created last; the least recently active is paused", () => {
    // P1 oldest, captured at hour 100; P2 never captured; P3 newest, captured at hour 50. Limit 2: keep P1 and P3.
    const ps = [project(1, { activityKey: key(100) }), project(2), project(3, { activityKey: key(50) })];
    expect(planDowngradePause(limits({ projects: 2 }), ps, []).pauseProjects).toEqual([id(2)]);
  });

  it("any activity outranks none, and among the never-active the slice-A rule holds (the most recently created is paused first)", () => {
    const ps = [project(1), project(2), project(3, { activityKey: key(3) }), project(4)];
    // Keep order: P3 (active), then P1, P2, P4 by creation. Limit 2 keeps P3 and P1; P4 then P2 are paused.
    expect(planDowngradePause(limits({ projects: 2 }), ps, []).pauseProjects).toEqual([id(4), id(2)]);
  });

  it("the more recent of two activities wins, whatever the creation order", () => {
    const ps = [project(1, { activityKey: key(10) }), project(2, { activityKey: key(20) })];
    expect(planDowngradePause(limits({ projects: 1 }), ps, []).pauseProjects).toEqual([id(1)]);
  });

  it("per project: the prompts captured most recently are kept, the never-captured newest are paused first", () => {
    const a = id(1);
    // p1..p3 never captured, p4 and p5 captured. Cap 3: keep p5, p4 (activity) and p1 (the oldest of the rest).
    const ps = [prompt(1, a), prompt(2, a), prompt(3, a), prompt(4, a, { activityKey: key(40) }), prompt(5, a, { activityKey: key(41) })];
    expect(planDowngradePause(limits({ promptsPerProject: 3 }), [project(1)], ps).pausePrompts).toEqual([id(1003), id(1002)]);
  });

  it("workspace-wide: the least recently active prompts across projects are paused", () => {
    const [a, b] = [id(1), id(2)];
    const ps = [prompt(1, a, { activityKey: key(90) }), prompt(2, b), prompt(3, a), prompt(4, b, { activityKey: key(80) })];
    expect(planDowngradePause(limits({ promptsTotal: 2 }), [project(1), project(2)], ps).pausePrompts).toEqual([id(1003), id(1002)]);
  });

  it("a PARTIAL upgrade resumes the most recently active of the downgrade-paused first (the inverse of the pause)", () => {
    const ps = [
      project(1, { activityKey: key(500) }),
      project(2, { status: "paused", pausedByDowngrade: true, activityKey: key(10) }),
      project(3, { status: "paused", pausedByDowngrade: true, activityKey: key(30) }),
      project(4, { status: "paused", pausedByDowngrade: true }),
    ];
    expect(planDowngradePause(limits({ projects: 2 }), ps, []).resumeProjects).toEqual([id(3)]);
    const prompts = [
      prompt(1, id(1)),
      prompt(2, id(1), { status: "paused", pausedByDowngrade: true, activityKey: key(5) }),
      prompt(3, id(1), { status: "paused", pausedByDowngrade: true, activityKey: key(9) }),
    ];
    expect(planDowngradePause(limits({ promptsPerProject: 2 }), [project(1)], prompts).resumePrompts).toEqual([id(1003)]);
  });

  it("FIXED POINT · applied to the state it produces, the activity-ordered plan asks for nothing more", () => {
    const l = limits({ projects: 2, promptsPerProject: 2, promptsTotal: 3 });
    const ps = [project(1), project(2, { activityKey: key(70) }), project(3), project(4, { activityKey: key(60) })];
    const prompts = [prompt(1, id(2)), prompt(2, id(2), { activityKey: key(71) }), prompt(3, id(2)), prompt(4, id(4)), prompt(5, id(4), { activityKey: key(65) }), prompt(6, id(1))];
    const first = planDowngradePause(l, ps, prompts);
    expect(first.pauseProjects).toEqual([id(3), id(1)]);
    const after = applied(first, ps, prompts);
    expect(strip(planDowngradePause(l, after.projects, after.prompts))).toEqual(NOTHING);
  });
});

describe("STORY-077 scenario 2 · the customer's choice is honoured at the cut-over", () => {
  it("the chosen projects are kept and every other is paused, even the most recently active", () => {
    const ps = [project(1, { activityKey: key(100) }), project(2, { activityKey: key(90) }), project(3)];
    expect(planDowngradePause(limits({ projects: 1 }), ps, [], keep([id(3)])).pauseProjects).toEqual([id(2), id(1)]);
  });

  it("a chosen project an earlier downgrade paused is resumed; one not chosen stays paused once the choice fills the limit", () => {
    const ps = [project(1), project(2, { status: "paused", pausedByDowngrade: true }), project(3, { status: "paused", pausedByDowngrade: true })];
    const plan = planDowngradePause(limits({ projects: 2 }), ps, [], keep([id(3), id(1)]));
    expect(plan.resumeProjects).toEqual([id(3)]);
    expect(plan.pauseProjects).toEqual([]);
  });

  it("prompts: in a kept project the chosen prompts are kept and the others paused; a chosen downgrade-paused prompt resumes", () => {
    const a = id(1);
    const ps = [prompt(1, a, { activityKey: key(99) }), prompt(2, a), prompt(3, a, { status: "paused", pausedByDowngrade: true })];
    const plan = planDowngradePause(limits({ promptsPerProject: 2 }), [project(1)], ps, keep([a], [id(1002), id(1003)]));
    expect(plan.pausePrompts).toEqual([id(1001)]);
    expect(plan.resumePrompts).toEqual([id(1003)]);
  });

  it("a project not chosen is paused WITH its prompts, whatever prompts were chosen elsewhere", () => {
    const ps = [prompt(1, id(1)), prompt(2, id(2))];
    // The newer P2 is chosen: the older, unchosen P1 is paused with its prompt.
    const plan = planDowngradePause(limits({ projects: 1 }), [project(1), project(2)], ps, keep([id(2)], [id(1002)]));
    expect(plan.pauseProjects).toEqual([id(1)]);
    expect(plan.pausePrompts).toEqual([id(1001)]);
  });

  it("room left after a SMALLER choice is filled with the most recently active of the rest, so the next reconcile changes nothing", () => {
    const ps = [project(1), project(2, { activityKey: key(50) }), project(3), project(4)];
    const l = limits({ projects: 3 });
    const plan = planDowngradePause(l, ps, [], keep([id(4)]));
    // Kept: P4 (chosen), then P2 (active), then P1 (oldest). Paused: P3.
    expect(plan.pauseProjects).toEqual([id(3)]);
    const after = applied(plan, ps, []);
    expect(strip(planDowngradePause(l, after.projects, after.prompts))).toEqual(NOTHING);
  });

  it("limits that fell after the choice (an add-on removed) keep the most recently active of the CHOSEN, never more than the plan allows", () => {
    const ps = [project(1, { activityKey: key(10) }), project(2, { activityKey: key(20) }), project(3)];
    const plan = planDowngradePause(limits({ projects: 1 }), ps, [], keep([id(1), id(2)]));
    expect(plan.pauseProjects).toEqual([id(3), id(1)]);
  });

  it("the workspace-wide limit takes the unchosen first", () => {
    const [a, b] = [id(1), id(2)];
    const ps = [prompt(1, a, { activityKey: key(90) }), prompt(2, b), prompt(3, a), prompt(4, b, { activityKey: key(80) })];
    const plan = planDowngradePause(limits({ promptsTotal: 2 }), [project(1), project(2)], ps, keep([a, b], [id(1002), id(1003)]));
    expect(plan.pausePrompts).toEqual([id(1004), id(1001)]);
  });
});

describe("STORY-077 D2 · what the cut-over would keep (the GET's default)", () => {
  it("keptAfter names the projects and prompts still tracking after the plan, most recently active first", () => {
    const ps = [project(1), project(2, { activityKey: key(50) }), project(3), project(4, { status: "paused" })];
    const prompts = [prompt(1, id(1)), prompt(2, id(2)), prompt(3, id(3)), prompt(4, id(2), { status: "paused", pausedByDowngrade: true }), prompt(5, id(4))];
    const plan = planDowngradePause(limits({ projects: 3 }), ps, prompts);
    // Count 4 against 3 (the person-paused P4 counts): the excess is the least kept-worthy, P4, then nothing else is paused.
    expect(keptAfter(plan, ps, prompts)).toEqual({ projectIds: [id(2), id(1), id(3)], promptIds: [id(1002), id(1004), id(1001), id(1003)] });
  });
});

describe("STORY-077 D2 · the choice is validated against the target plan's limits", () => {
  const keepable = new Map<string, ReadonlySet<string>>([
    [id(1), new Set([id(1001), id(1002), id(1003)])],
    [id(2), new Set([id(1004)])],
    [id(3), new Set<string>()],
  ]);
  const l = limits({ projects: 2, promptsPerProject: 2, promptsTotal: 3 });

  it("a choice within every limit has no issue", () => {
    expect(validateKeepChoice({ project_ids: [id(1), id(2)], prompt_ids: [id(1001), id(1002), id(1004)] }, keepable, l)).toEqual([]);
  });

  it("more projects than the target allows is refused on project_ids", () => {
    const issues = validateKeepChoice({ project_ids: [id(1), id(2), id(3)], prompt_ids: [] }, keepable, l);
    expect(issues).toEqual([{ path: ["project_ids"], message: "the target plan keeps at most 2 projects" }]);
  });

  it("more prompts in one project, or in all, than the target allows is refused on prompt_ids", () => {
    expect(validateKeepChoice({ project_ids: [id(1)], prompt_ids: [id(1001), id(1002), id(1003)] }, keepable, l)).toEqual([
      { path: ["prompt_ids"], message: "the target plan keeps at most 2 prompts in one project" },
    ]);
    const wide = new Map<string, ReadonlySet<string>>([
      [id(1), new Set([id(1001), id(1002)])],
      [id(2), new Set([id(1004), id(1005)])],
    ]);
    expect(validateKeepChoice({ project_ids: [id(1), id(2)], prompt_ids: [id(1001), id(1002), id(1004), id(1005)] }, wide, l)).toEqual([
      { path: ["prompt_ids"], message: "the target plan keeps at most 3 prompts in all" },
    ]);
  });

  it("an id that cannot be kept (unknown, deleted, archived, a person's pause) is refused at its index", () => {
    expect(validateKeepChoice({ project_ids: [id(1), id(9)], prompt_ids: [id(1009)] }, keepable, l)).toEqual([
      { path: ["project_ids", 1], message: "not a project that can be kept" },
      { path: ["prompt_ids", 0], message: "not a prompt that can be kept" },
    ]);
  });

  it("a prompt whose project is not kept is refused: it would be paused with its project", () => {
    expect(validateKeepChoice({ project_ids: [id(2)], prompt_ids: [id(1001)] }, keepable, l)).toEqual([
      { path: ["prompt_ids", 0], message: "its project is not in project_ids" },
    ]);
  });

  it("unlimited (null) limits bound nothing", () => {
    expect(validateKeepChoice({ project_ids: [id(1), id(2), id(3)], prompt_ids: [id(1001), id(1002), id(1003), id(1004)] }, keepable, limits())).toEqual([]);
  });
});

describe("STORY-077 scenario 3 · the pause email says WHICH rule chose what was paused", () => {
  const paused = { projects: [{ id: "p1", name: "Project 1" }], prompts: [] };
  it("with no choice: the least recently active items were paused, never 'the most recently created'", () => {
    const body = downgradePausedEmail("a@example.com", { planName: "Growth", planChanged: true, addonsChanged: false, byChoice: false }, paused)!.textBody;
    expect(body).toMatch(/least recently active/);
    expect(body).not.toMatch(/most recently created/);
  });
  it("with a recorded choice: what was not chosen to keep was paused", () => {
    const body = downgradePausedEmail("a@example.com", { planName: "Growth", planChanged: true, addonsChanged: false, byChoice: true }, paused)!.textBody;
    expect(body).toMatch(/you did not choose to keep/);
    expect(body).not.toMatch(/most recently created/);
  });
});
