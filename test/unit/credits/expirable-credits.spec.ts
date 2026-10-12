import { describe, expect, it } from "vitest";
import { expirableCredits } from "../../../src/lib/credits/expire.js";

// STORY-076 AC4 — the FIFO arithmetic, pinned without a database. The integration spec proves the SQL around it.
//   expirable = min( P, max(0, E - max(0, T - P)), included + P - reserved )
describe("expirableCredits", () => {
  const base = { purchased: 0, included: 0, reserved: 0, elapsedLots: 0, allLots: 0 };

  it("is the whole elapsed lot when nothing was spent", () => {
    expect(expirableCredits({ ...base, purchased: 1000, elapsedLots: 1000, allLots: 1000 })).toBe(1000);
  });
  it("is zero with no elapsed lot", () => {
    expect(expirableCredits({ ...base, purchased: 1000, allLots: 1000 })).toBe(0);
  });
  it("is zero when FIFO spending consumed the elapsed lot (oldest first)", () => {
    expect(expirableCredits({ ...base, purchased: 450, elapsedLots: 100, allLots: 600 })).toBe(0); // consumed 150 >= 100
  });
  it("is what is left of a partly spent elapsed lot", () => {
    expect(expirableCredits({ ...base, purchased: 570, elapsedLots: 100, allLots: 600 })).toBe(70); // consumed 30
  });
  it("is bounded by the purchased balance", () => {
    expect(expirableCredits({ ...base, purchased: 50, elapsedLots: 200, allLots: 200 })).toBe(50);
  });
  it("is bounded by what a live reservation leaves free", () => {
    expect(expirableCredits({ ...base, purchased: 100, reserved: 60, elapsedLots: 100, allLots: 100 })).toBe(40);
    expect(expirableCredits({ ...base, purchased: 100, included: 25, reserved: 60, elapsedLots: 100, allLots: 100 })).toBe(65);
  });
  it("is zero when the hold already exceeds the balance headroom", () => {
    expect(expirableCredits({ ...base, purchased: 100, reserved: 100, elapsedLots: 100, allLots: 100 })).toBe(0);
  });
  it("never goes negative when the balance exceeds every lot (credits arrived by refund or adjustment)", () => {
    expect(expirableCredits({ ...base, purchased: 500, elapsedLots: 100, allLots: 300 })).toBe(100);
    expect(expirableCredits({ ...base, purchased: 0, elapsedLots: 100, allLots: 100 })).toBe(0);
  });
  it("is zero for an empty wallet and for no lots at all", () => {
    expect(expirableCredits(base)).toBe(0);
  });
});
