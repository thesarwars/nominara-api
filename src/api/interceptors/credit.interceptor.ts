import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  type OnModuleDestroy,
} from "@nestjs/common";
import { catchError, from, mergeMap, type Observable } from "rxjs";
import type { ClientBase, Pool } from "pg";
import { createPgPool, PG_POOL } from "../../db/pg-pool.js";
import { appendLedgerEntry, ledgerEntryExists } from "../../lib/credits/ledger.js";
import { commitCredits, readWallet, releaseCredits } from "../../lib/credits/wallet.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { afterCommit, currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";
import type { CreditReservation } from "../guards/credit.guard.js";

// STORY-022-E-2 composed this slot as a pass-through; STORY-072 fills it.
//
// §6's settlement: COMMIT the actual amount on success, RELEASE the whole
// reservation on failure. `CreditGuard` reserved before the handler ran and
// left what it reserved on the request; this is the only code that clears it.
//
// ⚠ ITS POSITION IN THE CHAIN IS LOAD-BEARING and is not this file's to
// choose. `api.module.ts` registers Audit BEFORE Credit, which — because
// NestJS runs interceptor "after" logic in REVERSE registration order — means
// this settles the debit BEFORE the audit row is appended, with
// `TenantContextInterceptor`'s transaction still open across both. Locked by
// `src/api/api.module.spec.ts` — the review pointed out that the
// `composition-root.spec.ts` this comment used to name does not exist.
//
// ⚠ THE COMMIT AND THE RELEASE DO NOT RUN IN THE SAME TRANSACTION, AND THAT
// ASYMMETRY IS THE POINT.
//
// The reservation was made by `CreditGuard`, on its own connection, and
// committed independently — guards run before `TenantContextInterceptor`, so
// there was no ambient transaction to join. What happens afterwards differs:
//
//   COMMIT joins the REQUEST's transaction (`currentTenantStore()`). The
//   debit and the work the customer paid for then land together or not at
//   all, which is the only correct billing semantics: a committed debit
//   beside a rolled-back run is a charge for nothing.
//
//   RELEASE takes a FRESH CONNECTION. It only runs when the handler threw,
//   which means the request's transaction is already doomed — a release
//   written into it would roll back with everything else and strand the
//   reservation until the reconciler swept it up.
//
// Getting this the other way round is the quiet failure: the release would
// look correct in the code and do nothing at runtime.
//
// A SETTLEMENT FAILURE MUST NOT FAIL A SUCCEEDED REQUEST on the release path.
// The customer's action already failed for its own reason, and replacing that
// reason with a bookkeeping error tells them nothing useful. An unreleased
// reservation is visible, bounded and recoverable — STORY-073's reconciler
// releases orphans every ten minutes — so it is logged loudly and the
// original error is rethrown unchanged.

const logger = new Logger("credit-interceptor");

/**
 * ⚠ CLEARED ON COMMIT, NOT ON STATEMENT SUCCESS.
 *
 * `delete request.creditReservation` is an in-memory effect inside a
 * transaction that can still roll back — and `AuditInterceptor` is
 * deliberately sequenced AFTER this settlement inside the same transaction,
 * with its errors going upstream where this interceptor's `catchError`
 * cannot see them. The review reproduced it: the debit and the commit entry
 * roll back correctly, the guard's separately-committed reservation does
 * not, and the in-memory clear meant no release was ever scheduled for it.
 *
 * `afterCommit` runs the clear only if the transaction actually commits, so
 * the durable state and the in-memory state cannot disagree.
 */
function clearReservation(request: { creditReservation?: unknown }): void {
  afterCommit(() => {
    delete request.creditReservation;
  });
}

interface CreditSettlingRequest {
  tenant?: { workspaceId: string };
  auth?: { ws?: string | null };
  creditReservation?: CreditReservation;
  /**
   * What the handler actually spent, when it is less than the reservation.
   *
   * A per-unit action sets this; a flat-priced one leaves it alone and
   * commits exactly what it reserved, which is AC5's "no partial commit".
   * Unset is NOT zero — zero would mean the action ran and cost nothing.
   */
  creditsConsumed?: number;
}

/**
 * A SMALL POOL OF ITS OWN, for releases only.
 *
 * Bounded at two connections and with a real connection timeout, so a
 * saturated database turns a release into a logged orphan the reconciler can
 * find rather than a request that never returns. Separate from `PG_POOL`
 * because the whole point is not to compete with the connection the failing
 * request is still holding.
 */
const SETTLEMENT_POOL_MAX = 2;
const SETTLEMENT_CONNECT_TIMEOUT_MS = 2_000;

@Injectable()
export class CreditInterceptor implements NestInterceptor, OnModuleDestroy {
  /**
   * BUILT LAZILY, on the first release.
   *
   * Constructing it eagerly threw at DI time wherever the injected pool was a
   * test double with no connection string, taking down every spec that boots
   * the module. It is also wasted work on a process that never fails a priced
   * request, which is most of them.
   */
  private settlementPool: Pool | null = null;

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {
    // Built from the same configuration the request pool was, so it reaches
    // the same database through the same pooler.
  }

  /**
   * Ends the settlement pool on shutdown.
   *
   * Without it the pool outlives `app.close()` and keeps the process alive on
   * pg's default idle timeout — measured at nine and a half seconds on every
   * SIGTERM — and its clients raise "Connection terminated unexpectedly" when
   * the database goes away first, which surfaced in the integration suite as
   * an unhandled error Vitest warns can cause false positives.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.settlementPool !== null) await this.settlementPool.end();
  }

  /**
   * THROUGH `createPgPool`, so this pool carries the tenant guard too. The
   * review caught it being built as a bare `new Pool(...)`, which made
   * `pg-pool.ts`'s own claim — "no path that checks out an unwrapped client"
   * — false the moment it landed.
   *
   * The connection string comes from THE INJECTED POOL, not from `loadEnv()`.
   * Re-reading the environment would let the settlement pool reach a
   * different database than the request that made the reservation.
   *
   * Null when there is no connection string to build from. The release is
   * then skipped and logged — NEVER fetched from the request pool instead,
   * which is the deadlock this whole arrangement exists to avoid. The ledger
   * carries the open reserve either way.
   */
  private settlement(): Pool | null {
    if (this.settlementPool !== null) return this.settlementPool;

    const options = (this.pool as unknown as { options?: { connectionString?: string } }).options;
    const connectionString = options?.connectionString;
    if (typeof connectionString !== "string" || connectionString.length === 0) return null;

    this.settlementPool = createPgPool(connectionString, {
      max: SETTLEMENT_POOL_MAX,
      connectionTimeoutMillis: SETTLEMENT_CONNECT_TIMEOUT_MS,
    });
    this.settlementPool.on("error", (error) => {
      logger.error(`settlement pool error: ${String(error)}`);
    });
    return this.settlementPool;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<CreditSettlingRequest>();

    // ⚠ `catchError` SITS AFTER THE COMMIT, NOT BEFORE IT.
    //
    // RxJS `catchError` only sees errors raised by operators UPSTREAM of it.
    // With the commit downstream, a commit failure propagated straight out
    // and the release never ran — and `settle` had already cleared the
    // reservation, so nothing could recover it. Found by the second-engineer
    // review, which reproduced it with a handler that swallowed a database
    // error: 500, reservation still held, exactly one connection taken.
    //
    // In this order a throw from the handler AND a throw from the commit both
    // reach the release.
    return next.handle().pipe(
      mergeMap((value: unknown) =>
        from(this.commitAndStamp(context, request)).pipe(mergeMap(() => [value])),
      ),
      catchError((error: unknown) => {
        this.scheduleRelease(request);
        throw error;
      }),
    );
  }

  private async commitAndStamp(context: ExecutionContext, request: CreditSettlingRequest): Promise<void> {
    await this.commit(request);
    await this.stampWallet(context, request);
  }

  /**
   * Inside the REQUEST's transaction, so the debit and the work it paid for
   * land together.
   */
  private async commit(request: CreditSettlingRequest): Promise<void> {
    const reservation = request.creditReservation;
    if (reservation === undefined) return;

    const store = currentTenantStore();
    if (store === undefined) {
      // No ambient transaction means this route did not go through
      // TenantContextInterceptor, which a priced route always does. Refusing
      // to guess beats committing on a connection with no tenant context —
      // RLS would refuse the write anyway, less legibly. The reservation is
      // LEFT ON THE REQUEST so the release below still settles it.
      throw new Error(
        `credit commit for workspace ${reservation.workspaceId} has no tenant transaction to join; ` +
          "a priced route must run under TenantContextInterceptor",
      );
    }

    // ⚠ UNREACHABLE BY DESIGN, AND LOUD IF IT IS NOT.
    //
    // The first version skipped the debit silently when a `commit` entry
    // already existed. The review showed what that costs: when
    // `IdempotencyInterceptor` loses its stored response it degrades to
    // EXECUTING, so the handler really runs again — spending at the engine a
    // second time — and this branch made it free.
    //
    // The guard now refuses a key whose reservation already committed, so a
    // re-executed paid action cannot reach here at all. This check remains
    // as a second layer, and it shouts: reaching it means the guard's refusal
    // did not hold, which is a defect worth waking someone for.
    if (await ledgerEntryExists(store.client, reservation.workspaceId, "commit", reservation.idempotencyKey, reservation.attempt)) {
      logger.error(
        `a commit already exists for workspace ${reservation.workspaceId} ` +
          `(idempotency key ${reservation.idempotencyKey}) yet the handler ran again. ` +
          "The action was performed without being charged — investigate the guard's already-committed refusal.",
      );
      clearReservation(request);
      return;
    }

    // AC5 — a per-unit action commits what it used and the statement releases
    // the difference; a flat-priced one commits exactly its reservation.
    // `?? amount` is what makes the flat case the default, so a route that
    // declares nothing cannot under-charge.
    const consumed = request.creditsConsumed ?? reservation.amount;
    const committed = await commitCredits(store.client, reservation.workspaceId, consumed, reservation.amount);

    if (committed === null) {
      // ⚠ THIS FAILS THE REQUEST, and the comment that used to sit here said
      // so while the code logged and returned 200. The review caught the
      // contradiction. A commit matching no row means the reservation is
      // gone — swept by the reconciler, or already settled — and returning
      // success would hand the customer a free run. The reservation stays on
      // the request so the release path can try to settle it.
      throw new Error(
        `credit commit matched no wallet row for workspace ${reservation.workspaceId} ` +
          `(idempotency key ${reservation.idempotencyKey}); the reservation is no longer held`,
      );
    }

    await appendLedgerEntry(store.client, {
      workspaceId: reservation.workspaceId,
      entryType: "commit",
      actionCode: reservation.ledgerAction,
      credits: consumed,
      idempotencyKey: reservation.idempotencyKey,
      attempt: reservation.attempt,
      after: committed,
      actorId: null,
      actorType: "system",
    });

    clearReservation(request);
  }

  /**
   * ⚠ OFF THE REQUEST'S CRITICAL PATH, ON A POOL OF ITS OWN.
   *
   * The first version awaited `this.pool.connect()` from inside `catchError`
   * — while `TenantContextInterceptor` still held the request's connection,
   * because its `finally` runs only after this observable settles. The
   * review reproduced the consequence: at `max: 1` the request never
   * responded, and pg's default `max: 10` with no connection timeout means
   * ten concurrent failing priced requests wedge the process permanently,
   * each holding one connection and waiting for an eleventh that the holders
   * themselves are blocking.
   *
   * So the release is not awaited and does not touch the request's pool. It
   * runs after the response on a small dedicated pool with a bounded
   * timeout, and if even that fails the ledger carries an open `reserve`
   * entry with no matching settlement — which is what makes "bounded and
   * recoverable" true rather than aspirational.
   */
  private scheduleRelease(request: CreditSettlingRequest): void {
    const reservation = request.creditReservation;
    if (reservation === undefined) return;
    delete request.creditReservation;

    setImmediate(() => {
      void this.release(reservation);
    });
  }



  private async release(reservation: CreditReservation): Promise<void> {
    const pool = this.settlement();
    if (pool === null) {
      logger.error(
        `cannot release ${String(reservation.amount)} credits for workspace ${reservation.workspaceId}: ` +
          "no settlement pool could be built. The ledger carries an open reserve entry for the reconciler.",
      );
      return;
    }
    try {
      const client = await pool.connect();
      try {
        await withTenantContext(
          client,
          { workspaceId: reservation.workspaceId, actorId: SYSTEM_ACTOR_ID },
          async (tx: ClientBase) => {
            if (
              await ledgerEntryExists(
                tx,
                reservation.workspaceId,
                "release",
                reservation.idempotencyKey,
                reservation.attempt,
              )
            ) {
              return;
            }
            await releaseCredits(tx, reservation.workspaceId, reservation.amount);
            const after = await readWallet(tx, reservation.workspaceId);
            if (after === null) return;
            await appendLedgerEntry(tx, {
              workspaceId: reservation.workspaceId,
              entryType: "release",
              actionCode: reservation.ledgerAction,
              credits: reservation.amount,
              idempotencyKey: reservation.idempotencyKey,
              attempt: reservation.attempt,
              after,
              actorId: null,
              actorType: "system",
            });
          },
        );
      } finally {
        client.release();
      }
    } catch (error) {
      logger.error(
        `failed to release ${String(reservation.amount)} credits for workspace ${reservation.workspaceId} ` +
          `(idempotency key ${reservation.idempotencyKey}): ${String(error)}. ` +
          "The ledger carries an open reserve entry for the reconciler.",
      );
    }
  }

  /**
   * AC11 — `NFR-API-12`: "every response to an authenticated route carries
   * wallet state, so NO CLIENT EVER NEEDS A SECOND CALL to keep a balance
   * chip current." §1 names the four headers.
   *
   * Read inside the REQUEST'S OWN TRANSACTION rather than on a fresh
   * connection. This runs on every authenticated response, so a second
   * connection per response would be a connection-pool cost paid by every
   * route in the product to serve a number three of them display.
   *
   * ⚠ SUCCESS RESPONSES ONLY. On the error path the transaction is rolling
   * back, and reading a balance out of a doomed transaction to publish it as
   * current is worse than omitting it. The one error that genuinely needs the
   * figure — `402 insufficient_credits` — carries the full wallet in its own
   * `details`, which is where a client should read it from anyway.
   */
  private async stampWallet(context: ExecutionContext, request: CreditSettlingRequest): Promise<void> {
    const workspaceId = request.tenant?.workspaceId ?? request.auth?.ws ?? undefined;
    if (!workspaceId) return;

    const store = currentTenantStore();
    if (store === undefined) return;

    try {
      const wallet = await readWallet(store.client, workspaceId);
      if (wallet === null) return;

      const response = context.switchToHttp().getResponse<{ header?: (name: string, value: string) => void }>();
      response.header?.("x-nominara-credits-available", String(wallet.available));
      response.header?.("x-nominara-credits-reserved", String(wallet.reserved));
      // §1 calls this "included-bucket credits expiring at cycle end", and
      // the WHOLE included bucket expires — that is what "included" means.
      response.header?.("x-nominara-credits-expiring", String(wallet.includedBalance));
      response.header?.("x-nominara-credits-cycle-end", wallet.cycleEnd);
    } catch (error) {
      // A balance chip is not worth failing a succeeded request over.
      logger.warn(`could not stamp wallet headers for workspace ${workspaceId}: ${String(error)}`);
    }
  }
}
