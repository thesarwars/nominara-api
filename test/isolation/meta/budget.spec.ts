import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertWithinBudget, IsolationBudgetError, ISOLATION_BUDGET_MS } from "../support/budget.js";

// STORY-012 AC12 / D-5 - "total runtime stays inside a bound that keeps it viable on every pull request". The bound used to be an inline
// comparison in global-setup's two teardowns, never exercised: nothing showed that an overrun fails, or that both targets (local and
// staging) are held to it. It is one function now, and this file is what shows it can fail.
const here = path.dirname(fileURLToPath(import.meta.url));

describe("STORY-012 AC12 · the isolation suite's runtime budget is enforced, and the enforcement can fail", () => {
  it("the bound is five minutes", () => {
    expect(ISOLATION_BUDGET_MS).toBe(5 * 60 * 1000);
  });

  it("a run inside the budget passes, including at exactly the bound", () => {
    expect(() => assertWithinBudget(1)).not.toThrow();
    expect(() => assertWithinBudget(ISOLATION_BUDGET_MS)).not.toThrow();
  });

  it("a run one millisecond over the bound fails, naming the elapsed time and the bound", () => {
    expect(() => assertWithinBudget(ISOLATION_BUDGET_MS + 1)).toThrow(IsolationBudgetError);
    expect(() => assertWithinBudget(ISOLATION_BUDGET_MS + 1)).toThrow(new RegExp(`${String(ISOLATION_BUDGET_MS + 1)}ms.*${String(ISOLATION_BUDGET_MS)}ms`, "u"));
  });

  it("a clock that cannot be trusted (NaN, negative) fails closed rather than passing", () => {
    expect(() => assertWithinBudget(Number.NaN)).toThrow(IsolationBudgetError);
    expect(() => assertWithinBudget(-1)).toThrow(IsolationBudgetError);
    expect(() => assertWithinBudget(Number.POSITIVE_INFINITY)).toThrow(IsolationBudgetError);
  });

  it("an explicit smaller bound is honoured (the function is not hard-wired to the constant)", () => {
    expect(() => assertWithinBudget(1_001, 1_000)).toThrow(IsolationBudgetError);
    expect(() => assertWithinBudget(1_000, 1_000)).not.toThrow();
  });

  it("both teardowns in global-setup (the local container and the staging target) go through it, and set a failing exit code themselves", () => {
    const source = readFileSync(path.join(here, "..", "support", "global-setup.ts"), "utf8");
    // Two targets, two teardowns, one check each: removing the call from either one silently un-bounds that target.
    expect(source.match(/assertWithinBudget\(/gu)?.length).toBe(2);
    // vitest does not turn a teardown throw into a non-zero exit code on its own; each teardown must do it, or an overrun would pass CI.
    expect(source.match(/process\.exitCode = 1/gu)?.length).toBe(2);
    // No second, inline copy of the bound survives beside the shared one.
    expect(source).not.toMatch(/5 \* 60 \* 1000/u);
  });
});
