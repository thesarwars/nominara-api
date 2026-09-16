import type { ClientBase } from "pg";
import { ledgerUnitDetailSchema, type LedgerUnitDetail } from "../../../contracts/billing/ledger-unit-detail.schema.js";
import type { CreditBucket, WalletState } from "./wallet.js";

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

/**
 * The three types that move `reserved`, and the five that move a balance.
 *
 * Split rather than one flat union because they carry different obligations
 * and the compiler should say so: a movement has an `attempt` and an action
 * it is charging for; a balance entry has to name the bucket it moved; an
 * adjustment has to carry a reason. `LedgerEntry` below is the discriminated
 * union of the three, so "an adjustment without a reason" is a type error
 * before it is a constraint violation.
 */
export type LedgerMovementType = "reserve" | "commit" | "release";
export type LedgerBalanceType = "grant" | "purchase" | "expire" | "refund";
export type LedgerEntryType = LedgerMovementType | LedgerBalanceType | "adjustment";

/** `credit_ledger.bucket` and `credit_wallets`' two balance columns are the same two names, so the type is declared once, in `wallet.ts`. */
export type { CreditBucket };

/** `credit_ledger.action_code`'s own CHECK. `@Credits` actions map onto it. */
export type LedgerActionCode = "lookup" | "manual_scan" | "nlp_command" | "aux_manual" | "prompt_activate" | "other";

interface LedgerEntryCommon {
  readonly workspaceId: string;
  /**
   * A POSITIVE MAGNITUDE for every type but `adjustment`, whose direction is
   * carried by the sign — `ck_credit_ledger_credits_sign` in migration 0023.
   * A `commit` may be 0: a priced action that consumed nothing still settles
   * through the commit path.
   */
  readonly credits: number;
  readonly idempotencyKey: string;
  /** The wallet as it stands AFTER this entry — §6 rule 4's reconciliation reads these. */
  readonly after: WalletState;
  readonly actorId: string | null;
  readonly actorType: "user" | "api_key" | "system";
  readonly referenceType?: string;
  readonly referenceId?: string;
  /**
   * The project this entry is about, where there is one.
   *
   * ⚠ NOT EVERY ENTRY HAS ONE, and that is why it is optional rather than
   * nullable-required: a grant, a purchase and an expiry are workspace
   * facts, and forcing a project onto them would make `ix_credit_ledger_
   * project` describe a relationship that does not exist. A debit usually
   * does have one, and AC10 wants it.
   */
  readonly projectId?: string;
  /**
   * `{prompts, engines, cells_charged, cells_cached}` — what the debit paid
   * for, as work done.
   *
   * ⚠ PARSED THROUGH `ledgerUnitDetailSchema` BEFORE IT IS WRITTEN, not
   * merely typed. The value comes from a request handler and lands in an
   * append-only financial record, so `Record<string, number>` was not a
   * check at all — the second-engineer review wrote `{}` and a payload
   * carrying invented keys straight through `appendLedgerEntry` and back out
   * of the read endpoint, both violating the route's own published contract.
   * The schema's unit test asserts it "rejects an unknown member rather than
   * carrying it into a financial record"; nothing on the write path had ever
   * run it.
   */
  readonly unitDetail?: LedgerUnitDetail;
  /** What serving it cost us, in USD. A string so the numeric survives the round trip un-rounded. */
  readonly internalCostUsd?: string;
  /**
   * Set only when the entry inherits an already-erased actor from its
   * reserve row. Mutually exclusive with `actorId` —
   * `ck_credit_ledger_actor_exclusive`.
   */
  readonly actorPseudonym?: string | null;
}

export interface LedgerMovementEntry extends LedgerEntryCommon {
  readonly entryType: LedgerMovementType;
  readonly actionCode: LedgerActionCode;
  /** Which attempt under that key. 1 for everything that has no retries. */
  readonly attempt: number;
}

export interface LedgerBalanceEntry extends LedgerEntryCommon {
  readonly entryType: LedgerBalanceType;
  /**
   * Which balance moved. Required, because `included` and `purchased` have
   * different lifetimes and an entry that does not say cannot be replayed —
   * `ck_credit_ledger_bucket_scope`.
   */
  readonly bucket: CreditBucket;
}

export interface LedgerAdjustmentEntry extends LedgerEntryCommon {
  readonly entryType: "adjustment";
  readonly bucket: CreditBucket;
  /**
   * ⚠ WHY A HUMAN DECIDED THIS. §6 rule 4's whole point: a balance that
   * changed for a reason nobody wrote down is the failure, not the change.
   * Required here and by `ck_credit_ledger_adjustment_reason`.
   */
  readonly reason: string;
  /** An adjustment is authored, so it is never `system`. */
  readonly actorType: "user" | "api_key";
  readonly actorId: string;
}

export type LedgerEntry = LedgerMovementEntry | LedgerBalanceEntry | LedgerAdjustmentEntry;

/**
 * ⚠ THROWS RATHER THAN COERCING. A debit whose unit detail is malformed
 * should fail loudly at the point of writing, where the request can still be
 * refused, rather than be quietly stored as `null` — the ledger would then
 * carry a debit that claims no work was done, in the one table where a
 * missing explanation is the whole failure mode.
 */
function parseUnitDetail(detail: NonNullable<LedgerUnitDetail>): NonNullable<LedgerUnitDetail> {
  const parsed = ledgerUnitDetailSchema.safeParse(detail);
  if (!parsed.success || parsed.data === null) {
    throw new Error(
      `credit ledger unit_detail does not match its contract: ${parsed.success ? "null" : parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  return parsed.data;
}

/** Only a reservation retries; every other type is attempt 1 — `ck_credit_ledger_attempt_scope`. */
function attemptOf(entry: LedgerEntry): number {
  return entry.entryType === "reserve" || entry.entryType === "commit" || entry.entryType === "release"
    ? entry.attempt
    : 1;
}

function actionCodeOf(entry: LedgerEntry): LedgerActionCode | null {
  return "actionCode" in entry ? entry.actionCode : null;
}

function bucketOf(entry: LedgerEntry): CreditBucket | null {
  return "bucket" in entry ? entry.bucket : null;
}

function reasonOf(entry: LedgerEntry): string | null {
  return "reason" in entry ? entry.reason : null;
}

/**
 * Append one entry, or report that it was already there.
 *
 * `ON CONFLICT DO NOTHING` over `ux_credit_ledger_idem`. `false` means this
 * exact (workspace, type, key, attempt) is already recorded — a redelivery —
 * and the caller must NOT repeat whatever wallet movement the entry
 * describes.
 *
 * ⚠ THIS IS THE DEDUPE, not a log line. The entry and the wallet statement
 * share one transaction, so a movement without its ledger row is
 * unrepresentable; a conflict here rolls the movement back with it.
 *
 * ⚠ AND IT GOES AFTER THE WALLET STATEMENT, ALWAYS. `seq` is drawn here, and
 * replay's ordering is only sound because the row lock on `credit_wallets`
 * is already held when it is drawn — see migration 0023. Appending first and
 * moving the balance second would still be atomic and would silently break
 * every replay. `test/unit/credits/replay.spec.ts` states the invariant;
 * nothing but review enforces it at the call site.
 */
export async function appendLedgerEntry(tx: ClientBase, entry: LedgerEntry): Promise<boolean> {
  const result = await tx.query(
    `INSERT INTO credit_ledger
       (workspace_id, actor_id, actor_type, entry_type, action_code, credits, bucket,
        included_after, purchased_after, reserved_after, reference_type, reference_id,
        idempotency_key, attempt, reason, project_id, unit_detail, internal_cost_usd, actor_pseudonym)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
     ON CONFLICT (workspace_id, entry_type, idempotency_key, attempt) DO NOTHING`,
    [
      entry.workspaceId,
      entry.actorId,
      entry.actorType,
      entry.entryType,
      actionCodeOf(entry),
      entry.credits,
      bucketOf(entry),
      entry.after.includedBalance,
      entry.after.purchasedBalance,
      entry.after.reserved,
      entry.referenceType ?? null,
      entry.referenceId ?? null,
      entry.idempotencyKey,
      attemptOf(entry),
      reasonOf(entry),
      entry.projectId ?? null,
      entry.unitDetail === undefined || entry.unitDetail === null
        ? null
        : JSON.stringify(parseUnitDetail(entry.unitDetail)),
      entry.internalCostUsd ?? null,
      entry.actorPseudonym ?? null,
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

/**
 * How ONE attempt under a key was settled, or null if it is still open.
 *
 * Narrower than `inspectReservations`, which answers "does this key have an
 * open reservation anywhere in its family". Both settlement paths need the
 * per-attempt question, asked with the wallet row lock already held — see
 * `lockWallet`.
 */
export async function settlementOf(
  tx: ClientBase,
  workspaceId: string,
  idempotencyKey: string,
  attempt: number,
): Promise<"commit" | "release" | null> {
  const result = await tx.query<{ entry_type: "commit" | "release" }>(
    `SELECT entry_type FROM credit_ledger
      WHERE workspace_id = $1 AND idempotency_key = $2 AND attempt = $3
        AND entry_type IN ('commit', 'release')
      LIMIT 1`,
    [workspaceId, idempotencyKey, attempt],
  );
  return result.rows[0]?.entry_type ?? null;
}

/**
 * Who the RESERVE row says is spending — the authority the commit inherits.
 *
 * ⚠ THE COMMIT MUST NOT RE-RESOLVE THE ACTOR FROM THE REQUEST, for two
 * reasons the second-engineer review reproduced against a real database:
 *
 *   AN ERASURE CAN LAND BETWEEN THE RESERVE AND THE COMMIT. The guard
 *   captures the actor, the handler runs for as long as a manual scan takes,
 *   and `requestIndividualErasure` only touches rows that exist when it runs.
 *   So the reserve came out pseudonymised and the commit wrote the erased
 *   person's id back — in full, into an append-only table, minutes after
 *   they asked to be forgotten, and unrepairable without disabling the
 *   trigger. Nothing revokes an in-flight request on erasure.
 *
 *   AND A RE-ATTACHED RETRY CAN BE A DIFFERENT PERSON. `inspectReservations`
 *   is keyed on (workspace, key) and not on the user, so two members of one
 *   workspace replaying one Idempotency-Key produced a settlement whose two
 *   halves named two different people.
 *
 * Reading it back off the reserve makes both unrepresentable: the pair
 * always agrees, because there is only one source.
 */
export async function reservationActor(
  tx: ClientBase,
  workspaceId: string,
  idempotencyKey: string,
  attempt: number,
): Promise<{ actorId: string | null; actorType: "user" | "api_key" | "system"; actorPseudonym: string | null } | null> {
  const result = await tx.query<{
    actor_id: string | null;
    actor_type: "user" | "api_key" | "system";
    actor_pseudonym: string | null;
  }>(
    `SELECT actor_id, actor_type, actor_pseudonym FROM credit_ledger
      WHERE workspace_id = $1 AND entry_type = 'reserve' AND idempotency_key = $2 AND attempt = $3`,
    [workspaceId, idempotencyKey, attempt],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : { actorId: row.actor_id, actorType: row.actor_type, actorPseudonym: row.actor_pseudonym };
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
  /**
   * How many credits that open attempt actually holds.
   *
   * ⚠ RE-ATTACHING MUST USE THIS, NOT THE CURRENT PRICE. A redelivery
   * arriving after the price schedule moved would otherwise settle against a
   * figure the reservation never held: too high and the commit matches no
   * row (a 500 for work that was done), too low and the difference stays
   * reserved for the rest of the cycle with nothing to release it. The
   * second-engineer review flagged it; STORY-073's replay is what would
   * eventually page about it.
   */
  readonly openCredits: number | null;
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
  const result = await tx.query<{ attempt: number; credits: string; settlement: string | null }>(
    `SELECT r.attempt, r.credits::text,
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
    openCredits: open === undefined ? null : Number(open.credits),
    committed: result.rows.some((row) => row.settlement === "commit"),
    attempts: result.rows.length,
  };
}

/**
 * §6 rule 4's reconciliation input — reservations with no matching commit or
 * release.
 *
 * ⚠ CROSS-TENANT BY DESIGN, so it needs a privileged connection. There is
 * no `workspace_id` filter — an orphan scan that could only see one
 * workspace would need something to tell it which workspaces to look at,
 * and that list is the thing being scanned for. Same contract as
 * `retention.ts`'s own cross-tenant discovery functions; see that file's
 * PRIVILEGE CONTRACT comment.
 *
 * ⚠ THE GRACE WINDOW IS COMPUTED IN THE DATABASE, not handed in as a
 * timestamp the application worked out. `occurred_at` is written by the
 * database's clock, and comparing it against the app server's is a silent
 * dependency on two machines agreeing — which they do not, especially under
 * a VM. Skew in one direction under-releases, which is merely untidy; skew
 * in the other releases reservations YOUNGER than the grace period, which is
 * the reconciler racing a request that is still running. Found by the
 * integration suite finding zero orphans against a container whose clock ran
 * ahead of the host's.
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
  /** Carried through onto the release, so the entry that closes a hold names the action it was held for. */
  readonly actionCode: LedgerActionCode;
  readonly occurredAt: Date;
}

export async function openReservations(tx: ClientBase, graceSeconds: number): Promise<OpenReservation[]> {
  const result = await tx.query<{
    workspace_id: string;
    idempotency_key: string;
    attempt: number;
    credits: string;
    action_code: LedgerActionCode | null;
    occurred_at: Date;
  }>(
    `SELECT r.workspace_id, r.idempotency_key, r.attempt, r.credits::text, r.action_code, r.occurred_at
       FROM credit_ledger r
      WHERE r.entry_type = 'reserve'
        AND r.occurred_at < now() - make_interval(secs => $1)
        AND NOT EXISTS (
          SELECT 1 FROM credit_ledger s
           WHERE s.workspace_id = r.workspace_id
             AND s.idempotency_key = r.idempotency_key
             AND s.attempt = r.attempt
             AND s.entry_type IN ('commit', 'release')
        )
      ORDER BY r.occurred_at ASC`,
    [graceSeconds],
  );
  return result.rows.map((row) => ({
    workspaceId: row.workspace_id,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    credits: Number(row.credits),
    // `action_code` is nullable on the table because the balance types have
    // none; a `reserve` always has one, and `other` is the honest fallback
    // rather than a cast that pretends the column cannot be null.
    actionCode: row.action_code ?? "other",
    occurredAt: row.occurred_at,
  }));
}
