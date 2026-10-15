// STORY-072 AC13 — a reservation in flight at the cycle roll (owner decision 2026-10-15, option B "keep the hold").
// STUB (red commit): the real module lands with the fix.

export interface OpenHold {
  readonly idempotencyKey: string;
  readonly attempt: number;
  /** What the hold reserves. */
  readonly credits: number;
  /** What it already carries from an earlier roll (0 for a hold no roll has touched). */
  readonly carry: number;
}

export interface AssignedCarry {
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly carry: number;
}

export function assignCarries(_carryTotal: number, holds: readonly OpenHold[]): AssignedCarry[] {
  return holds.map((hold) => ({ idempotencyKey: hold.idempotencyKey, attempt: hold.attempt, carry: 0 }));
}
