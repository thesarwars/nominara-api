import type { ClientBase } from "pg";
import { appendLedgerEntry, settlementOf, type LedgerActionCode, type LedgerMovementEntry } from "./ledger.js";
import { readHoldCarry, settleHoldCarry } from "./hold-carry.js";
import { commitCredits, lockWallet, readWallet, releaseCredits, type WalletState } from "./wallet.js";

// STORY-073 — the one way a reservation is released, shared by the two
// things that release one.
//
// ⚠ IT EXISTS BECAUSE THERE ARE NOW TWO RELEASERS AND THERE USED TO BE ONE.
// `CreditInterceptor` released on a failed request; STORY-073 added a
// reconciler that releases a hold nobody settled. The second-engineer review
// reproduced what two independent releasers did to one wallet:
//
//   before: reserved 90   (orphan-A 40 + LIVE live-B 50)
//   run A:  released A's 40                        -> reserved 50
//   run B:  the ledger refused a second release entry, the code IGNORED the
//           refusal, and the balance movement committed anyway
//   after : reserved 10   <-- 40 credits of live-B's hold destroyed
//
// Both halves of that were wrong. The refusal was ignored — a `false` from
// `appendLedgerEntry` was treated as a normal outcome while the wallet
// statement it was supposed to authorise had already run, and
// `withTenantContext` committed it. And the check that would have caught it
// earlier ran WITHOUT the wallet row lock, so two runs could both read "not
// yet settled" and both proceed.
//
// The order here is the fix, and the order is the whole point: take the row
// lock, THEN read the ledger, THEN move the balance, and treat a refused
// entry as impossible rather than as an outcome.

export interface SettleableReservation {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly credits: number;
  readonly actionCode: LedgerActionCode;
  /**
   * Whose release this is.
   *
   * Absent means the system's — which is the reconciler, and is the truth
   * there: nobody asked for that release, a sweep noticed an abandoned hold.
   * A failed request's release belongs to the person who made it.
   */
  readonly actor?: { readonly actorId: string | null; readonly actorType: "user" | "api_key" | "system" };
}

export type ReleaseOutcome = "released" | "already_settled";

export class ReservationSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReservationSettlementError";
  }
}

/**
 * Hand a reservation's credits back, exactly once.
 *
 * `already_settled` is a NORMAL outcome, not a failure: a commit got there
 * first, or another releaser did. Nothing moved and nothing needs to.
 *
 * ⚠ THE CALLER MUST BE IN A TRANSACTION. The lock, the read and the movement
 * are one decision; split across transactions they are the race this
 * function exists to close.
 */
export async function releaseReservation(
  tx: ClientBase,
  reservation: SettleableReservation,
  referenceType?: string,
): Promise<ReleaseOutcome> {
  // 1. THE LOCK FIRST. Every balance movement on this workspace serialises
  //    behind it, so the ledger read below cannot be overtaken.
  if (!(await lockWallet(tx, reservation.workspaceId))) {
    throw new ReservationSettlementError(
      `workspace ${reservation.workspaceId} has an open reservation and no wallet row to release it against`,
    );
  }

  // 2. Now the question is answerable. Under the lock this is the truth
  //    until we commit.
  if ((await settlementOf(tx, reservation.workspaceId, reservation.idempotencyKey, reservation.attempt)) !== null) {
    return "already_settled";
  }

  await releaseCredits(tx, reservation.workspaceId, reservation.credits);

  const after = await readWallet(tx, reservation.workspaceId);
  if (after === null) {
    // Locked a row that then vanished — impossible inside one transaction,
    // and recording an invented after-state in a table that must contain no
    // lies is worse than failing.
    throw new ReservationSettlementError(
      `workspace ${reservation.workspaceId} lost its wallet row mid-release`,
    );
  }

  const appended = await appendLedgerEntry(tx, {
    workspaceId: reservation.workspaceId,
    entryType: "release",
    actionCode: reservation.actionCode,
    credits: reservation.credits,
    idempotencyKey: reservation.idempotencyKey,
    attempt: reservation.attempt,
    after,
    actorId: reservation.actor?.actorId ?? null,
    actorType: reservation.actor?.actorType ?? "system",
    ...(referenceType === undefined ? {} : { referenceType }),
  });

  if (!appended) {
    // ⚠ THROW, DO NOT RETURN. The balance has already moved in this
    // transaction; returning would let the caller commit a release the
    // ledger just refused to record — which is precisely the 40 credits the
    // review watched disappear out of an unrelated live hold. Throwing rolls
    // the movement back with the transaction.
    //
    // Under the lock taken above this should be unreachable: the entry can
    // only already exist if something settled between the check and here,
    // and nothing can. It stays because "unreachable" and "does not need
    // handling" are different claims, and this one guards money.
    throw new ReservationSettlementError(
      `the ledger refused a release entry for workspace ${reservation.workspaceId} ` +
        `(key ${reservation.idempotencyKey}, attempt ${String(reservation.attempt)}) while holding the wallet lock`,
    );
  }

  // STORY-072 AC13 (option B): a hold that carries credits across a cycle roll gives them back to the void when it is
  // released unspent — they are old-cycle credit and must not outlive the hold. After the release entry, so the
  // ledger reads "released, then expired" in the order it happened.
  await settleHoldCarry(tx, reservation.workspaceId, reservation.idempotencyKey, reservation.attempt, 0, "released");

  return "released";
}

/** The optional fields a commit entry carries beyond the settlement itself (AC10: the actor, project and reference). */
export type CommitEntryFields = Partial<
  Pick<
    LedgerMovementEntry,
    "actorId" | "actorType" | "actorPseudonym" | "projectId" | "referenceType" | "referenceId" | "unitDetail" | "internalCostUsd"
  >
>;

/**
 * The commit of a reservation: the wallet statement, the `commit` ledger entry and, for a hold that carries credits
 * across a cycle roll, the expiry of the carry's unused remainder — all in the caller's transaction.
 *
 * STORY-072 AC13 (option B). The commit pays from the hold's own carry first (see `commitCredits`), so an action that
 * started before the roll is charged once, to the cycle it started in. What the carry still holds when the hold
 * settles for less than it reserved is expired, as a separate `expire` entry after the `commit` one.
 *
 * Returns null when the commit matched no row (the reservation is no longer held); the caller decides what that means.
 * ⚠ THE CALLER MUST ALREADY HOLD THE WALLET ROW LOCK (this takes it again, which is free): the carry it reads is only
 * true while nothing else settles a hold.
 */
export async function commitReservation(
  tx: ClientBase,
  reservation: SettleableReservation,
  consumed: number,
  entry: CommitEntryFields = {},
): Promise<WalletState | null> {
  if (!(await lockWallet(tx, reservation.workspaceId))) return null;

  const carry = await readHoldCarry(tx, reservation.workspaceId, reservation.idempotencyKey, reservation.attempt);
  const committed = await commitCredits(tx, reservation.workspaceId, consumed, reservation.credits, carry);
  if (committed === null) return null;

  const appended = await appendLedgerEntry(tx, {
    workspaceId: reservation.workspaceId,
    entryType: "commit",
    actionCode: reservation.actionCode,
    credits: consumed,
    idempotencyKey: reservation.idempotencyKey,
    attempt: reservation.attempt,
    after: committed,
    actorId: reservation.actor?.actorId ?? null,
    actorType: reservation.actor?.actorType ?? "system",
    ...entry,
  });
  if (!appended) {
    // The balance has moved in this transaction; returning would commit a debit the ledger refused to record.
    throw new ReservationSettlementError(
      `the ledger refused a commit entry for workspace ${reservation.workspaceId} ` +
        `(key ${reservation.idempotencyKey}, attempt ${String(reservation.attempt)}) while holding the wallet lock`,
    );
  }

  if (carry.held === 0) return committed;
  await settleHoldCarry(
    tx,
    reservation.workspaceId,
    reservation.idempotencyKey,
    reservation.attempt,
    Math.min(consumed, carry.held),
    "committed",
  );
  return (await readWallet(tx, reservation.workspaceId)) ?? committed;
}
