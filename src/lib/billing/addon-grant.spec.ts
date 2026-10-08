import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../db/seed/plan-entitlements.js";
import { mergeEntitlements } from "../entitlements/resolution.js";
import { ADDON_CATALOG, addonGrant } from "./addon-catalog.js";

// STORY-076b · STORY-076 AC11 / scenarios 10 and 11 — the grant statement is
// DERIVED from the resolver's own addonContributions, so the control and the
// resolved entitlements cannot disagree.

describe("STORY-076b · addon catalog", () => {
  it("scenario 10 · the owner-approved prices, as numeric(12,2) text and not a float", () => {
    expect(ADDON_CATALOG.extra_project.monthlyUsd).toBe("49.00");
    expect(ADDON_CATALOG.extra_seat.monthlyUsd).toBe("15.00");
  });

  it("each add-on names the plan flag that gates it", () => {
    expect(ADDON_CATALOG.extra_project.allowedKey).toBe("projects.addon_allowed");
    expect(ADDON_CATALOG.extra_seat.allowedKey).toBe("seats.addon_allowed");
  });
});

describe("STORY-076b · addonGrant", () => {
  const growth = PLAN_ENTITLEMENTS.growth;
  const perProject = growth["prompts.max_per_project"]!.value as number;

  it("scenario 10 · an extra project grants a project slot AND its prompt slots", () => {
    const grant = addonGrant(growth, "extra_project");
    expect(grant.projects).toBe(1);
    expect(grant.prompt_slots).toBe(perProject);
    expect(grant.seats).toBe(0);
    expect(perProject).toBeGreaterThan(0);
  });

  it("scenario 11 · the statement names BOTH halves of the grant", () => {
    const { statement } = addonGrant(growth, "extra_project");
    expect(statement).toContain("1 project");
    expect(statement).toContain(`${String(perProject)} prompt slots`);
  });

  it("an extra seat grants one seat and no project or prompt capacity", () => {
    const grant = addonGrant(growth, "extra_seat");
    expect(grant).toMatchObject({ projects: 0, prompt_slots: 0, seats: 1 });
    expect(grant.statement).toContain("1 seat");
    expect(grant.statement).not.toContain("prompt");
  });

  it("the grant equals what the resolver actually adds for one unit (they cannot disagree)", () => {
    const base = mergeEntitlements(growth, {}, {});
    const withProject = mergeEntitlements(growth, { extra_project: 1 }, {});
    const grant = addonGrant(growth, "extra_project");
    expect((withProject["projects.max"]!.value as number) - (base["projects.max"]!.value as number)).toBe(grant.projects);
    expect((withProject["prompts.max_total"]!.value as number) - (base["prompts.max_total"]!.value as number)).toBe(grant.prompt_slots);
    const withSeat = mergeEntitlements(growth, { extra_seat: 1 }, {});
    expect((withSeat["seats.max"]!.value as number) - (base["seats.max"]!.value as number)).toBe(addonGrant(growth, "extra_seat").seats);
  });

  it("null path · a plan with no numeric per-project prompt cap grants the project and does not claim prompt slots", () => {
    const grant = addonGrant({ ...growth, "prompts.max_per_project": { ...growth["prompts.max_per_project"]!, value: null } }, "extra_project");
    expect(grant.projects).toBe(1);
    expect(grant.prompt_slots).toBe(0);
    expect(grant.statement).not.toContain("prompt slots");
  });

  it("a non-numeric ceiling (enterprise) grants nothing rather than a invented number", () => {
    expect(addonGrant(PLAN_ENTITLEMENTS.enterprise, "extra_project")).toMatchObject({ projects: 0, prompt_slots: 0, seats: 0 });
  });
});
