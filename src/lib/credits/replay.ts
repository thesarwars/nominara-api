import type { ClientBase } from "pg";
import type { CreditBucket, LedgerEntryType } from "./ledger.js";
import { readWallet, type WalletState } from "./wallet.js";

// STORY-073 — `NFR-CRD-03`: "Wallet balance is reconstructable by ledger
// replay. A nightly job asserts equality and pages on mismatch."
//
// ⚠ REPLAY IS A VERIFICATION, NOT A RECOMPUTATION, and the difference is the
// whole reason `credit_ledger` carries `included_after`/`purchased_after`/
// `reserved_after` on every row. Summing movements and comparing the total
// to the wallet tells you THAT the two disagree. Carrying a running balance
// and comparing it against each row's own recorded after-state tells you
// WHERE they started to — which entry, under which request key, at which
// moment. A discrepancy of 40 credits somewhere in a year of history is an
// investigation; one that begins at entry 8,412 is a bug report.
//
// So this walks forward and stops at the FIRST divergence.

export interface BalanceTriple {
  readonly included: number;
  readonly purchased: number;
  readonly reserved: number;
}

/** One `credit_ledger` row, in the shape replay needs and no wider. */
export interface ReplayRow {
  /** The replay order. See migration 0023 — `occurred_at` is NOT this order. */
  readonly seq: string;
  readonly entryType: LedgerEntryType;
  readonly credits: number;
  readonly bucket: CreditBucket | null;
  readonly idempotencyKey: string;
  readonly attempt: number;
  readonly after: BalanceTriple;
}

export interface ReplayDivergence {
  readonly seq: string;
  readonly entryType: LedgerEntryType;
  readonly idempotencyKey: string;
  readonly attempt: number;
  /** What the row itself claims the wallet looked like after it. */
  readonly recorded: BalanceTriple;
  /** What replaying every entry up to and including this one produces. */
  readonly replayed: BalanceTriple;
  readonly reason: string;
}

/**
 * The running totals on `credit_wallets` that only ever go up.
 *
 * ⚠ VERIFIED TOO, AND THE REASON IS A REAL DEFECT RATHER THAN COMPLETENESS.
 * STORY-072's second-engineer review drained a 600-credit wallet to zero
 * through three retries of one action and the wallet reported
 * `lifetime_spent: 0` — the balances were wrong AND the counter that would
 * have made it obvious in any report was wrong with them. A verifier that
 * checked only the three spendable balances would not have seen that half.
 *
 * They cannot be localised the way the balances can: `credit_ledger` carries
 * `*_after` columns for the balances and none for these, so a divergence
 * here is detectable and not attributable to an entry. Detectable is still
 * the difference between finding it tonight and finding it in a quarterly
 * reconciliation.
 */
export interface LifetimeCounters {
  readonly granted: number;
  readonly purchased: number;
  readonly spent: number;
}

export interface ReplayResult {
  /** The running balance after the last entry — or after the last entry BEFORE a divergence. */
  readonly balance: BalanceTriple;
  /** The lifetime totals the same entries add up to. */
  readonly lifetime: LifetimeCounters;
  readonly entries: number;
  /** The first entry whose recorded after-state disagrees with the replay. */
  readonly divergence: ReplayDivergence | null;
}

const ZERO: BalanceTriple = { included: 0, purchased: 0, reserved: 0 };
const NO_LIFETIME: LifetimeCounters = { granted: 0, purchased: 0, spent: 0 };

/**
 * Which lifetime total an entry counts towards, mirroring the `lifetime`
 * argument its wallet statement passes.
 *
 * ⚠ A REFUND COUNTS TOWARDS NOTHING, deliberately, because `refundCredits`
 * passes no lifetime counter. These are totals of what has ever happened,
 * not a net position — `lifetime_spent` does not go down when money comes
 * back, and a replay that netted it off would disagree with the wallet on
 * every refunded workspace.
 */
function lifetimeOf(entryType: LedgerEntryType, credits: number, running: LifetimeCounters): LifetimeCounters {
  switch (entryType) {
    case "grant":
      return { ...running, granted: running.granted + credits };
    case "purchase":
      return { ...running, purchased: running.purchased + credits };
    case "commit":
      return { ...running, spent: running.spent + credits };
    default:
      return running;
  }
}

function equal(a: BalanceTriple, b: BalanceTriple): boolean {
  return a.included === b.included && a.purchased === b.purchased && a.reserved === b.reserved;
}

type ApplyOutcome = { readonly next: BalanceTriple } | { readonly failure: string };

/**
 * Apply one entry to the running balance, mirroring the wallet statement
 * that wrote it.
 *
 * ⚠ THESE MUST STAY IN STEP WITH `wallet.ts`, EXACTLY — including the parts
 * that look like defensive noise. `release` clamps at zero because
 * `releaseCredits` does (`GREATEST(reserved - $2, 0)`), and a replay that
 * went negative where the wallet clamped would report a divergence on a
 * wallet that is perfectly correct. `commit` draws from the included bucket
 * first because `commitCredits` does, and getting that split wrong produces
 * the right total across two buckets that are individually both wrong —
 * worse than an obvious error, because the totals still reconcile.
 *
 * Returns a failure when the entry cannot be applied at all; the caller
 * turns that into a divergence naming why.
 */
function apply(
  balance: BalanceTriple,
  row: ReplayRow,
  reserveOf: (key: string, attempt: number) => number | undefined,
): ApplyOutcome {
  switch (row.entryType) {
    case "reserve":
      return { next: { ...balance, reserved: balance.reserved + row.credits } };

    case "commit": {
      // The reservation this commit settles — released in full by the same
      // statement, whatever the consumed amount turned out to be.
      const reserved = reserveOf(row.idempotencyKey, row.attempt);
      if (reserved === undefined) {
        return {
          failure: "a commit with no reserve entry under the same key and attempt: nothing authorised this charge",
        };
      }
      const fromIncluded = Math.min(balance.included, row.credits);
      return {
        next: {
          included: balance.included - fromIncluded,
          purchased: balance.purchased - (row.credits - fromIncluded),
          reserved: balance.reserved - reserved,
        },
      };
    }

    case "release":
      return { next: { ...balance, reserved: Math.max(balance.reserved - row.credits, 0) } };

    case "grant":
    case "purchase":
    case "refund":
    case "expire":
    case "adjustment": {
      if (row.bucket === null) {
        return { failure: `a ${row.entryType} entry with no bucket: which balance it moved is unrecorded` };
      }
      // `expire` is the one unsigned type that moves a balance DOWN; every
      // other unsigned type moves it up, and `adjustment` carries its own
      // sign. `ck_credit_ledger_credits_sign` is what lets this be a lookup
      // rather than a guess.
      const delta = row.entryType === "expire" ? -row.credits : row.credits;
      return {
        next:
          row.bucket === "included"
            ? { ...balance, included: balance.included + delta }
            : { ...balance, purchased: balance.purchased + delta },
      };
    }
  }
}

/**
 * Walk a workspace's ledger forward, checking every row's after-state as it
 * goes.
 *
 * Pure, and takes rows rather than a client, so the whole matrix of
 * interesting histories is a unit test rather than a fixture-loading
 * integration test.
 */
export function replayLedger(rows: readonly ReplayRow[]): ReplayResult {
  // Keyed key-then-attempt rather than by a joined string: a client-supplied
  // `idempotency_key` can contain any character at all, and a separator a
  // key can also contain is a collision waiting for the one customer whose
  // key has it.
  const reserves = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.entryType !== "reserve") continue;
    const byAttempt = reserves.get(row.idempotencyKey) ?? new Map<number, number>();
    byAttempt.set(row.attempt, row.credits);
    reserves.set(row.idempotencyKey, byAttempt);
  }
  const reserveOf = (key: string, attempt: number): number | undefined => reserves.get(key)?.get(attempt);

  let balance = ZERO;
  let lifetime = NO_LIFETIME;
  let applied = 0;

  for (const row of rows) {
    const outcome = apply(balance, row, reserveOf);
    const divergence =
      "failure" in outcome
        ? { replayed: balance, reason: outcome.failure }
        : equal(outcome.next, row.after)
          ? null
          : {
              replayed: outcome.next,
              reason: "the balance this entry records is not the balance replaying the ledger produces",
            };

    if (divergence !== null) {
      return {
        balance,
        lifetime,
        entries: applied,
        divergence: {
          seq: row.seq,
          entryType: row.entryType,
          idempotencyKey: row.idempotencyKey,
          attempt: row.attempt,
          recorded: row.after,
          replayed: divergence.replayed,
          reason: divergence.reason,
        },
      };
    }

    balance = (outcome as { readonly next: BalanceTriple }).next;
    lifetime = lifetimeOf(row.entryType, row.credits, lifetime);
    applied += 1;
  }

  return { balance, lifetime, entries: applied, divergence: null };
}

/**
 * ⚠ ORDERED BY `seq`, AND THE VERIFIER REFUSES TO RUN WITHOUT IT.
 *
 * Migration 0023's own comment has the reasoning: `occurred_at` is
 * transaction-start time, so two movements that raced for the wallet row
 * lock carry timestamps in the order their transactions BEGAN rather than
 * the order the balance moved. Replaying by `occurred_at` would page a human
 * for a race that cost nobody a credit, and a verifier that cries wolf is
 * worse than no verifier at all.
 */
/**
 * The wallet's lifetime totals. Read separately rather than widened onto
 * `WalletState`, which sits on the request's critical path and has no use
 * for them.
 */
export async function readLifetimeCounters(tx: ClientBase, workspaceId: string): Promise<LifetimeCounters | null> {
  const result = await tx.query<{ lifetime_granted: string; lifetime_purchased: string; lifetime_spent: string }>(
    `SELECT lifetime_granted::text, lifetime_purchased::text, lifetime_spent::text
       FROM credit_wallets WHERE workspace_id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        granted: Number(row.lifetime_granted),
        purchased: Number(row.lifetime_purchased),
        spent: Number(row.lifetime_spent),
      };
}

export async function readLedgerForReplay(tx: ClientBase, workspaceId: string): Promise<ReplayRow[]> {
  const result = await tx.query<{
    seq: string;
    entry_type: LedgerEntryType;
    credits: string;
    bucket: CreditBucket | null;
    idempotency_key: string;
    attempt: number;
    included_after: string;
    purchased_after: string;
    reserved_after: string;
  }>(
    `SELECT seq::text, entry_type, credits::text, bucket, idempotency_key, attempt,
            included_after::text, purchased_after::text, reserved_after::text
       FROM credit_ledger
      WHERE workspace_id = $1
      ORDER BY seq ASC`,
    [workspaceId],
  );

  return result.rows.map((row) => ({
    seq: row.seq,
    entryType: row.entry_type,
    credits: Number(row.credits),
    bucket: row.bucket,
    idempotencyKey: row.idempotency_key,
    attempt: row.attempt,
    after: {
      included: Number(row.included_after),
      purchased: Number(row.purchased_after),
      reserved: Number(row.reserved_after),
    },
  }));
}

export interface CounterMismatch {
  readonly counter: "granted" | "purchased" | "spent";
  readonly wallet: number;
  readonly replayed: number;
}

export interface WalletMismatch {
  readonly workspaceId: string;
  /** The entry the discrepancy localises to, or null when the ledger replays cleanly and the WALLET is the outlier. */
  readonly seq: string | null;
  readonly reason: string;
  readonly wallet: BalanceTriple;
  readonly replayed: BalanceTriple;
  /** Set only when the three balances agree and a lifetime total does not. */
  readonly counter: CounterMismatch | null;
}

function tripleOf(wallet: WalletState): BalanceTriple {
  return { included: wallet.includedBalance, purchased: wallet.purchasedBalance, reserved: wallet.reserved };
}

/**
 * Assert that one workspace's wallet is what its ledger says it should be.
 *
 * Two distinguishable failures, and the difference matters to whoever is
 * woken up:
 *
 *   A DIVERGENCE INSIDE THE LEDGER means an entry's own recorded after-state
 *   does not follow from the entry before it. Something wrote a row that
 *   disagrees with the movement it describes — the ledger is internally
 *   inconsistent, and `seq` says exactly where.
 *
 *   A CLEAN REPLAY THAT DOES NOT MATCH THE WALLET means every entry is
 *   self-consistent and the wallet still holds a different number. Something
 *   moved a balance without writing an entry at all — the failure
 *   `provisionWalletWithGrant` exists because of.
 *
 * ⚠ IT NEVER WRITES. Not a correcting update, not a compensating entry, not
 * a "close enough" tolerance. §6 rule 4: an unreconcilable discrepancy is
 * resolved by a human-authored `adjustment` with a reason. This reports and
 * stops.
 */
export async function verifyWorkspaceWallet(tx: ClientBase, workspaceId: string): Promise<WalletMismatch | null> {
  const wallet = await readWallet(tx, workspaceId);
  const rows = await readLedgerForReplay(tx, workspaceId);
  const counters = await readLifetimeCounters(tx, workspaceId);

  if (wallet === null) {
    // No wallet and no history is not a discrepancy — it is a workspace that
    // has never touched a priced route. A ledger with no wallet is.
    if (rows.length === 0) return null;
    return {
      workspaceId,
      seq: rows[rows.length - 1]!.seq,
      reason: "the workspace has ledger entries and no wallet row",
      wallet: ZERO,
      replayed: replayLedger(rows).balance,
      counter: null,
    };
  }

  const result = replayLedger(rows);
  if (result.divergence !== null) {
    return {
      workspaceId,
      seq: result.divergence.seq,
      reason: result.divergence.reason,
      wallet: result.divergence.recorded,
      replayed: result.divergence.replayed,
      counter: null,
    };
  }

  const actual = tripleOf(wallet);
  if (!equal(actual, result.balance)) {
    return {
      workspaceId,
      seq: null,
      reason: "the ledger replays cleanly and the wallet holds a different balance: a movement was made with no entry",
      wallet: actual,
      replayed: result.balance,
      counter: null,
    };
  }

  // The balances agree. The lifetime totals are checked SECOND and reported
  // separately because they mean something different: a spendable balance
  // that is wrong is the customer's money, and a lifetime total that is
  // wrong is every report built on it.
  const counter = counters === null ? null : firstCounterMismatch(counters, result.lifetime);
  if (counter === null) return null;

  return {
    workspaceId,
    seq: null,
    reason: `the balances reconcile and lifetime_${counter.counter} does not: a movement was counted wrong`,
    wallet: actual,
    replayed: result.balance,
    counter,
  };
}

function firstCounterMismatch(wallet: LifetimeCounters, replayed: LifetimeCounters): CounterMismatch | null {
  for (const counter of ["granted", "purchased", "spent"] as const) {
    if (wallet[counter] !== replayed[counter]) {
      return { counter, wallet: wallet[counter], replayed: replayed[counter] };
    }
  }
  return null;
}


/**
 * Every workspace the verifier has to check — one that holds a wallet, or
 * one that has ledger history, or both.
 *
 * ⚠ CROSS-TENANT, SO IT NEEDS A PRIVILEGED CONNECTION, same contract as
 * `openReservations` and `retention.ts`'s discovery functions. The UNION is
 * not belt-and-braces: a workspace with a wallet and no ledger is the
 * "balance moved with no entry" failure, and one with a ledger and no wallet
 * is the "history survived its wallet" failure. Scanning only the wallets
 * would miss the second, and only the ledger would miss the first — and each
 * is exactly the kind of thing a nightly verifier exists to catch.
 */
export async function listReconcilableWorkspaceIds(tx: ClientBase): Promise<string[]> {
  const result = await tx.query<{ workspace_id: string }>(
    `SELECT workspace_id FROM credit_wallets
      UNION
     SELECT DISTINCT workspace_id FROM credit_ledger
      ORDER BY workspace_id ASC`,
  );
  return result.rows.map((row) => row.workspace_id);
}

/**
 * Is migration 0023 applied?
 *
 * ⚠ THE VERIFIER REFUSES TO RUN WITHOUT `seq`, rather than falling back to
 * `occurred_at`. A fallback would look like resilience and would page a
 * human every time two priced requests raced for one wallet — see migration
 * 0023. A verifier nobody trusts gets muted, and a muted verifier is
 * indistinguishable from no verifier on the night it matters.
 */
export async function replayOrderingAvailable(tx: ClientBase): Promise<boolean> {
  const result = await tx.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'credit_ledger' AND column_name = 'seq'`,
  );
  return (result.rowCount ?? 0) > 0;
}
