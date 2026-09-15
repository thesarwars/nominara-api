import type { ClientBase } from "pg";
import type { WalletState } from "./wallet.js";

// STORY-072 — the append-only credit ledger.
//
// PULLED FORWARD FROM STORY-073 because the wallet cannot be correct without
// it. The second-engineer review found that a reservation made by the guard
// is leaked whenever anything short-circuits before the settling interceptor
// — a replay, an `in_flight` conflict, a missing `Idempotency-Key` — and
// reproduced a 600-credit wallet drained to zero in three retries of one
// action, with `lifetime_spent: 0`.
//
// `ux_credit_ledger_idem` — `UNIQUE (workspace_id, entry_type,
// idempotency_key)` — is exactly the dedupe that closes it: a redelivered
// request cannot open a second reservation, because the ledger refuses the
// second `reserve` entry and the wallet is only touched when that entry was
// actually inserted.
//
// APPEND-ONLY, enforced by a trigger on the table. Nothing here updates or
// deletes; a correction is a new `adjustment` entry with a reason, which is
// §6 rule 4's "the system never silently rewrites a balance".

export type LedgerEntryType = "reserve" | "commit" | "release";

/** `credit_ledger.action_code`'s own CHECK. `@Credits` actions map onto it. */
export type LedgerActionCode = "lookup" | "manual_scan" | "nlp_command" | "aux_manual" | "prompt_activate" | "other";

export interface LedgerEntry {
  readonly workspaceId: string;
  readonly entryType: LedgerEntryType;
  readonly actionCode: LedgerActionCode;
  readonly credits: number;
  readonly idempotencyKey: string;
  /** Which attempt under that key. 1 for everything that has no retries. */
  readonly attempt: number;
  /** The wallet as it stands AFTER this entry — §6 rule 4's reconciliation reads these. */
  readonly after: WalletState;
  readonly actorId: string | null;
  readonly actorType: "user" | "api_key" | "system";
  readonly referenceType?: string;
  readonly referenceId?: string;
}

/**
 * Append one entry, or report that it was already there.
 *
 * `ON CONFLICT DO NOTHING` over `ux_credit_ledger_idem`. `false` means this
 * exact (workspace, type, key) is already recorded — a redelivery — and the
 * caller must NOT repeat whatever wallet movement the entry describes.
 *
 * ⚠ THIS IS THE DEDUPE, not a log line. Calling the wallet statement and then
 * writing the entry would leave the window the review exploited; the entry
 * goes first and its success is the permission to move the balance.
 */
export async function appendLedgerEntry(tx: ClientBase, entry: LedgerEntry): Promise<boolean> {
  const result = await tx.query(
    `INSERT INTO credit_ledger
       (workspace_id, actor_id, actor_type, entry_type, action_code, credits,
        included_after, purchased_after, reserved_after, reference_type, reference_id,
        idempotency_key, attempt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (workspace_id, entry_type, idempotency_key, attempt) DO NOTHING`,
    [
      entry.workspaceId,
      entry.actorId,
      entry.actorType,
      entry.entryType,
      entry.actionCode,
      entry.credits,
      entry.after.includedBalance,
      entry.after.purchasedBalance,
      entry.after.reserved,
      entry.referenceType ?? null,
      entry.referenceId ?? null,
      entry.idempotencyKey,
      entry.attempt,
    ],
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Has this (workspace, type, key) already been recorded?
 *
 * Used to decide whether a settlement still has anything to do. A `commit`
 * or `release` entry that already exists means the reservation is closed, and
 * repeating the wallet statement would double-move the balance.
 */
export async function ledgerEntryExists(
  tx: ClientBase,
  workspaceId: string,
  entryType: LedgerEntryType,
  idempotencyKey: string,
  attempt: number,
): Promise<boolean> {
  const result = await tx.query(
    `SELECT 1 FROM credit_ledger
      WHERE workspace_id = $1 AND entry_type = $2 AND idempotency_key = $3 AND attempt = $4`,
    [workspaceId, entryType, idempotencyKey, attempt],
  );
  return (result.rowCount ?? 0) > 0;
}

// ─────────────────────── the key family ───────────────────────
//
// ⚠ AN `Idempotency-Key` IDENTIFIES A REQUEST, NOT A RESERVATION'S STATE, and
// the first version of this file conflated the two. The second-engineer
// review reproduced what that costs:
//
//   reserve under K → handler fails → release → client retries with K (which
//   `IdempotencyInterceptor` explicitly invites, releasing its claim on a
//   throw "so a client retrying after a transient fault is not refused") →
//   the reserve entry still exists, so the guard "re-attached" to a
//   reservation that had already been released → handler succeeded → the
//   commit matched no row → 500, nothing charged, and K poisoned forever.
//
// A ledger entry is append-only and therefore permanent; a reservation is
// not. So a key gets a FAMILY of reserve entries — `K`, then `K#2`, `K#3` —
// one per genuine attempt, and the question the guard asks is not "has this
// key reserved before" but "is one of this key's reservations still open".

// ⚠ THE ATTEMPT IS A COLUMN, NOT A SUFFIX ON THE KEY.
//
// The first version of this family wrote `K`, `K#2`, `K#3` into
// `idempotency_key`. `idempotencyKeySchema` permits any character, so a
// client key of `job#2` landed in the namespace the guard had reserved for
// its own retry of `job` — and the review reproduced both a spurious refusal
// of a second seat's own key and a retry committing against that seat's live
// reservation. Migration 0022 gives `credit_ledger` an `attempt` column and
// moves it into the unique index; a client cannot write a column.

export interface ReservationClaim {
  /** The attempt number still open, or null when none is. Re-attach to it. */
  readonly openAttempt: number | null;
  /** A settled attempt that COMMITTED. The action already happened and was paid for. */
  readonly committed: boolean;
  /** How many reserve entries this key already has, open or settled. */
  readonly attempts: number;
}

/**
 * What state this request key's reservations are in.
 *
 * `starts_with` rather than `LIKE`, because the key is client-supplied and
 * may contain `%` or `_` — a `LIKE` pattern built from it would match other
 * customers' keys in the same workspace.
 */
export async function inspectReservations(
  tx: ClientBase,
  workspaceId: string,
  idempotencyKey: string,
): Promise<ReservationClaim> {
  const result = await tx.query<{ attempt: number; settlement: string | null }>(
    `SELECT r.attempt,
            (SELECT s.entry_type FROM credit_ledger s
              WHERE s.workspace_id = r.workspace_id
                AND s.idempotency_key = r.idempotency_key
                AND s.attempt = r.attempt
                AND s.entry_type IN ('commit', 'release')
              LIMIT 1) AS settlement
       FROM credit_ledger r
      WHERE r.workspace_id = $1
        AND r.entry_type = 'reserve'
        AND r.idempotency_key = $2
      ORDER BY r.attempt ASC`,
    [workspaceId, idempotencyKey],
  );

  const open = result.rows.find((row) => row.settlement === null);
  return {
    openAttempt: open?.attempt ?? null,
    committed: result.rows.some((row) => row.settlement === "commit"),
    attempts: result.rows.length,
  };
}

/**
 * §6 rule 4's reconciliation input — reservations with no matching commit or
 * release.
 *
 * STORY-073 owns the reconciler itself; this is the query it needs and the
 * reason the settlement paths can honestly call an unsettled reservation
 * "bounded and recoverable". Before the ledger existed, that claim was not
 * true and should not have been written as though it were — the review said
 * so, and it was right.
 */
export interface OpenReservation {
  readonly workspaceId: string;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly credits: number;
  readonly occurredAt: Date;
}

export async function openReservations(tx: ClientBase, olderThan: Date): Promise<OpenReservation[]> {
  const result = await tx.query<{
    workspace_id: string;
    idempotency_key: string;
    attempt: number;
    credits: string;
    occurred_at: Date;
  }>(
    `SELECT r.workspace_id, r.idempotency_key, r.attempt, r.credits::text, r.occurred_at
       FROM credit_ledger r
      WHERE r.entry_type = 'reserve'
        AND r.occurred_at < $1
        AND NOT EXISTS (
          SELECT 1 FROM credit_ledger s
           WHERE s.workspace_id = r.workspace_id
             AND s.idempotency_key = r.idempotency_key
             AND s.attempt = r.attempt
             AND s.entry_type IN ('commit', 'release')
        )
      ORDER BY r.occurred_at ASC`,
    [olderThan],
  );
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    credits: Number(row.credits),
    occurredAt: row.occurred_at,
  }));
}
