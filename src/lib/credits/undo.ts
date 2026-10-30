import type { ClientBase } from "pg";
import { refundCredits } from "./balance.js";
import { confirmationFor } from "./confirmation.js";

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
  /** What the commit drew from each bucket. Sums to `credits`. */
  readonly fromIncluded: number;
  readonly fromPurchased: number;
  /**
   * What the wallet could draw on immediately BEFORE this debit.
   *
   * ⚠ RECOVERED FROM THE LEDGER, NOT READ FROM THE WALLET. §7's thresholds
   * were evaluated against the balance at quote time, and the wallet has
   * moved since. The preceding entry records that balance exactly, which is
   * the same trick the bucket split uses.
   */
  readonly availableBefore: number;
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
 * ⚠ AND THE SPLIT IS RECOVERED FROM THE `*_after` COLUMNS, NOT CHOSEN.
 * `commit` entries carry no bucket — `commitCredits` draws from the expiring
 * one first and the split is an outcome rather than a choice, so
 * `ck_credit_ledger_bucket_scope` forbids recording one — which left the
 * refund having to decide where credits go back.
 *
 * The first version sent everything to `purchased`, reasoning that included
 * credits lapse at cycle end so returning them there could hand back
 * something worthless by Friday. The second-engineer review showed what that
 * actually buys: `commitCredits` ALWAYS draws included-first, so every
 * trigger-and-undo cycle moves the flat price out of the expiring bucket
 * into the durable one. Five cycles took a wallet from 1,000 included / 0
 * purchased to 0 / 1,000 — same available balance, expiry destroyed — and
 * the nightly verifier reported clean throughout, because the ledger was
 * internally consistent the whole way. Worse, a refund writes no
 * `credit_purchases` lot, so STORY-076's FIFO twelve-month expiry would have
 * nothing to expire those against: they would never lapse at all.
 *
 * "Never worse for the customer" is exactly what made it exploitable. The
 * split is EXACT and recoverable: this row records the balances after the
 * commit, and the workspace's previous row records them before, so
 * `from_included = previous.included_after - this.included_after`. Put back
 * what was taken, from where it was taken.
 */
export async function refundableDebitFor(
  tx: ClientBase,
  workspaceId: string,
  runId: string,
  // STORY-078: a tool run's debit is referenced as 'tool_run'; a capture run's stays 'run'.
  referenceType: string = "run",
): Promise<RefundableDebit | null> {
  const result = await tx.query<{
    credits: string;
    from_included: string;
    from_purchased: string;
    available_before: string;
    idempotency_key: string;
    age_ms: string;
    refunded: string;
  }>(
    `WITH debit AS (
       SELECT c.seq, c.credits, c.idempotency_key, c.occurred_at,
              c.included_after, c.purchased_after, c.reference_id, c.workspace_id
         FROM credit_ledger c
        WHERE c.workspace_id = $1
          AND c.entry_type = 'commit'
          AND c.reference_type = $3
          AND c.reference_id = $2
        ORDER BY c.seq DESC
        LIMIT 1
     ),
     -- The workspace's state immediately before that commit. seq is the only
     -- sound ordering here; occurred_at is transaction-start time and
     -- misorders concurrent movements (migration 0023).
     prior AS (
       SELECT p.included_after, p.purchased_after, p.reserved_after
         FROM credit_ledger p, debit d
        WHERE p.workspace_id = d.workspace_id
          AND p.seq < d.seq
        ORDER BY p.seq DESC
        LIMIT 1
     )
     SELECT d.credits::text,
            -- No prior row means this commit is the workspace's first ledger
            -- entry, which provisionWalletWithGrant makes unreachable: it
            -- writes a grant before anything can be spent. Falling back to
            -- "all of it came from included" matches commitCredits' own
            -- expiring-first rule rather than inventing a split.
            GREATEST(0, COALESCE((SELECT included_after FROM prior), d.included_after + d.credits)
                        - d.included_after)::text AS from_included,
            GREATEST(0, COALESCE((SELECT purchased_after FROM prior), d.purchased_after)
                        - d.purchased_after)::text AS from_purchased,
            -- Available = included + purchased - reserved, as of the entry
            -- before this debit. The reserve for this very action is already
            -- in that row, so adding the debit back gives the figure the
            -- quote was measured against.
            (COALESCE((SELECT included_after FROM prior), d.included_after + d.credits)
             + COALESCE((SELECT purchased_after FROM prior), d.purchased_after)
             - COALESCE((SELECT reserved_after FROM prior), 0)
             + d.credits)::text AS available_before,
            d.idempotency_key,
            (EXTRACT(EPOCH FROM (now() - d.occurred_at)) * 1000)::bigint::text AS age_ms,
            (SELECT count(*) FROM credit_ledger r
              WHERE r.workspace_id = d.workspace_id
                AND r.entry_type = 'refund'
                AND r.reference_type = $3
                AND r.reference_id = d.reference_id)::text AS refunded
       FROM debit d`,
    [workspaceId, runId, referenceType],
  );

  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    credits: Number(row.credits),
    fromIncluded: Number(row.from_included),
    fromPurchased: Number(row.from_purchased),
    availableBefore: Number(row.available_before),
    idempotencyKey: row.idempotency_key,
    ageMs: Number(row.age_ms),
    alreadyRefunded: Number(row.refunded) > 0,
  };
}

export type UndoRefusal =
  /** Work has already been delivered. §7: "undo after job start is disabled with an explanation." */
  | "work_started"
  /** The five seconds are up. */
  | "window_closed"
  /**
   * The action went through the cost modal, so it has no undo.
   *
   * ⚠ §7 GIVES THE UNDO TO SUB-THRESHOLD ACTIONS ONLY: "BELOW ALL THRESHOLDS
   * the action executes with a toast showing the debit and a 5-second undo."
   * An action above a threshold takes the other path — a mandatory modal
   * showing the exact figure, echoed back in `X-Nominara-Confirmed-Credits`
   * — and something a customer explicitly approved at a stated price does not
   * also need taking back.
   *
   * The first version of this file attached the undo to deep scans. Every
   * seeded `deep_scan.credits` is 100 or more against a threshold of 25, so
   * every deep scan is confirmed through the modal and none of them was ever
   * §7's to undo. Recorded rather than quietly dropped, because the endpoint
   * exists and a caller deserves to be told why the answer is no.
   */
  | "action_was_confirmed";

export interface UndoOutcome {
  readonly refunded: number;
  /** null when the undo went through. */
  readonly refusal: UndoRefusal | null;
}

export interface UndoInput {
  /**
   * Stop the work, called ONLY after every check has passed and BEFORE any
   * credit moves.
   *
   * ⚠ THE ORDERING LIVES HERE RATHER THAN AT THE CALL SITE, because getting
   * it wrong in either direction is a defect and only this function knows
   * both reasons. Refund-then-stop hands credits back for work that goes on
   * to happen. Stop-then-check stops a run whose undo is then REFUSED — the
   * customer asked to take it back, was told no, and lost the scan anyway.
   *
   * Throwing from here aborts the undo with nothing moved, which is what a
   * run that turned out to be unstoppable should produce.
   */
  readonly stopWork: () => Promise<void>;
  readonly workspaceId: string;
  readonly runId: string;
  /**
   * `projects.max` for the plan, as `confirmationFor` wants it.
   *
   * The only threshold input that is not recoverable from the ledger — the
   * debit's amount and the balance before it both are.
   */
  readonly maxProjects: number | null | "unreadable";
  readonly actorId: string | null;
  readonly actorType: "user" | "api_key" | "system";
  /**
   * Cells this run has DELIVERED — captured, failed, or served from cache.
   *
   * ⚠ CACHE-SERVED CELLS COUNT. The first version used `captured + failed`
   * and excluded them, which `run-progress.ts` states plainly is wrong in its
   * own comment: "A SUPPRESSED CELL IS DONE." The second-engineer review
   * reproduced the consequence — re-trigger a scan, every cell is now an L1
   * hit, all six answers are readable at `pct: 100`, and the undo handed back
   * every credit. Deep scans carry no daily cap, so the loop was free and
   * unbounded. A cell whose answer the customer can read is work delivered,
   * whoever delivered it.
   */
  readonly deliveredCells: number;
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
  const debit = await refundableDebitFor(tx, input.workspaceId, input.runId);
  if (debit === null || debit.credits === 0) return { refunded: 0, refusal: null };

  // ⚠ CHECKED FIRST, AND RE-DERIVED RATHER THAN TRUSTED. An action that went
  // through the cost modal never had an undo, so whether work has started or
  // the window is up are both beside the point — answering either would tell
  // a customer they were too slow for something they were never offered.
  //
  // The verdict is recomputed from the LEDGER: the debit's own amount and the
  // balance recorded on the entry before it, which is what §7's thresholds
  // were measured against at quote time. Taking a boolean from the caller
  // would put the decision in whichever handler happened to call this.
  const confirmed = confirmationFor({
    credits: debit.credits,
    available: debit.availableBefore,
    // One project per run. §7's cross-project rule exists for the tools.
    projectCount: 1,
    maxProjects: input.maxProjects,
  });
  if (confirmed.required) return { refunded: 0, refusal: "action_was_confirmed" };

  if (input.deliveredCells > 0) return { refunded: 0, refusal: "work_started" };

  // An early out, NOT the guarantee. The guarantee is the idempotency key
  // below: `ux_credit_ledger_idem` refuses a second refund under it and the
  // wallet movement rolls back with the entry. This check only saves a
  // wallet UPDATE and a savepoint rollback on the common second click — the
  // outcome is identical without it, which a mutation test confirms. Said
  // plainly here so nobody mistakes it for the thing holding the line.
  if (debit.alreadyRefunded) return { refunded: 0, refusal: null };
  if (debit.ageMs > (input.windowMs ?? UNDO_WINDOW_MS)) return { refunded: 0, refusal: "window_closed" };

  // Every check has passed. Stop the work before any credit moves.
  await input.stopWork();

  // ⚠ PUT BACK WHAT WAS TAKEN, FROM WHERE IT WAS TAKEN. Two entries when the
  // commit spanned both buckets, because one entry cannot describe two
  // movements and `ck_credit_ledger_bucket_scope` makes a bucketless refund
  // unrepresentable. Keyed apart by bucket for the same reason the index
  // exists: a second undo must collide with the first, per bucket.
  let refunded = 0;
  for (const [bucket, amount] of [
    ["included", debit.fromIncluded],
    ["purchased", debit.fromPurchased],
  ] as const) {
    if (amount === 0) continue;
    const outcome = await refundCredits(
      tx,
      {
        workspaceId: input.workspaceId,
        // The debit's own key, so a second undo is refused by the index.
        idempotencyKey: `${debit.idempotencyKey}:${bucket}`,
        actorId: input.actorId,
        actorType: input.actorType,
        referenceType: "run",
        referenceId: input.runId,
      },
      bucket,
      amount,
    );
    if (outcome.applied) refunded += amount;
  }

  return { refunded, refusal: null };
}
