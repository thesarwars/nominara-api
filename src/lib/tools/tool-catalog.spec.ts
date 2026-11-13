import { describe, expect, it } from "vitest";
import { toolCatalogResponseSchema, TOOL_KEYS } from "../../../contracts/tools/index.js";
import { AUX_AUDITS_ENTITLEMENT } from "../aux/onboarding-audit.js";
import { entitlementGranted } from "../entitlements/granted.js";
import { buildToolCatalog, TOOL_GATES, type ToolGates } from "./tool-catalog.js";

// STORY-078 AC23 / scenario 23 - "Read the tool catalog on a plan missing a tool: a disabled descriptor naming the unlocking plan".

const growth = { key: "growth", display_name: "Growth" };
const starter = { key: "starter", display_name: "Starter" };
const unlockers = new Map([
  ["aux.scheduled_audits", starter],
  ["tools.visibility_scan", growth],
]);
const granted = (value: unknown) => ({ value });

describe("STORY-078 · scenario 23 - the tool catalog", () => {
  it("scenario 23 - a plan missing a tool gets a DISABLED descriptor naming the lowest plan that unlocks it, never a missing entry", () => {
    const gates: ToolGates = { tools: { visibility_scan: "tools.visibility_scan" }, modes: {} };
    const catalog = buildToolCatalog({ entitlements: { "tools.visibility_scan": granted(false) }, gates, unlockers });
    expect(catalog.tools.map((t) => t.tool_key)).toEqual([...TOOL_KEYS]);
    const scan = catalog.tools.find((t) => t.tool_key === "visibility_scan")!;
    expect(scan.enabled).toBe(false);
    expect(scan.unlocked_by_plan).toEqual(growth);
  });

  it("scenario 23 - a plan that has the tool gets it enabled with no unlock plan", () => {
    const gates: ToolGates = { tools: { visibility_scan: "tools.visibility_scan" }, modes: {} };
    const scan = buildToolCatalog({ entitlements: { "tools.visibility_scan": granted(true) }, gates, unlockers }).tools.find((t) => t.tool_key === "visibility_scan")!;
    expect(scan.enabled).toBe(true);
    expect(scan.unlocked_by_plan).toBeNull();
  });

  it("scenario 23 - an entitlement the plan does not state fails closed (disabled), and null and false both mean no", () => {
    const gates: ToolGates = { tools: { visibility_scan: "tools.visibility_scan" }, modes: {} };
    for (const entitlements of [{}, { "tools.visibility_scan": granted(null) }, { "tools.visibility_scan": granted(false) }]) {
      expect(buildToolCatalog({ entitlements, gates, unlockers }).tools.find((t) => t.tool_key === "visibility_scan")!.enabled).toBe(false);
    }
  });

  it("scenario 23 - fail closed: only true, a number above 0, or a non-empty string other than none / none_tools_only is granted", () => {
    for (const value of [true, 1, 450, 0.5, "unlimited", "1_per_project_per_month", "configurable"]) expect(entitlementGranted(value), String(value)).toBe(true);
    for (const value of [false, null, undefined, 0, -1, "", "none", "none_tools_only", {}, [], { value: true }]) expect(entitlementGranted(value), JSON.stringify(value) ?? "undefined").toBe(false);
  });

  it("scenario 23 - a gated tool whose entitlement is 0, none or none_tools_only is DISABLED, not enabled", () => {
    const gates: ToolGates = { tools: { visibility_scan: "tools.visibility_scan" }, modes: {} };
    for (const value of [0, "none", "none_tools_only"]) {
      const scan = buildToolCatalog({ entitlements: { "tools.visibility_scan": granted(value) }, gates, unlockers }).tools.find((t) => t.tool_key === "visibility_scan")!;
      expect(scan.enabled, String(value)).toBe(false);
      expect(scan.unlocked_by_plan).toEqual(growth);
    }
  });

  it("scenario 23 - a disabled tool no plan grants is still listed, with a null unlock plan", () => {
    const gates: ToolGates = { tools: { competitor_finder: "tools.nowhere" }, modes: {} };
    const entry = buildToolCatalog({ entitlements: {}, gates, unlockers }).tools.find((t) => t.tool_key === "competitor_finder")!;
    expect(entry.enabled).toBe(false);
    expect(entry.unlocked_by_plan).toBeNull();
  });

  it("scenario 23 - the shipped gates: every tool is on every plan (no per-tool entitlement key exists), the full AUX audit mode alone is plan-gated", () => {
    expect(TOOL_GATES.tools).toEqual({});
    expect(TOOL_GATES.modes.aux_audit).toEqual({ full: AUX_AUDITS_ENTITLEMENT });
    const free = buildToolCatalog({ entitlements: { [AUX_AUDITS_ENTITLEMENT]: granted(false) }, gates: TOOL_GATES, unlockers });
    expect(free.tools.every((t) => t.enabled)).toBe(true);
    const audit = free.tools.find((t) => t.tool_key === "aux_audit")!;
    expect(audit.modes).toEqual([
      { mode: "site_files", enabled: true, credits: 0, unlocked_by_plan: null },
      { mode: "full", enabled: false, credits: null, unlocked_by_plan: starter },
    ]);
    const paid = buildToolCatalog({ entitlements: { [AUX_AUDITS_ENTITLEMENT]: granted(12) }, gates: TOOL_GATES, unlockers });
    expect(paid.tools.find((t) => t.tool_key === "aux_audit")!.modes[1]).toEqual({ mode: "full", enabled: true, credits: null, unlocked_by_plan: null });
  });

  it("scenario 23 - prices: the free tools say 0 (never null), the flat tools their figure, the variable ones null", () => {
    const byKey = new Map(buildToolCatalog({ entitlements: {}, gates: TOOL_GATES, unlockers }).tools.map((t) => [t.tool_key, t.pricing]));
    expect(byKey.get("schema_builder")).toEqual({ rate: "free", credits: 0 });
    expect(byKey.get("compare_runs")).toEqual({ rate: "free", credits: 0 });
    expect(byKey.get("visibility_scan")).toEqual({ rate: "flat", credits: 10 });
    expect(byKey.get("competitor_finder")).toEqual({ rate: "flat", credits: 1 });
    expect(byKey.get("prompt_research")).toEqual({ rate: "per_unit", credits: null });
    expect(byKey.get("aux_audit")).toEqual({ rate: "per_page_band", credits: null });
  });

  it("scenario 23 - the response satisfies its contract", () => {
    expect(() => toolCatalogResponseSchema.parse(buildToolCatalog({ entitlements: {}, gates: TOOL_GATES, unlockers }))).not.toThrow();
  });
});
