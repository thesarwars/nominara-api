import { describe, expect, it } from "vitest";
import { allocateProportionally, InvalidCapacityError, NegativeTenantWeightError, type TenantShare } from "../../../src/lib/engines/proportional-degradation.js";

// STORY-031 Phase H — EC-08: "a hard stop that degrades to the priority
// prompt subset across all tenants proportionally — never by starving one
// tenant to serve another." Deterministic largest-remainder allocation:
// sums exactly to capacity, proportional to weight, and — the fairness
// property that matters — no tenant is zeroed while another is fully
// served (guaranteed here whenever capacity >= tenant count).

// A small hand-rolled deterministic PRNG (no new dependency) so the
// property-style sweep below is reproducible, not flaky.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sum(values: readonly number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

describe("STORY-031 · allocateProportionally — deterministic largest-remainder allocation", () => {
  it("splits evenly across equal-weight tenants, summing exactly to capacity", () => {
    const tenants: TenantShare[] = [
      { tenantId: "a", weight: 1 },
      { tenantId: "b", weight: 1 },
      { tenantId: "c", weight: 1 },
    ];
    const allocation = allocateProportionally(10, tenants);
    expect(sum([...allocation.values()])).toBe(10);
    // 10/3 ≈ 3.33 each — nearly even, never off by more than 1 from each other.
    const values = [...allocation.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });

  it("allocates proportionally to weight — a tenant with 3x the weight gets roughly 3x the share", () => {
    const tenants: TenantShare[] = [
      { tenantId: "small", weight: 1 },
      { tenantId: "large", weight: 3 },
    ];
    const allocation = allocateProportionally(40, tenants);
    expect(allocation.get("large")!).toBeGreaterThan(allocation.get("small")! * 2);
  });

  it("no tenant is zeroed while another is fully served, when capacity >= tenant count", () => {
    const tenants: TenantShare[] = [
      { tenantId: "whale", weight: 1000 },
      { tenantId: "minnow", weight: 1 },
    ];
    const allocation = allocateProportionally(10, tenants);
    expect(allocation.get("minnow")).toBeGreaterThan(0);
    expect(allocation.get("whale")).toBeGreaterThan(0);
    expect(sum([...allocation.values()])).toBe(10);
  });

  it("a zero-weight tenant still gets its guaranteed minimum share when capacity >= tenant count", () => {
    const tenants: TenantShare[] = [
      { tenantId: "active", weight: 10 },
      { tenantId: "zero-weight", weight: 0 },
    ];
    const allocation = allocateProportionally(5, tenants);
    expect(allocation.get("zero-weight")).toBeGreaterThan(0);
    expect(sum([...allocation.values()])).toBe(5);
  });

  it("capacity smaller than tenant count cannot guarantee everyone >=1 — documented edge case, still sums exactly", () => {
    const tenants: TenantShare[] = [
      { tenantId: "a", weight: 1 },
      { tenantId: "b", weight: 1 },
      { tenantId: "c", weight: 1 },
    ];
    const allocation = allocateProportionally(2, tenants);
    expect(sum([...allocation.values()])).toBe(2);
    expect([...allocation.values()].filter((v) => v === 0)).toHaveLength(1);
  });

  it("zero capacity → every tenant gets exactly 0, sums to 0", () => {
    const tenants: TenantShare[] = [{ tenantId: "a", weight: 1 }, { tenantId: "b", weight: 1 }];
    const allocation = allocateProportionally(0, tenants);
    expect(sum([...allocation.values()])).toBe(0);
    expect(allocation.get("a")).toBe(0);
    expect(allocation.get("b")).toBe(0);
  });

  it("zero tenants → an empty allocation, never throws", () => {
    expect(allocateProportionally(10, [])).toEqual(new Map());
  });

  // Code-review finding 3 — a negative weight reaching this function is a
  // caller bug (a negative-weight tenant with other tenants keeping
  // totalWeight > 0 could otherwise receive a negative or below-guaranteed
  // allocation). Fails loud rather than silently clamping, matching this
  // story's "fail loud on a config/caller defect" posture (D19's
  // counterpart for infra outages is the opposite: fail soft).
  it("a negative tenant weight is rejected loudly, never silently clamped", () => {
    const tenants: TenantShare[] = [
      { tenantId: "a", weight: 10 },
      { tenantId: "b", weight: -1 },
    ];
    expect(() => allocateProportionally(10, tenants)).toThrow(NegativeTenantWeightError);
  });

  // qa-reviewer finding — a non-integer totalCapacity breaks the "sums
  // exactly to capacity" invariant this file's own docstring promises: e.g.
  // allocateProportionally(10.5, [3 equal-weight tenants]) previously
  // summed to 11, not 10.5 (impossible for an integer allocation) or 10.
  // Rejected loudly at the top of the function, same posture as
  // NegativeTenantWeightError — a non-integer capacity reaching this
  // function at all is a caller defect, never silently floored.
  it("a non-integer totalCapacity is rejected loudly, never silently floored", () => {
    const tenants: TenantShare[] = [
      { tenantId: "a", weight: 1 },
      { tenantId: "b", weight: 1 },
      { tenantId: "c", weight: 1 },
    ];
    expect(() => allocateProportionally(10.5, tenants)).toThrow(InvalidCapacityError);
  });

  // qa-reviewer finding — negative capacity previously produced negative
  // per-tenant allocations (also breaking the invariant that no tenant is
  // ever served a negative share). Rejected loudly, same posture.
  it("a negative totalCapacity is rejected loudly, never producing negative per-tenant allocations", () => {
    const tenants: TenantShare[] = [
      { tenantId: "a", weight: 1 },
      { tenantId: "b", weight: 1 },
      { tenantId: "c", weight: 1 },
    ];
    expect(() => allocateProportionally(-5, tenants)).toThrow(InvalidCapacityError);
  });

  it("is deterministic — the same input always produces the same allocation", () => {
    const tenants: TenantShare[] = [
      { tenantId: "a", weight: 7 },
      { tenantId: "b", weight: 3 },
      { tenantId: "c", weight: 5 },
    ];
    const first = allocateProportionally(17, tenants);
    const second = allocateProportionally(17, tenants);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it("property sweep — many tenant-size mixes (1..40 tenants, random weights) always sum exactly to capacity, and never zero a tenant when capacity >= count", () => {
    const rng = mulberry32(42);
    for (let trial = 0; trial < 200; trial++) {
      const tenantCount = 1 + Math.floor(rng() * 40);
      const capacity = tenantCount + Math.floor(rng() * 200); // always >= tenantCount for this sweep
      const tenants: TenantShare[] = Array.from({ length: tenantCount }, (_, i) => ({
        tenantId: `tenant-${i}`,
        weight: Math.floor(rng() * 1000),
      }));

      const allocation = allocateProportionally(capacity, tenants);

      expect(sum([...allocation.values()])).toBe(capacity);
      expect(allocation.size).toBe(tenantCount);
      for (const value of allocation.values()) {
        expect(value).toBeGreaterThan(0);
        expect(Number.isInteger(value)).toBe(true);
      }
    }
  });
});
