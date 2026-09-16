import type { ClientBase } from "pg";
import { refundCredits } from "./balance.js";
import type { CreditBucket } from "./wallet.js";

// STORY-074 AC8 — the undo window, against the system as it is actually
// built.
//
// ⚠ §7 SAYS "RELEASES THE RESERVATION" AND THERE IS NO RESERVATION LEFT.
// `CreditInterceptor` commits the moment the handler returns, and the
// trigger returns 202 with its cells already dispatched at interactive
// priority. By the time a toast is on screen the credits are SPENT, and the
// "before the job starts" window is milliseconds rather than five seconds.
// §7's wording predates the settlement design STORY-072 landed.
//
// So undo refunds. That delivers §7's actual promise — a brief window to back
// out and not be charged — and it leaves the ledger explaining the money in
// both directions, which is the property this epic has been built around. A
// release would have left no trace that anything was ever charged.

/** How long after the debit an undo is still offered. §7: "a 5-second undo". */
export const UNDO_WINDOW_MS = 5_000;

export interface RefundableDebit {
  readonly credits: number;
  readonly bucket: CreditBucket;
  readonly idempotencyKey: string;
  readonly ageMs: number;
  readonly alreadyRefunded: boolean;
}

/**
 * The debit this run was charged, if there is one.
 *
 * ⚠ FOUND BY `reference_id`, WHICH ONLY EXISTS BECAUSE OF STORY-073B. Before
 * that, a commit entry recorded no project and no reference, so there was no
 * way to ask "what did this run cost?" — the ledger could say credits were
 * spent and not what for. This is the first caller to need the answer.
 *
 * ⚠ AND THE BUCKET IS DERIVED, NOT RECORDED. `commit` entries carry no
 * bucket: `commitCredits` draws from the expiring bucket first and the split
 * is an outcome, not a choice, so `ck_credit_ledger_bucket_scope` forbids
 * one. A refund therefore has to decide where the credits go back, and
 * `purchased` is the customer-favouring answer: included credits lapse at
 * cycle end, so returning them there could hand back something worth nothing
 * by Friday. Returning them as purchased is never worse for the customer and
 * is sometimes better.
 */
export async function refundableDebitFor(
  tx: ClientBase,
  workspaceId: string,
  runId: string,
): Promise<RefundableDebit | null> {
  const result = await tx.query<{
    credits: string;
    idempotency_key: string;
    age_ms: string;
    refunded: string;
  }>(
    `SELECT c.credits::text,
            c.idempotency_key,
            (EXTRACT(EPOCH FROM (now() - c.occurred_at)) * 1000)::bigint::text AS age_ms,
            (SELECT count(*) FROM credit_ledger r
              WHERE r.workspace_id = c.workspace_id
                AND r.entry_type = 'refund'
                AND r.reference_type = 'run'
                AND r.reference_id = c.reference_id)::text AS refunded
       FROM credit_ledger c
      WHERE c.workspace_id = $1
        AND c.entry_type = 'commit'
        AND c.reference_type = 'run'
        AND c.reference_id = $2
      ORDER BY c.seq DESC
      LIMIT 1`,
    [workspaceId, runId],
  );

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    credits: Number(row.credits),
    bucket: "purchased",
    idempotencyKey: row.idempotency_key,
    ageMs: Number(row.age_ms),
    alreadyRefunded: Number(row.refunded) > 0,
  };
}

export type UndoRefusal =
  /** Work has already been done. §7: "undo after job start is disabled with an explanation." */
  | "work_started"
  /** The five seconds are up. */
  | "window_closed";

export interface UndoOutcome {
  readonly refunded: number;
  /** null when the undo went through. */
  readonly refusal: UndoRefusal | null;
}

export interface UndoInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly actorId: string | null;
  readonly actorType: "user" | "api_key" | "system";
  /** Cells that have produced a result, successfully or not. */
  readonly settledCells: number;
  readonly windowMs?: number;
}

/**
 * Give back what a run was charged, if it is still allowed.
 *
 * ⚠ TWO CONDITIONS, AND THEY ARE NOT THE SAME CONDITION. "No work has
 * started" is the substantive one — a customer who has had nothing delivered
 * should not have paid. The time bound is the policy one, and without it undo
 * would be an open-ended refund on any run whose queue happened to be backed
 * up, which is a billing decision nobody made. Both are checked, and the
 * refusal says which applied so the interface can explain it.
 *
 * ⚠ IDEMPOTENT BY THE LEDGER, like everything else here. The refund carries
 * THE DEBIT'S OWN `Idempotency-Key`, so `ux_credit_ledger_idem` refuses a
 * second one and the wallet movement rolls back with it — two undo clicks
 * hand back one refund. A freshly generated key would defeat that entirely,
 * so the entry's key is asserted directly rather than only through the
 * double-click outcome.
 *
 * Returns `refunded: 0` with no refusal when the run was never charged: a
 * scheduled run is inside the subscription envelope and there is nothing to
 * give back, which is not an error.
 */
export async function undoRunCharge(tx: ClientBase, input: UndoInput): Promise<UndoOutcome> {
  if (input.settledCells > 0) return { refunded: 0, refusal: "work_started" };

  const debit = await refundableDebitFor(tx, input.workspaceId, input.runId);
  if (debit === null || debit.credits === 0) return { refunded: 0, refusal: null };

  // An early out, NOT the guarantee. The guarantee is the idempotency key
  // below: `ux_credit_ledger_idem` refuses a second refund under it and the
  // wallet movement rolls back with the entry. This check only saves a
  // wallet UPDATE and a savepoint rollback on the common second click — the
  // outcome is identical without it, which a mutation test confirms. Said
  // plainly here so nobody mistakes it for the thing holding the line.
  if (debit.alreadyRefunded) return { refunded: 0, refusal: null };
  if (debit.ageMs > (input.windowMs ?? UNDO_WINDOW_MS)) return { refunded: 0, refusal: "window_closed" };

  const outcome = await refundCredits(
    tx,
    {
      workspaceId: input.workspaceId,
      // The debit's own key, so a second undo is refused by the index.
      idempotencyKey: debit.idempotencyKey,
      actorId: input.actorId,
      actorType: input.actorType,
      referenceType: "run",
      referenceId: input.runId,
    },
    debit.bucket,
    debit.credits,
  );

  return { refunded: outcome.applied ? debit.credits : 0, refusal: null };
}
