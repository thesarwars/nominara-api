import { describe, expect, it } from "vitest";
import { assignCarries, type OpenHold } from "../../../src/lib/credits/hold-carry.js";

// STORY-072 AC13 · option B (owner decision 2026-10-15). The roll keeps `min(included, reserved)` credits with the
// holds that were open at the roll; THIS function says which hold keeps how much. It is pure, and the ledger replay
// calls the very same function on the holds it reconstructs from the ledger, so the wallet and its verifier cannot
// disagree about the split by construction (they can still disagree about the inputs, which is what replay checks).

const hold = (idempotencyKey: string, credits: number, carry = 0): OpenHold => ({ idempotencyKey, attempt: 1, credits, carry });
const carries = (total: number, holds: OpenHold[]): number[] => assignCarries(total, holds).map((h) => h.carry);

describe("STORY-072 AC13 · assignCarries", () => {
  it("fills holds in the order they were opened, each up to what it reserves", () => {
    expect(carries(200, [hold("a", 120), hold("b", 80), hold("c", 50)])).toEqual([120, 80, 0]);
  });

  it("gives the last funded hold only what is left", () => {
    expect(carries(150, [hold("a", 120), hold("b", 80)])).toEqual([120, 30]);
  });

  it("never gives a hold more than it reserves, however much there is to carry", () => {
    expect(carries(500, [hold("a", 100)])).toEqual([100]);
  });

  it("carries nothing when there is nothing to carry", () => {
    expect(carries(0, [hold("a", 100), hold("b", 50)])).toEqual([0, 0]);
  });

  it("an empty list of holds assigns nothing", () => {
    expect(assignCarries(100, [])).toEqual([]);
  });

  it("serves a hold that ALREADY carries from an earlier roll first, and keeps the input order in the result", () => {
    const holds = [hold("a", 100, 0), hold("b", 100, 50)];
    const out = assignCarries(120, holds);
    expect(out.map((h) => h.idempotencyKey)).toEqual(["a", "b"]);
    expect(out.map((h) => h.carry)).toEqual([20, 100]);
  });

  it("carries the attempt through, because two attempts of one key are two holds", () => {
    const out = assignCarries(150, [
      { idempotencyKey: "k", attempt: 1, credits: 100, carry: 0 },
      { idempotencyKey: "k", attempt: 2, credits: 100, carry: 0 },
    ]);
    expect(out.map((h) => [h.attempt, h.carry])).toEqual([[1, 100], [2, 50]]);
  });
});
