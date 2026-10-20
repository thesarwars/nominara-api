import { describe, expect, it } from "vitest";
import { downgradePausedEmail, downgradeResumedEmail } from "../../../src/lib/billing/downgrade-pause-notice.js";

// STORY-077 scenario 3 — "emails the list" (plans-and-entitlements.md §14). The hazards: an email for a cut-over that
// paused nothing; a list that leaves out what was paused; a count that disagrees with the list once it is bounded.

const project = (n: number) => ({ id: `p${String(n)}`, name: `Project ${String(n)}` });
const prompt = (n: number) => ({ id: `q${String(n)}`, projectName: "Project 0", text: `best tool number ${String(n)}` });

describe("STORY-077 scenario 3 · the pause-list email", () => {
  it("nothing paused: no email at all", () => {
    expect(downgradePausedEmail("a@example.com", "Growth", { projects: [], prompts: [] })).toBeNull();
    expect(downgradeResumedEmail("a@example.com", "Growth", { projects: [], prompts: 0 })).toBeNull();
  });

  it("names every paused project and prompt, says nothing was deleted, and how they come back", () => {
    const mail = downgradePausedEmail("a@example.com", "Growth", { projects: [project(4), project(3)], prompts: [prompt(1)] })!;
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
    const body = downgradePausedEmail("a@example.com", "Starter", { projects: [], prompts })!.textBody;
    expect(body).toContain("51 prompts paused");
    expect(body).toContain("best tool number 49");
    expect(body).not.toContain("best tool number 50\n");
    expect(body).toContain("and 1 more");
  });

  it("an upgrade that resumed items names the projects and counts the prompts", () => {
    const body = downgradeResumedEmail("a@example.com", "Business", { projects: [project(3)], prompts: 5 })!.textBody;
    expect(body).toContain("1 project resumed");
    expect(body).toContain("Project 3");
    expect(body).toContain("5 prompts resumed");
  });
});
