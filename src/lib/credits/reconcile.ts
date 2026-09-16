import type { ClientBase, Pool, PoolClient } from "pg";
import { openReservations, type OpenReservation } from "./ledger.js";
import { releaseReservation } from "./settle.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-073 — the orphan reconciler. `system-architecture.md` §4 gives it a
// queue (`credit.reconcile`, "cron every 10 min", concurrency 1) and
// `plans-and-entitlements.md` §6 gives it its job: find reservations with no
// matching commit or release, and release them.
//
// ⚠ WHY ORPHANS EXIST AT ALL, given how hard STORY-072 worked to prevent
// them. `CreditGuard` reserves before the handler runs and
// `CreditInterceptor` settles after it returns, and between those two points
// is a process that can be killed. A pod evicted mid-request, an OOM, a node
// drained during a deploy — the transaction that reserved has committed and
// the one that would have settled never runs. Nothing in the request path
// can close that, because the thing that would close it is the thing that
// died.
//
// So the hold stays on the wallet, and `available` is permanently short by
// that amount for a customer who was never charged for anything. Before this
// file, STORY-072's settlement paths described an unsettled reservation as
// "bounded and recoverable" and nothing recovered it.

/**
 * How long a reservation may stay open before it is presumed orphaned.
 *
 * ⚠ TOO SHORT AND THE RECONCILER RACES THE REQUEST IT IS RECONCILING —
 * releasing a hold on an action that is still running, which then commits
 * against a reservation that is no longer there. `edge-cases-and-slos.md`
 * SLO 8 puts a hard deadline of 45 seconds on the longest interactive
 * action, so fifteen minutes is twenty times the worst legitimate case.
 *
 * Deliberately not tunable by env. The safe value is a property of the
 * request deadline, not of a deployment, and the failure mode of getting it
 * wrong is silently charging people for work they did not get.
 */
export const ORPHAN_GRACE_MS = 15 * 60 * 1000;

/** Where the reconciler's two halves get their connections, and why they differ. */
export interface ReconcileConnections {
  /**
   * ⚠ MUST BYPASS RLS. `openReservations` is a cross-tenant scan and
   * `credit_ledger` carries FORCE ROW LEVEL SECURITY, so on the runtime role
   * with no tenant context it returns ZERO ROWS — and a reconciler that sees
   * nothing reports `found: 0`, which is indistinguishable from "there are
   * no orphans".
   *
   * The second-engineer review found exactly that, and it was not
   * hypothetical: both production entry points built their pool from
   * `DATABASE_URL_POOLED` (`nominara_app`), and every test ran on the
   * container superuser, which bypasses RLS. Same database, same instant,
   * same function:
   *
   *   superuser:     found 2, released 2
   *   nominara_app:  found 0, released 0
   *
   * Same privilege contract as `retention.ts`'s cross-tenant discovery
   * functions, whose own comment describes this failure — "so the sweep
   * would silently do nothing every night" — and which this code cited as
   * precedent while making the mistake it warns about.
   */
  readonly discovery: ClientBase;
  /**
   * The ordinary runtime pool. Each release runs inside `withTenantContext`
   * for the workspace that owns it, so the WRITE half is RLS-scoped exactly
   * as a request would be. Only discovery needs the privilege.
   */
  readonly work: Pool;
}

export interface ReconcileOutcome {
  /** Reservations found open beyond the grace period. */
  readonly found: number;
  /** Those this run actually released. */
  readonly released: number;
  /** Those a commit or another releaser had already closed by the time this run reached them. */
  readonly alreadySettled: number;
  /** Credits handed back, summed across the released holds. */
  readonly credits: number;
  /** Reservations that could not be released, each with why. */
  readonly failures: readonly { readonly workspaceId: string; readonly key: string; readonly reason: string }[];
}

export interface ReconcileOptions {
  /** Overrides the grace period. Tests only — production takes `ORPHAN_GRACE_MS`. */
  readonly graceMs?: number;
}

/**
 * Find every orphaned reservation and hand the credits back.
 *
 * ⚠ ONE TRANSACTION PER RESERVATION, NOT ONE FOR THE RUN. A single
 * transaction across every workspace would hold a row lock on every wallet
 * it touched for the length of the scan, blocking live requests behind a
 * background job; and one unreleasable orphan would roll back every release
 * that had already succeeded, so a single bad row would keep the whole
 * estate un-reconciled indefinitely. Failures are collected and reported,
 * and the run continues.
 *
 * ⚠ TWO CONNECTIONS, AND THE DIFFERENCE IS LOAD-BEARING. See
 * `ReconcileConnections` — discovery is a cross-tenant scan that RLS reduces
 * to nothing on the runtime role, and each release is an ordinary
 * tenant-scoped write.
 */
export async function reconcileOrphanedReservations(
  connections: ReconcileConnections,
  options: ReconcileOptions = {},
): Promise<ReconcileOutcome> {
  // Seconds, and measured against the DATABASE's clock rather than this
  // process's — see `openReservations`. A grace window the app server
  // computes is a window two machines have to agree on.
  const graceSeconds = (options.graceMs ?? ORPHAN_GRACE_MS) / 1000;

  const orphans: readonly OpenReservation[] = await openReservations(connections.discovery, graceSeconds);

  let released = 0;
  let alreadySettled = 0;
  let credits = 0;
  const failures: { workspaceId: string; key: string; reason: string }[] = [];

  for (const reservation of orphans) {
    // ⚠ CHECKED OUT INSIDE THE TRY. Outside it, a pool timeout partway
    // through the loop threw out of this function and discarded the outcome
    // for every orphan already released — a run that did real work and
    // reported none of it.
    let client: PoolClient | undefined;
    try {
      client = await connections.work.connect();
      const outcome = await withTenantContext(
        client,
        { workspaceId: reservation.workspaceId, actorId: SYSTEM_ACTOR_ID },
        (tx: ClientBase) => releaseReservation(tx, reservation, "credit_reconciler"),
      );
      if (outcome === "released") {
        released += 1;
        credits += reservation.credits;
      } else {
        alreadySettled += 1;
      }
    } catch (error) {
      failures.push({
        workspaceId: reservation.workspaceId,
        key: reservation.idempotencyKey,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      client?.release();
    }
  }

  return { found: orphans.length, released, alreadySettled, credits, failures };
}
