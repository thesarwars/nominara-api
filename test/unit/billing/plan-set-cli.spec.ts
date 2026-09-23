import { describe, expect, it } from "vitest";
import { parsePlanSetArgs, PlanSetUsageError } from "../../../src/workers/billing/plan-set.js";

// STORY-151 — the CLI's refusals, which are a contract with the operator and
// need no database to prove.
describe("STORY-151 · plan:set argument parsing", () => {
  const ok = ["--workspace", "ws-1", "--plan", "growth", "--operator", "op", "--ticket", "T-1", "--reason", "why"];

  it("accepts a complete invocation", () => {
    expect(parsePlanSetArgs(ok)).toMatchObject({
      workspaceId: "ws-1", planKey: "growth", operator: "op", ticket: "T-1", reason: "why",
      allowNegotiatedTier: false,
    });
  });

  // ⚠ ALL THREE PROSE FLAGS ARE MANDATORY AND THAT IS THE POINT. They land on
  // a hash-chained audit row; an upgrade nobody can attribute afterwards is
  // the thing this story is trying not to create.
  it.each(["--workspace", "--plan", "--operator", "--ticket", "--reason"])("refuses a missing %s", (flag) => {
    const i = ok.indexOf(flag);
    const without = [...ok.slice(0, i), ...ok.slice(i + 2)];
    expect(() => parsePlanSetArgs(without)).toThrow(PlanSetUsageError);
  });

  it("refuses --plan free, naming the story that owns going back", () => {
    expect(() => parsePlanSetArgs([...ok.slice(0, 2), "--plan", "free", ...ok.slice(4)])).toThrow(/STORY-077/u);
  });

  // ⚠ `sort_order` CANNOT REFUSE ENTERPRISE — it is the maximum — so this
  // named refusal is the only guard on the unlimited, contract-priced tier.
  it("refuses --plan enterprise unless the second flag is passed too", () => {
    const ent = [...ok.slice(0, 2), "--plan", "enterprise", ...ok.slice(4)];
    expect(() => parsePlanSetArgs(ent)).toThrow(/UNLIMITED/u);
    expect(parsePlanSetArgs([...ent, "--allow-negotiated-tier"])).toMatchObject({
      planKey: "enterprise", allowNegotiatedTier: true,
    });
  });

  it("names an unknown plan rather than letting it reach a foreign-key error", () => {
    expect(() => parsePlanSetArgs([...ok.slice(0, 2), "--plan", "platinum", ...ok.slice(4)])).toThrow(/unknown --plan platinum/u);
  });

  it("refuses a flag with no value, and an invalid interval", () => {
    expect(() => parsePlanSetArgs([...ok, "--interval"])).toThrow(PlanSetUsageError);
    expect(() => parsePlanSetArgs([...ok, "--interval", "weekly"])).toThrow(/monthly or annual/u);
    expect(parsePlanSetArgs([...ok, "--interval", "annual"])).toMatchObject({ billingInterval: "annual" });
  });

  it("refuses a blank required value, not just an absent flag", () => {
    expect(() => parsePlanSetArgs([...ok.slice(0, 8), "--reason", "   "])).toThrow(PlanSetUsageError);
  });
});
