import { describe, expect, it } from "vitest";
import { downgradePausedEmail, downgradeResumedEmail } from "../../../src/lib/billing/downgrade-pause-notice.js";

// STORY-077 scenario 3 — "emails the list" (plans-and-entitlements.md §14). The hazards: an email for a cut-over that
// paused nothing; a list that leaves out what was paused; a count that disagrees with the list once it is bounded.

const project = (n: number) => ({ id: `p${String(n)}`, name: `Project ${String(n)}` });
const prompt = (n: number, withProject = false) => ({ id: `q${String(n)}`, projectId: withProject ? "p4" : "p0", projectName: withProject ? "Project 4" : "Project 0", text: `best tool number ${String(n)}`, withProject });
/** The plan moved (the opening names it), as at a cut-over. */
const plan = (planName: string | null) => ({ planName, planChanged: true });

describe("STORY-077 scenario 3 · the pause-list email", () => {
  it("nothing paused: no email at all", () => {
    expect(downgradePausedEmail("a@example.com", plan("Growth"), { projects: [], prompts: [] })).toBeNull();
    expect(downgradeResumedEmail("a@example.com", plan("Growth"), { projects: [], prompts: 0 })).toBeNull();
  });

  it("names every paused project and prompt, says nothing was deleted, and how they come back", () => {
    const mail = downgradePausedEmail("a@example.com", plan("Growth"), { projects: [project(4), project(3)], prompts: [prompt(1)] })!;
    expect(mail.to).toBe("a@example.com");
    expect(mail.textBody).toContain("Growth");
    expect(mail.textBody).toContain("2 projects paused");
    expect(mail.textBody).toContain("Project 4");
    expect(mail.textBody).toContain("Project 3");
    expect(mail.textBody).toContain("1 prompt paused");
    expect(mail.textBody).toContain("best tool number 1");
    expect(mail.textBody).toMatch(/Nothing has been deleted/);
    expect(mail.textBody).toMatch(/resume automatically if you upgrade/);
  });

  it("BOUNDARY · a long prompt list is bounded at 50 names, and the count stays exact", () => {
    const prompts = Array.from({ length: 51 }, (_, i) => prompt(i));
    const body = downgradePausedEmail("a@example.com", plan("Starter"), { projects: [], prompts })!.textBody;
    expect(body).toContain("51 prompts paused");
    expect(body).toContain("best tool number 49");
    expect(body).not.toContain("best tool number 50\n");
    expect(body).toContain("and 1 more");
  });

  it("an upgrade that resumed items names the projects and counts the prompts", () => {
    const body = downgradeResumedEmail("a@example.com", plan("Business"), { projects: [project(3)], prompts: 5 })!.textBody;
    expect(body).toContain("1 project resumed");
    expect(body).toContain("Project 3");
    expect(body).toContain("5 prompts resumed");
  });

  it("STORY-077 review round 2 · prompts paused WITH their project are not listed one by one: the project line covers them, and the prompt list names only prompts paused in a kept project", () => {
    const body = downgradePausedEmail("a@example.com", plan("Starter"), { projects: [project(4)], prompts: [prompt(1), prompt(2, true), prompt(3, true)] })!.textBody;
    expect(body).toContain("1 project paused");
    expect(body).toContain("Project 4 (and its 2 prompts)");
    expect(body).toContain("1 prompt paused");
    expect(body).toContain("best tool number 1");
    expect(body).not.toContain("best tool number 2");
    expect(body).not.toContain("best tool number 3");
  });

  it("review round 2 · no plan name (the plan join missed): the copy names no plan rather than 'the new plan plan'", () => {
    const paused = downgradePausedEmail("a@example.com", plan(null), { projects: [project(1)], prompts: [] })!.textBody;
    const resumed = downgradeResumedEmail("a@example.com", plan(null), { projects: [project(1)], prompts: 0 })!.textBody;
    for (const body of [paused, resumed]) {
      expect(body).not.toMatch(/plan plan|null|undefined/);
      expect(body).toContain("Your workspace changed plan");
    }
  });

  it("review round 3 · two paused projects with the SAME name each get their own prompt count (counted by id, not by name)", () => {
    const twins = [{ id: "pa", name: "Docs" }, { id: "pb", name: "Docs" }];
    const q = (n: number, projectId: string) => ({ id: `q${String(n)}`, projectId, projectName: "Docs", text: `t${String(n)}`, withProject: true });
    const body = downgradePausedEmail("a@example.com", plan("Starter"), { projects: twins, prompts: [q(1, "pa"), q(2, "pa"), q(3, "pb")] })!.textBody;
    expect(body).toContain("  - Docs (and its 2 prompts)");
    expect(body).toContain("  - Docs (and its 1 prompt)");
    expect(body).not.toContain("(and its 3 prompts)");
  });

  it("review round 3 · a pause after an ADD-ON change (the plan did not move) does not claim the workspace moved plan", () => {
    const change = { planName: "Growth", planChanged: false };
    const paused = downgradePausedEmail("a@example.com", change, { projects: [project(1)], prompts: [] })!.textBody;
    const resumed = downgradeResumedEmail("a@example.com", change, { projects: [project(1)], prompts: 0 })!.textBody;
    for (const body of [paused, resumed]) {
      expect(body).not.toMatch(/moved to the|changed plan/);
      expect(body).toMatch(/add-ons/);
    }
  });
});
