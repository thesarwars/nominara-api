import { describe, expect, it } from "vitest";
import { defaultCadenceFor, effectiveCadence, seesProject, visibleProjects } from "../../../src/lib/notifications/audience.js";
import { renderDigestEmail } from "../../../src/lib/notifications/render.js";

// STORY-068 — the pure halves of the digest: who gets one at what cadence (owner decision 2026-10-23) and what it says.

describe("STORY-068 · digest audience and rendering", () => {
  it("[owner 2026-10-23] the digest is weekly by default for owners, admins and managers, off for analysts and viewers; a member's own choice wins", () => {
    for (const role of ["owner", "admin", "manager"]) expect(defaultCadenceFor(role), role).toBe("weekly");
    for (const role of ["analyst", "viewer"]) expect(defaultCadenceFor(role), role).toBe("off");
    expect(effectiveCadence("owner", "daily")).toBe("daily");
    expect(effectiveCadence("owner", "off")).toBe("off");
    expect(effectiveCadence("viewer", "weekly")).toBe("weekly");
    expect(effectiveCadence("manager", null)).toBe("weekly");
  });

  it("[hazard] a scoped role sees only its projects' notifications; an empty scope sees none; workspace-level rows reach everyone", () => {
    expect(visibleProjects("owner", ["p1"])).toBeNull();
    expect(visibleProjects("manager", ["p1"])).toEqual(["p1"]);
    expect(visibleProjects("manager", null)).toBeNull();
    expect(seesProject(["p1"], "p2")).toBe(false);
    expect(seesProject([], "p1")).toBe(false);
    expect(seesProject([], null)).toBe(true);
    expect(seesProject(null, "p9")).toBe(true);
  });

  it("[STORY-068 #9 / AC9] a digest coalesces every item into ONE email, the most severe first", () => {
    const email = renderDigestEmail({
      cadence: "weekly",
      periodLabel: "12 Oct to 18 Oct 2026",
      appOrigin: "https://app.example",
      items: [
        { title: "Info thing", body: null, severity: "info", deepLink: null },
        { title: "Warning thing", body: "b", severity: "warning", deepLink: { path: "/p/x/prompts", query: { engines: "gemini" } } },
      ],
    });
    expect(email.subject).toContain("2 updates");
    expect(email.textBody.indexOf("Warning thing")).toBeLessThan(email.textBody.indexOf("Info thing"));
    expect(email.textBody).toContain("https://app.example/p/x/prompts?engines=gemini");
  });

  it("[STORY-068 #10 / AC10] an empty digest is never rendered", () => {
    expect(() => renderDigestEmail({ cadence: "daily", periodLabel: "x", appOrigin: undefined, items: [] })).toThrow(/empty digest/u);
  });
});
