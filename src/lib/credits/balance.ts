import type { ClientBase } from "pg";
import { appendLedgerEntry, type LedgerBalanceType, type LedgerEntry } from "./ledger.js";
import {
  applyBucketDelta,
  provisionWallet,
  type CreditBucket,
  type LifetimeCounter,
  type WalletState,
} from "./wallet.js";

// STORY-073 — the five entry types the ledger has always described and
// nothing has ever written.
//
// ⚠ BEFORE THIS FILE, `credit_ledger` COULD ONLY EXPLAIN A SPEND. `grant`,
// `purchase`, `expire`, `refund` and `adjustment` were in the table's own
// CHECK constraint from migration 0002 and had no writer anywhere in `src/`,
// so a balance could rise or fall with no entry accounting for it — which
// makes the replay in `replay.ts` verify nothing, because the ledger and the
// wallet would disagree by construction the first time a credit was granted.
//
// WHY THESE LIVE TOGETHER AND `reserve`/`commit`/`release` DO NOT. A
// reservation is split across a guard and an interceptor by necessity: the
// balance has to move before the handler runs and settle after it returns,
// so the two halves cannot share a function. These five are different —
// each is one decision applied at one moment, so the wallet statement and
// the ledger entry belong in the same call, and separating them would invite
// exactly the half-applied state the reservation path has to work so hard to
// avoid.

/** The one name for "already recorded under this key" — every operation here returns it. */
export interface BalanceOutcome {
  /** false means this exact (workspace, type, key) was already recorded and NOTHING moved. */
  readonly applied: boolean;
  /** The wallet after the movement. Null on a redelivery, which moved nothing. */
  readonly wallet: WalletState | null;
}

interface BalanceRequest {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly actorId: string | null;
  readonly actorType: "user" | "api_key" | "system";
  readonly referenceType?: string;
  readonly referenceId?: string;
}

const SAVEPOINT = "credit_balance_entry";

/**
 * Undo everything since the savepoint and let it go.
 *
 * ⚠ ALSO ON THE ERROR PATH, WHICH IT WAS NOT. The first version rolled back
 * only when a redelivery was detected, so a constraint violation —
 * `ck_wallet_reserved` on an expiry, `credit_ledger_actor_id_fkey` on an
 * adjustment naming someone who does not exist — propagated with the
 * savepoint still open and the caller's transaction ABORTED. The
 * second-engineer review reproduced it: after a refused `expireCredits`, the
 * caller's next statement failed with "current transaction is aborted", and
 * recovery was possible only for a caller who knew this savepoint's private
 * name. Every test missed it because they all wrap the call in a helper that
 * rolls the whole transaction back anyway.
 *
 * Postgres permits `ROLLBACK TO SAVEPOINT` from an aborted transaction —
 * that is what savepoints are for — so this recovers rather than compounding.
 */
async function undoSavepoint(tx: ClientBase): Promise<void> {
  await tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
  await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
}

async function openSavepoint(tx: ClientBase): Promise<void> {
  try {
    await tx.query(`SAVEPOINT ${SAVEPOINT}`);
  } catch (error) {
    throw new Error(
      "a credit balance entry must be written inside a transaction: the wallet statement and the ledger " +
        "entry have to commit together, or a balance moves with nothing accounting for it",
      { cause: error },
    );
  }
}

/**
 * Move a balance and record why, or discover it was already done.
 *
 * ⚠ THE SAVEPOINT IS WHAT MAKES THIS IDEMPOTENT WITHOUT A PRIOR READ. The
 * wallet statement runs first (replay's ordering invariant: the ledger row's
 * `seq` must be drawn with the wallet row lock already held — see migration
 * 0023), and only then does the unique index get consulted. A redelivery
 * therefore moves the balance and then finds its entry already present, so
 * the movement has to be undone — and undoing it by rolling back the
 * caller's whole transaction would take unrelated work down with it.
 *
 * Checking the ledger first instead would be a read-then-write with a window
 * in it, which is the exact shape `reserveCredits` exists to avoid.
 *
 * ⚠ THE CALLER MUST ALREADY BE IN A TRANSACTION, and that is a correctness
 * requirement rather than an inconvenience: the wallet statement and the
 * ledger entry have to commit together, or a crash between them leaves a
 * balance that moved with nothing accounting for it — the exact state
 * `verifyWorkspaceWallet` pages a human about. Every production caller is
 * inside `withTenantContext`; `openSavepoint` turns Postgres's own terse
 * "SAVEPOINT can only be used in transaction blocks" into a message that
 * says which rule was broken.
 */
async function applyBalanceEntry(
  tx: ClientBase,
  workspaceId: string,
  movement: { readonly bucket: CreditBucket; readonly delta: number; readonly lifetime: LifetimeCounter },
  buildEntry: (after: WalletState) => LedgerEntry,
): Promise<BalanceOutcome> {
  await openSavepoint(tx);

  try {
    const wallet = await applyBucketDelta(tx, workspaceId, movement.bucket, movement.delta, movement.lifetime);
    if (wallet === null) {
      // ⚠ NOT A SILENT NO-OP. A workspace with no wallet row is a sequencing
      // bug — `provisionWalletWithGrant` runs on the request path before
      // anything else touches credits — and returning `applied: false` would
      // make it indistinguishable from a redelivery, which is the ordinary,
      // expected outcome. The difference matters: a redelivery leaves the
      // correct state behind, and this leaves nothing at all, with no ledger
      // row for the verifier to notice the absence of.
      throw new Error(`workspace ${workspaceId} has no credit wallet: nothing can be granted to or taken from it`);
    }

    if (!(await appendLedgerEntry(tx, buildEntry(wallet)))) {
      await undoSavepoint(tx);
      return { applied: false, wallet: null };
    }

    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return { applied: true, wallet };
  } catch (error) {
    await undoSavepoint(tx);
    throw error;
  }
}

/** The fields every entry here copies off its request, spread into the built entry. */
function attribution(request: BalanceRequest): {
  readonly idempotencyKey: string;
  readonly referenceType?: string;
  readonly referenceId?: string;
} {
  return {
    idempotencyKey: request.idempotencyKey,
    ...(request.referenceType === undefined ? {} : { referenceType: request.referenceType }),
    ...(request.referenceId === undefined ? {} : { referenceId: request.referenceId }),
  };
}

/** One of the four unsigned balance types, written from a completed movement. */
function balanceEntry(
  request: BalanceRequest,
  entryType: LedgerBalanceType,
  bucket: CreditBucket,
  amount: number,
): (after: WalletState) => LedgerEntry {
  return (after) => ({
    workspaceId: request.workspaceId,
    entryType,
    bucket,
    credits: amount,
    after,
    actorId: request.actorId,
    actorType: request.actorType,
    ...attribution(request),
  });
}

/** Plan credits landing in the expiring bucket at the start of a cycle. */
export async function grantCredits(
  tx: ClientBase,
  request: BalanceRequest,
  amount: number,
): Promise<BalanceOutcome> {
  assertPositive(amount, "grant");
  return applyBalanceEntry(
    tx,
    request.workspaceId,
    { bucket: "included", delta: amount, lifetime: "granted" },
    balanceEntry(request, "grant", "included", amount),
  );
}

/** A credit pack landing in the durable bucket. STORY-076 is its caller. */
export async function recordPurchase(
  tx: ClientBase,
  request: BalanceRequest,
  amount: number,
): Promise<BalanceOutcome> {
  assertPositive(amount, "purchase");
  return applyBalanceEntry(
    tx,
    request.workspaceId,
    { bucket: "purchased", delta: amount, lifetime: "purchased" },
    balanceEntry(request, "purchase", "purchased", amount),
  );
}

/**
 * Credits reaching the end of their life.
 *
 * AC12 — "a balance change is always explicable". Included credits lapse at
 * `cycle_end` and purchased ones twelve months after purchase
 * (`plans-and-entitlements.md` §4), and both were previously going to happen
 * as a bare balance write with nothing in the ledger to point at.
 *
 * ⚠ NOTHING CALLS THIS IN PRODUCTION YET, and the reason is worth stating
 * rather than leaving to be discovered: included expiry is the cycle-end
 * grant refresh, which is STORY-075's (it was deliberately removed from
 * `wallet.ts` for minting credits on a retry), and purchased expiry is FIFO
 * over `credit_purchases` lots, which STORY-076 is the first story to
 * create. The operation lands here with them so neither has to invent the
 * ledger half under deadline.
 */
export async function expireCredits(
  tx: ClientBase,
  request: BalanceRequest,
  bucket: CreditBucket,
  amount: number,
): Promise<BalanceOutcome> {
  assertPositive(amount, "expire");
  return applyBalanceEntry(
    tx,
    request.workspaceId,
    { bucket, delta: -amount, lifetime: null },
    balanceEntry(request, "expire", bucket, amount),
  );
}

/** Credits returned to a workspace — a refunded purchase, a reversed charge. */
export async function refundCredits(
  tx: ClientBase,
  request: BalanceRequest,
  bucket: CreditBucket,
  amount: number,
): Promise<BalanceOutcome> {
  assertPositive(amount, "refund");
  return applyBalanceEntry(
    tx,
    request.workspaceId,
    { bucket, delta: amount, lifetime: null },
    balanceEntry(request, "refund", bucket, amount),
  );
}

/** What an adjustment needs that no other entry does: a person, and their reason. */
export interface AdjustmentRequest extends BalanceRequest {
  readonly actorId: string;
  readonly actorType: "user" | "api_key";
  readonly reason: string;
}

/**
 * ⚠ THE ONLY WAY A BALANCE IS EVER CORRECTED, AND IT NEEDS A HUMAN.
 *
 * §6 rule 4: "an unreconcilable discrepancy is resolved by a human-authored
 * `adjustment` entry with a reason. The system never silently rewrites a
 * balance." Three separate things hold that up, because one of them is a
 * convention and conventions decay:
 *
 *   1. `AdjustmentRequest` requires a non-system actor and a reason, so an
 *      automated caller cannot construct the argument without naming a
 *      person to stand behind it.
 *   2. `ck_credit_ledger_adjustment_reason` refuses a blank reason at the
 *      database, which is the last caller.
 *   3. `credit-verify.ts` — the job that would most naturally "fix" a
 *      mismatch — cannot reach this function at all. It has no import of it
 *      and `test/unit/credits/verify.spec.ts` asserts the absence, because
 *      the tempting one-line self-heal is exactly what rule 4 forbids.
 *
 * `delta` is SIGNED: negative takes credits away.
 */
export async function adjustCredits(
  tx: ClientBase,
  request: AdjustmentRequest,
  bucket: CreditBucket,
  delta: number,
): Promise<BalanceOutcome> {
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error(`adjustment must be a non-zero integer, received ${String(delta)}`);
  }
  if (request.reason.trim() === "") {
    // Refused here as well as by the CHECK so the message names the rule
    // rather than the constraint. A caller who gets this has not hit an
    // implementation detail; they have been told the system does not make
    // unexplained corrections.
    throw new Error("an adjustment must carry a reason: the system never silently rewrites a balance");
  }
  return applyBalanceEntry(tx, request.workspaceId, { bucket, delta, lifetime: null }, (after) => ({
    workspaceId: request.workspaceId,
    entryType: "adjustment",
    bucket,
    // The one type that carries its direction in the sign.
    credits: delta,
    after,
    actorId: request.actorId,
    actorType: request.actorType,
    reason: request.reason,
    ...attribution(request),
  }));
}

function assertPositive(value: number, what: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${what} must be a positive integer, received ${String(value)}`);
  }
}


/**
 * Create a workspace's wallet AND account for the grant that came with it.
 *
 * ⚠ `provisionWallet` MINTED CREDITS WITH NO LEDGER ROW, and replay is what
 * made it visible. It inserts `included_balance = grant` and STORY-072 wrote
 * nothing to `credit_ledger` for it, so the very first workspace to touch a
 * priced route had a wallet holding credits the ledger could not account
 * for — `verifyWorkspaceWallet` reports that as a mismatch on entry zero,
 * and it would have paged a human on every new workspace.
 *
 * The entry is written only when THIS call created the row. A second
 * delivery hits `ON CONFLICT DO NOTHING`, gets `created: false`, and writes
 * nothing — writing the entry on the conflict path would record a grant that
 * never happened, which is the same error in the other direction.
 *
 * The balance is already applied by the INSERT, so there is no delta to
 * apply here: this appends the accounting for a movement that has happened,
 * which is why it does not go through `applyBalanceEntry`.
 *
 * A grant of zero writes nothing. Nothing moved, and
 * `ck_credit_ledger_credits_sign` is right to refuse a zero-magnitude grant.
 */
export async function provisionWalletWithGrant(
  tx: ClientBase,
  workspaceId: string,
  grant: number,
  cycle: { readonly start: string; readonly end: string },
): Promise<BalanceOutcome> {
  // Same transaction requirement, and the same savepoint, as every other
  // entry here: the INSERT and its accounting commit together or neither
  // does. It also means a refused entry rolls the wallet row back rather
  // than aborting the request's whole transaction.
  await openSavepoint(tx);

  try {
    const { created } = await provisionWallet(tx, workspaceId, grant, cycle);
    if (created === null || grant === 0) {
      await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return { applied: false, wallet: created };
    }

    const appended = await appendLedgerEntry(tx, {
      workspaceId,
      entryType: "grant",
      bucket: "included",
      credits: grant,
      // Keyed on the cycle, so the grant for one billing period can only ever
      // be recorded once no matter how many deliveries race to provision.
      idempotencyKey: `grant:provision:${cycle.start}`,
      after: created,
      actorId: null,
      actorType: "system",
    });

    if (!appended) {
      // A grant entry for this cycle already exists while the wallet row did
      // not — the two cascade together, so it should be unreachable. Refused
      // rather than returned, because this file's whole purpose is making
      // "a wallet holding credits the ledger cannot account for"
      // unrepresentable, and silently succeeding here would create one.
      throw new Error(
        `workspace ${workspaceId} was provisioned but its cycle grant was already recorded: ` +
          "the wallet and its ledger disagree about whether this cycle has been granted",
      );
    }

    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return { applied: true, wallet: created };
  } catch (error) {
    await undoSavepoint(tx);
    throw error;
  }
}
