import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { expireCredits } from "./balance.js";

// STORY-072 AC13 — a reservation in flight at the cycle roll. Owner decision 2026-10-15, option B: "keep the hold".
//
// plans-and-entitlements.md §5 resets the included bucket at the roll, and §6 lets an action reserve before the roll
// and commit after it. Resetting literally charged that action TWICE: its held credits were counted as expired by the
// roll and the commit then debited the new grant (grant 1000, spend 300, hold 200, roll to 1200: committing the 200
// ended on 1000 where committing it first ends on 1200). So the roll expires only what is NOT held, and the held part
// — the CARRY — stays in the bucket with its hold:
//
//   * a commit pays from the carry first, so the customer pays once, from the cycle the action started in;
//   * a hold that is released, or committed for less than it held, expires the unused part of its carry at that
//     moment — it is old-cycle credit and must not outlive the hold.
//
// ⚠ THE CARRY IS PER HOLD, NOT AN AGGREGATE. `credit_wallets.reserved` is the sum of every open hold, and an aggregate
// cannot tell whose credits a settlement is spending: a hold taken AFTER the roll would eat an older hold's carry (its
// commit draws "included first", and the carry is physically in the included bucket), and the older hold's release
// would then have nothing left to expire. `credit_hold_carries` says which hold keeps how much, and every draw on the
// bucket by a hold that carries nothing is limited to the bucket MINUS the carries.
//
// ⚠ THE SAME FUNCTION RUNS IN THE ROLL AND IN THE REPLAY. `assignCarries` is pure, and `replay.ts` calls it on the
// holds it reconstructs from the ledger rather than reading `credit_hold_carries`, so the nightly verifier checks the
// table against an independent derivation instead of trusting it.

const logger = new Logger("hold-carry");

/** The key a carry's expiry is recorded under: unique per hold, deterministic, so settling twice expires once. */
export function carryExpiryKey(idempotencyKey: string, attempt: number): string {
  return `hold_carry:${String(attempt)}:${idempotencyKey}`;
}

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

/**
 * Split `carryTotal` (the roll's min(included, reserved)) across the open holds.
 *
 * A hold that ALREADY carries from an earlier roll is served first (its credits are the oldest), then the rest in the
 * order they were opened; each gets at most what it reserves. The result is in the INPUT order. Whatever cannot be
 * attributed to a hold (the aggregate `reserved` exceeding the sum of the ledger's open holds, which is itself a
 * discrepancy the verifier reports) stays in the bucket as ordinary credit.
 */
export function assignCarries(carryTotal: number, holds: readonly OpenHold[]): AssignedCarry[] {
  const order = holds
    .map((hold, index) => ({ hold, index }))
    .sort((a, b) => Number(b.hold.carry > 0) - Number(a.hold.carry > 0) || a.index - b.index);
  const assigned = new Array<AssignedCarry>(holds.length);
  let remaining = Math.max(carryTotal, 0);
  for (const { hold, index } of order) {
    const carry = Math.min(hold.credits, remaining);
    remaining -= carry;
    assigned[index] = { idempotencyKey: hold.idempotencyKey, attempt: hold.attempt, carry };
  }
  return assigned;
}

/**
 * The holds open right now, in the order they were opened, with what each already carries.
 *
 * ⚠ FROM THE LEDGER, NOT FROM `credit_wallets.reserved`: a reserve entry with no commit or release under the same key
 * and attempt. The caller holds the wallet row lock, so no hold opens or settles while this is read.
 */
export async function openHolds(tx: ClientBase, workspaceId: string): Promise<OpenHold[]> {
  const result = await tx.query<{ idempotency_key: string; attempt: number; credits: string; carry: number | null }>(
    `SELECT r.idempotency_key, r.attempt, r.credits::text, c.credits AS carry
       FROM credit_ledger r
       LEFT JOIN credit_hold_carries c
              ON c.workspace_id = r.workspace_id AND c.idempotency_key = r.idempotency_key
             AND c.attempt = r.attempt AND c.settled_at IS NULL
      WHERE r.workspace_id = $1
        AND r.entry_type = 'reserve'
        AND NOT EXISTS (
          SELECT 1 FROM credit_ledger s
           WHERE s.workspace_id = r.workspace_id AND s.idempotency_key = r.idempotency_key
             AND s.attempt = r.attempt AND s.entry_type IN ('commit', 'release')
        )
      ORDER BY r.seq ASC`,
    [workspaceId],
  );
  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    credits: Number(row.credits),
    carry: row.carry ?? 0,
  }));
}

/** Record what each hold carries after a roll. Only the holds whose carry CHANGED are written. */
export async function writeCarries(
  tx: ClientBase,
  workspaceId: string,
  cycleStart: string,
  holds: readonly OpenHold[],
  assigned: readonly AssignedCarry[],
): Promise<void> {
  const changed = assigned.filter((a, i) => a.carry !== holds[i]!.carry);
  if (changed.length === 0) return;
  await tx.query(
    `INSERT INTO credit_hold_carries (workspace_id, idempotency_key, attempt, credits, rolled_cycle_start)
     SELECT $1, t.key, t.attempt, t.credits, $5::date
       FROM unnest($2::text[], $3::int[], $4::int[]) AS t(key, attempt, credits)
     ON CONFLICT (workspace_id, idempotency_key, attempt)
     DO UPDATE SET credits = EXCLUDED.credits, rolled_cycle_start = EXCLUDED.rolled_cycle_start
           WHERE credit_hold_carries.settled_at IS NULL`,
    [
      workspaceId,
      changed.map((a) => a.idempotencyKey),
      changed.map((a) => a.attempt),
      changed.map((a) => a.carry),
      cycleStart,
    ],
  );
}

/** What a commit needs to know before it draws on the bucket. */
export interface HoldCarryView {
  /** This hold's own carry. */
  readonly held: number;
  /** Every open hold's carry, this one's included. */
  readonly total: number;
}

export const NO_CARRY: HoldCarryView = { held: 0, total: 0 };

/** ⚠ THE CALLER MUST HOLD THE WALLET ROW LOCK: the numbers are only true while nothing else settles. */
export async function readHoldCarry(
  tx: ClientBase,
  workspaceId: string,
  idempotencyKey: string,
  attempt: number,
): Promise<HoldCarryView> {
  const result = await tx.query<{ held: number; total: number }>(
    `SELECT COALESCE(SUM(credits) FILTER (WHERE idempotency_key = $2 AND attempt = $3), 0)::int AS held,
            COALESCE(SUM(credits), 0)::int AS total
       FROM credit_hold_carries WHERE workspace_id = $1 AND settled_at IS NULL`,
    [workspaceId, idempotencyKey, attempt],
  );
  const row = result.rows[0];
  return row === undefined ? NO_CARRY : { held: row.held, total: row.total };
}

/** Every open carry the table holds for a workspace (what the nightly verifier compares with the ledger's derivation). */
export async function readOpenCarries(
  tx: ClientBase,
  workspaceId: string,
): Promise<{ idempotencyKey: string; attempt: number; carry: number }[]> {
  const result = await tx.query<{ idempotency_key: string; attempt: number; credits: number }>(
    `SELECT idempotency_key, attempt, credits FROM credit_hold_carries
      WHERE workspace_id = $1 AND settled_at IS NULL AND credits > 0`,
    [workspaceId],
  );
  return result.rows.map((row) => ({ idempotencyKey: row.idempotency_key, attempt: row.attempt, carry: row.credits }));
}

export interface CarrySettlement {
  readonly spent: number;
  readonly expired: number;
}

/**
 * A hold has settled: close its carry and expire whatever of it was not spent.
 *
 * `spentFromCarry` is what the commit statement drew from the carry (0 for a release). The expiry is a real `expire`
 * ledger entry under `carryExpiryKey`, written AFTER the commit/release entry, so the replay and the customer-visible
 * "N credits expired" both have a record to point at. A hold that carries nothing does nothing here.
 */
export async function settleHoldCarry(
  tx: ClientBase,
  workspaceId: string,
  idempotencyKey: string,
  attempt: number,
  spentFromCarry: number,
  outcome: "committed" | "released",
): Promise<CarrySettlement> {
  const closed = await tx.query<{ credits: number }>(
    `UPDATE credit_hold_carries SET settled_at = now()
      WHERE workspace_id = $1 AND idempotency_key = $2 AND attempt = $3 AND settled_at IS NULL
      RETURNING credits`,
    [workspaceId, idempotencyKey, attempt],
  );
  const carried = closed.rows[0]?.credits ?? 0;
  if (carried === 0) return { spent: 0, expired: 0 };

  const expired = carried - spentFromCarry;
  if (expired > 0) {
    const written = await expireCredits(
      tx,
      {
        workspaceId,
        idempotencyKey: carryExpiryKey(idempotencyKey, attempt),
        actorId: null,
        actorType: "system",
        referenceType: "hold_carry",
      },
      "included",
      expired,
    );
    if (!written.applied) {
      // The carry was open, so its expiry cannot already be recorded: the table and the ledger disagree.
      throw new Error(
        `workspace ${workspaceId} is settling a carried hold whose expiry is already in the ledger: ` +
          "the carry table and the ledger disagree about whether it was settled",
      );
    }
  }

  incrementCounter("nominara_credits_hold_carry_settled_total", { outcome });
  // The workspace ID, never its name; credit counts, never the request's key or any engine text.
  logger.log({
    message: "carried hold settled",
    workspace_id: workspaceId,
    outcome,
    spent_credits: spentFromCarry,
    expired_credits: expired,
  });
  return { spent: spentFromCarry, expired };
}
