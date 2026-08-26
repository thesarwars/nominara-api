// STORY-031 Phase H — EC-08: "a hard stop that degrades to the priority
// prompt subset across all tenants proportionally — never by starving one
// tenant to serve another." Pure — no I/O, no clock. `src/lib/optimizer`'s
// "never loop numerically over an array >100 elements" constraint does not
// apply to this file (it lives in `src/lib/engines`, not
// `src/lib/optimizer`), but the algorithm here is O(n log n) regardless.

export interface TenantShare {
  readonly tenantId: string;
  /**
   * Proportional to how much capacity this tenant would normally receive
   * (e.g. its priority-subset size). 0 is valid — see the zero-weight case
   * below. Negative is NOT valid — `allocateProportionally` rejects it (see
   * `NegativeTenantWeightError`) rather than silently clamping it, because a
   * negative weight reaching this function at all is a caller defect.
   */
  readonly weight: number;
}

/** Code-review finding 3 — a negative weight is a caller bug, not a runtime condition to absorb: with other tenants keeping totalWeight > 0, a negative weight could otherwise produce a negative or below-guaranteed-minimum allocation for that tenant. Fails loud rather than clamping. */
export class NegativeTenantWeightError extends Error {
  constructor(tenantId: string, weight: number) {
    super(`tenant '${tenantId}' has a negative weight (${weight}) — allocateProportionally rejects this as a caller defect rather than clamping it`);
    this.name = "NegativeTenantWeightError";
  }
}

/**
 * qa-reviewer finding — a non-integer or negative `totalCapacity` breaks the
 * "sums exactly to capacity" invariant this file promises (a non-integer
 * capacity can only ever be approximated by an integer allocation; a
 * negative one produces negative per-tenant shares). Same fail-loud-on-
 * caller-defect posture as `NegativeTenantWeightError` — rejected outright
 * rather than silently floored/clamped.
 */
export class InvalidCapacityError extends Error {
  constructor(totalCapacity: number) {
    super(`totalCapacity (${totalCapacity}) must be a non-negative integer — allocateProportionally rejects this as a caller defect rather than flooring or clamping it`);
    this.name = "InvalidCapacityError";
  }
}

/**
 * Largest-remainder (Hamilton) method, with one fairness guarantee added on
 * top: whenever `totalCapacity >= tenants.length`, EVERY tenant gets at
 * least 1 unit before the remaining capacity is distributed proportionally
 * by weight (including zero-weight tenants) — the property that matters
 * under a hard stop is that no tenant is zeroed while another is served,
 * not merely that the split is proportional. When capacity is smaller than
 * the tenant count, that guarantee is mathematically impossible for
 * everyone at once; this falls back to plain largest-remainder in that
 * documented edge case (some tenants may then get 0).
 *
 * Deterministic: ties in the fractional remainder are broken by tenantId
 * ascending, so the SAME input always produces the SAME allocation.
 */
export function allocateProportionally(totalCapacity: number, tenants: readonly TenantShare[]): Map<string, number> {
  if (!Number.isInteger(totalCapacity) || totalCapacity < 0) {
    throw new InvalidCapacityError(totalCapacity);
  }

  const allocation = new Map<string, number>();
  if (tenants.length === 0) {
    return allocation;
  }

  for (const tenant of tenants) {
    if (tenant.weight < 0) {
      throw new NegativeTenantWeightError(tenant.tenantId, tenant.weight);
    }
  }

  const guaranteedMin = totalCapacity >= tenants.length ? 1 : 0;
  const remainingCapacity = totalCapacity - guaranteedMin * tenants.length;

  const totalWeight = tenants.reduce((sum, t) => sum + t.weight, 0);
  // No meaningful weights at all (every tenant weight 0 — negative weights
  // are rejected above, so this is the only remaining way totalWeight can be
  // <=0) — fall back to an equal split of the remaining capacity rather than
  // dividing by zero.
  const effectiveWeights = totalWeight > 0 ? tenants.map((t) => t.weight) : tenants.map(() => 1);
  const effectiveTotalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0);

  const shares = tenants.map((t, i) => {
    const quota = (remainingCapacity * effectiveWeights[i]!) / effectiveTotalWeight;
    const floor = Math.floor(quota);
    return { tenantId: t.tenantId, floor, remainder: quota - floor };
  });

  const flooredSum = shares.reduce((sum, s) => sum + s.floor, 0);
  let leftover = remainingCapacity - flooredSum;

  for (const s of shares) {
    allocation.set(s.tenantId, guaranteedMin + s.floor);
  }

  const byRemainderDesc = [...shares].sort((a, b) => b.remainder - a.remainder || a.tenantId.localeCompare(b.tenantId));
  for (let i = 0; i < byRemainderDesc.length && leftover > 0; i++, leftover--) {
    const s = byRemainderDesc[i]!;
    allocation.set(s.tenantId, (allocation.get(s.tenantId) ?? 0) + 1);
  }

  return allocation;
}
