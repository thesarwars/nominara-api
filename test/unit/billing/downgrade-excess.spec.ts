import { describe, expect, it } from "vitest";
import { PLAN_ENTITLEMENTS } from "../../../src/db/seed/plan-entitlements.js";
import { computeDowngradeExcess, type ExcessUsage } from "../../../src/lib/billing/downgrade-excess.js";

// STORY-184 T5 — what a downgrade names. Test scenarios 2 and 3; the boundary is the point of most of these.
// The plans are the REAL seed (plans-and-entitlements.md §2), so a matrix edit moves these tests with it.

const P1 = "0194a3d2-0000-7000-8000-000000000001";
const P2 = "0194a3d2-0000-7000-8000-000000000002";
const P3 = "0194a3d2-0000-7000-8000-000000000003";
const P4 = "0194a3d2-0000-7000-8000-000000000004";
const P5 = "0194a3d2-0000-7000-8000-000000000005";

function usage(over: Partial<ExcessUsage> = {}): ExcessUsage {
  return { workspace: { "projects.max": 0, "prompts.max_total": 0, "seats.max": 1, "api.keys_max": 0 }, projects: [], ...over };
}
const project = (id: string, name: string, prompts = 0, competitors = 0) => ({ id, name, prompts, competitors });

function run(from: "free" | "starter" | "growth" | "business" | "enterprise", to: typeof from, u: ExcessUsage, opts: { held?: { extra_project?: number; extra_seat?: number }; overrides?: Record<string, number | string | boolean | null> } = {}) {
  return computeDowngradeExcess({ currentPlan: PLAN_ENTITLEMENTS[from], targetPlan: PLAN_ENTITLEMENTS[to], heldAddons: opts.held ?? {}, overrides: opts.overrides ?? {}, usage: u });
}

describe("STORY-184 · computeDowngradeExcess — structural limits", () => {
  it("scenario 2 · projects over the target: the excess count and the NEWEST excess projects first", () => {
    // business allows 5, growth allows 3; five projects, listed newest first.
    const r = run("business", "growth", usage({ workspace: { "projects.max": 5, "prompts.max_total": 0, "seats.max": 1, "api.keys_max": 0 }, projects: [project(P5, "e"), project(P4, "d"), project(P3, "c"), project(P2, "b"), project(P1, "a")] }));
    expect(r.structural).toEqual([{ kind: "structural", key: "projects.max", limit: 3, current: 5, excess: 2, effect: "paused_at_period_end", items: [{ id: P5, name: "e" }, { id: P4, name: "d" }] }]);
  });

  it("BOUNDARY · usage exactly at the target's limit is not an excess; one over is", () => {
    const at = run("business", "growth", usage({ workspace: { "projects.max": 3, "prompts.max_total": 120, "seats.max": 7, "api.keys_max": 0 } }));
    expect(at.structural).toEqual([]);
    const over = run("business", "growth", usage({ workspace: { "projects.max": 3, "prompts.max_total": 121, "seats.max": 7, "api.keys_max": 0 } }));
    expect(over.structural).toEqual([{ kind: "structural", key: "prompts.max_total", limit: 120, current: 121, excess: 1, effect: "paused_at_period_end" }]);
  });

  it("scenario 2 · seats, prompts and API keys over the target each get their own entry, in a stable order", () => {
    const r = run("business", "growth", usage({ workspace: { "projects.max": 0, "prompts.max_total": 200, "seats.max": 12, "api.keys_max": 2 } }));
    expect(r.structural.map((e) => (e.kind === "structural" ? [e.key, e.limit, e.current, e.excess, e.effect] : null))).toEqual([
      ["prompts.max_total", 120, 200, 80, "paused_at_period_end"],
      ["seats.max", 7, 12, 5, "must_reduce"],
      ["api.keys_max", 0, 2, 2, "must_reduce"],
    ]);
  });

  it("scenario 2 · a per-project cap is checked project by project and names the project", () => {
    // growth allows 40 prompts and 10 competitors per project; business 50 / 10.
    const r = run("business", "growth", usage({ projects: [project(P2, "big", 45, 11), project(P1, "ok", 40, 10)] }));
    expect(r.structural).toEqual([
      { kind: "structural", key: "prompts.max_per_project", project_id: P2, limit: 40, current: 45, excess: 5, effect: "paused_at_period_end" },
      { kind: "structural", key: "competitors.max_per_project", project_id: P2, limit: 10, current: 11, excess: 1, effect: "must_reduce" },
    ]);
  });

  it("an add-on the target plan still allows SURVIVES and raises the target's limit with it", () => {
    // growth: 7 seats + 2 extra = 9; starter allows extra seats, base 3 → 5.
    const held = { extra_seat: 2 };
    const ok = run("growth", "starter", usage({ workspace: { "projects.max": 1, "prompts.max_total": 0, "seats.max": 5, "api.keys_max": 0 } }), { held });
    expect(ok.structural).toEqual([]);
    const over = run("growth", "starter", usage({ workspace: { "projects.max": 1, "prompts.max_total": 0, "seats.max": 6, "api.keys_max": 0 } }), { held });
    expect(over.structural).toEqual([{ kind: "structural", key: "seats.max", limit: 5, current: 6, excess: 1, effect: "must_reduce" }]);
    expect(over.informational.filter((e) => e.kind === "addon_dropped")).toEqual([]);
  });

  it("scenario 3 · an add-on the target plan does NOT allow is dropped, named, and no longer counts toward the limit", () => {
    // growth + 1 extra project (4 projects, 40+40 prompt slots) → starter (extra projects not allowed): 1 project.
    const r = run("growth", "starter", usage({ workspace: { "projects.max": 2, "prompts.max_total": 0, "seats.max": 1, "api.keys_max": 0 }, projects: [project(P2, "b"), project(P1, "a")] }), { held: { extra_project: 1 } });
    expect(r.informational).toContainEqual({ kind: "addon_dropped", addon: "extra_project", quantity: 1 });
    expect(r.structural).toEqual([{ kind: "structural", key: "projects.max", limit: 1, current: 2, excess: 1, effect: "paused_at_period_end", items: [{ id: P2, name: "b" }] }]);
  });

  it("an unlimited or negotiated target never has an excess", () => {
    const r = run("business", "enterprise", usage({ workspace: { "projects.max": 500, "prompts.max_total": 99999, "seats.max": 500, "api.keys_max": 500 }, projects: [project(P1, "a", 9999, 9999)] }));
    expect(r.structural).toEqual([]);
  });

  it("null path · a tier with no allowance (free) makes any use an excess: projects.max 0, per-project caps null = 0", () => {
    const r = run("starter", "free", usage({ workspace: { "projects.max": 1, "prompts.max_total": 5, "seats.max": 1, "api.keys_max": 0 }, projects: [project(P1, "a", 5, 2)] }));
    const keys = r.structural.map((e) => (e.kind === "structural" ? e.key : ""));
    expect(keys).toEqual(["projects.max", "prompts.max_total", "prompts.max_per_project", "competitors.max_per_project"]);
  });

  it("empty collections · a workspace with no projects and nothing used has no excess at all", () => {
    const r = run("business", "starter", usage());
    expect(r.structural).toEqual([]);
  });

  it("an operator override on the target is final: it raises the ceiling the usage is checked against", () => {
    const u = usage({ workspace: { "projects.max": 5, "prompts.max_total": 0, "seats.max": 1, "api.keys_max": 0 }, projects: [project(P5, "e"), project(P4, "d"), project(P3, "c"), project(P2, "b"), project(P1, "a")] });
    expect(run("business", "growth", u).structural).toHaveLength(1);
    expect(run("business", "growth", u, { overrides: { "projects.max": 10 } }).structural).toEqual([]);
  });
});

describe("STORY-184 · computeDowngradeExcess — what is named but does not block", () => {
  it("scenario 3 · features lost are listed (live ones only) and never block", () => {
    const r = run("business", "growth", usage());
    expect(r.structural).toEqual([]);
    const lost = r.informational.filter((e) => e.kind === "feature_lost").map((e) => (e.kind === "feature_lost" ? e.key : ""));
    expect(lost).toContain("whitelabel.email_digest");
    // `whitelabel.custom_domain` is a real business entitlement but NOT live in v1 (§2): it renders nowhere, so it is not "lost".
    expect(lost).not.toContain("whitelabel.custom_domain");
    expect(lost).toEqual([...lost].sort((a, b) => a.localeCompare(b)));
  });

  it("scenario 3 · retention shortened names both windows; an unlimited current window is null", () => {
    const r = run("business", "growth", usage());
    expect(r.informational).toContainEqual({ kind: "retention_shortened", key: "retention.raw_captures_days", from_days: 395, to_days: 180 });
    expect(r.informational).toContainEqual({ kind: "retention_shortened", key: "retention.rollups_days", from_days: 1095, to_days: 730 });
    const fromEnterprise = run("enterprise", "business", usage());
    expect(fromEnterprise.informational).toContainEqual({ kind: "retention_shortened", key: "retention.rollups_days", from_days: null, to_days: 1095 });
  });

  it("retention that does not shrink is not named; a tier with no rollup retention keeps 0", () => {
    expect(run("growth", "business", usage()).informational.filter((e) => e.kind === "retention_shortened")).toEqual([]);
    const toFree = run("starter", "free", usage());
    expect(toFree.informational).toContainEqual({ kind: "retention_shortened", key: "retention.rollups_days", from_days: 395, to_days: 0 });
  });

  it("`all` is the structural entries first, then the informational ones", () => {
    const r = run("business", "growth", usage({ workspace: { "projects.max": 4, "prompts.max_total": 0, "seats.max": 1, "api.keys_max": 0 }, projects: [project(P4, "d"), project(P3, "c"), project(P2, "b"), project(P1, "a")] }));
    expect(r.all).toEqual([...r.structural, ...r.informational]);
    expect(r.all[0]).toMatchObject({ kind: "structural" });
  });
});

describe("STORY-077 · plans-and-entitlements.md §14 — projects and prompts are PAUSED at the cut-over, never a refusal", () => {
  it("scenario 1 · projects, the workspace prompt total and a per-project prompt cap over the target do NOT block", () => {
    const r = run("business", "growth", usage({ workspace: { "projects.max": 5, "prompts.max_total": 200, "seats.max": 1, "api.keys_max": 0 }, projects: [project(P5, "e", 45), project(P4, "d"), project(P3, "c"), project(P2, "b"), project(P1, "a")] }));
    expect(r.structural.map((e) => (e.kind === "structural" ? e.key : ""))).toEqual(["projects.max", "prompts.max_total", "prompts.max_per_project"]);
    expect(r.blocking, "§14: accepted, effective at period end").toEqual([]);
    expect(r.structural.every((e) => e.kind === "structural" && e.effect === "paused_at_period_end")).toBe(true);
  });

  it("seats, competitors and API keys — which §14 does not name as pausable — still BLOCK (must_reduce)", () => {
    const r = run("business", "growth", usage({ workspace: { "projects.max": 0, "prompts.max_total": 0, "seats.max": 12, "api.keys_max": 2 }, projects: [project(P1, "a", 0, 11)] }));
    expect(r.blocking.map((e) => (e.kind === "structural" ? [e.key, e.effect] : null))).toEqual([
      ["seats.max", "must_reduce"],
      ["api.keys_max", "must_reduce"],
      ["competitors.max_per_project", "must_reduce"],
    ]);
  });

  it("a mixed excess blocks on the must_reduce entries only, and names the pausable ones alongside", () => {
    const r = run("business", "growth", usage({ workspace: { "projects.max": 5, "prompts.max_total": 0, "seats.max": 8, "api.keys_max": 0 }, projects: [project(P5, "e"), project(P4, "d"), project(P3, "c"), project(P2, "b"), project(P1, "a")] }));
    expect(r.blocking).toEqual([{ kind: "structural", key: "seats.max", limit: 7, current: 8, excess: 1, effect: "must_reduce" }]);
    expect(r.structural).toHaveLength(2);
  });
});
