import { CanActivate, ExecutionContext, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ClientBase, Pool } from "pg";
import { PG_POOL } from "../../db/pg-pool.js";
import {
  appendLedgerEntry,
  inspectReservations,
  type LedgerActionCode,
  type ReservationClaim,
} from "../../lib/credits/ledger.js";
import { provisionWalletWithGrant } from "../../lib/credits/balance.js";
import { CONFIRMED_CREDITS_HEADER, parseConfirmedCredits, requireConfirmedCredits } from "../../lib/credits/confirmed-credits.js";
import { includedGrantOf, isReservedLedgerKey } from "../../lib/credits/debit.js";
import { purchasableOptions, reserveCredits, readWallet } from "../../lib/credits/wallet.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { compensateDailyCounter } from "../../lib/usage/daily-cap.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import {
  CREDITS_FROM_COMMAND_PARSE,
  CREDITS_KEY,
  CREDIT_ACTIONS,
  CREDIT_PRICE_KEY,
  type CreditAction,
} from "../decorators/credits.decorator.js";
import { CACHE, type Cache } from "../../lib/cache/cache.port.js";
import { cacheKeyNamespace } from "../../lib/cache/key-namespace.js";
import { assertMayExecute } from "../../lib/command/execute-access.js";
import { peekParseRecord } from "../../lib/command/parse-record.js";
import { commandExecuteRequestSchema } from "../../../contracts/command/execute-request.schema.js";
import {
  ConflictError,
  DomainError,
  InsufficientCreditsError,
  PriceChangedError,
  ValidationFailedError,
} from "../errors/domain-errors.js";
import { CREDIT_PRECONDITIONS, type CreditPreconditionRequest } from "./credit-preconditions.js";
import type { DailyCapScopedRequest } from "./daily-cap.guard.js";
import type { AuthenticatedRequest } from "./auth.guard.js";
import type { WorkspaceScopedRequest } from "./workspace.guard.js";

// STORY-022-E-2 composed this slot as a pass-through; STORY-034 fills in the
// HALF THAT DOES NOT NEED A WALLET.
//
// §5's chain gives this guard two jobs — reserve from `credit_wallets`, and
// confirm the price the caller was quoted. They have different dependencies:
//
//   RESERVE  → 402 insufficient_credits. Needs `credit_wallets`, which
//              EPIC-10 (STORY-072) builds. Still not here.
//   CONFIRM  → 409 price_changed. Needs the PRICE, which is a plan
//              entitlement and has been readable since STORY-069.
//
// STORY-072 FILLS IN THE RESERVE HALF. `credit_wallets` now exists, so the
// order is: confirm the quote, then reserve against it. Confirming first is
// deliberate — a stale quote should be refused without touching the wallet
// at all, and a reservation made before the price check would have to be
// released on the very next line.

const logger = new Logger("credit-guard");

interface CreditScopedRequest extends WorkspaceScopedRequest, DailyCapScopedRequest, CreditPreconditionRequest {
  headers?: Record<string, string | string[] | undefined>;
  /**
   * AC10 — what the interceptor settles.
   *
   * Set only when this guard actually reserved. The interceptor commits it on
   * success and releases it on failure; an absent value means there is
   * nothing to settle, which is the correct state for an unpriced route.
   */
  creditReservation?: CreditReservation;
}

/**
 * Who is spending, in the two facts `credit_ledger` records.
 *
 * ⚠ EVERY ENTRY SAID `system` BEFORE THIS. STORY-072 wrote `actorId: null,
 * actorType: "system"` on the reserve and the commit alike, so a workspace
 * looking at its own history saw a column of identical system rows and the
 * story's own question — "what spent my credits?" — had no answer in the
 * data. The request has always known; nothing carried it the twelve lines
 * from the guard to the ledger.
 *
 * `system` remains a real value, for the entries a person did not cause: the
 * reconciler's releases, and a grant applied at provisioning.
 */
export interface CreditActor {
  readonly actorId: string | null;
  readonly actorType: "user" | "api_key" | "system";
}

/**
 * Resolve the actor from the request.
 *
 * ⚠ THE API-KEY BRANCH RECORDS THE KEY'S ID, NOT A USER'S. An API key is a
 * workspace credential; attributing its spend to whichever person created it
 * would put a name against actions they did not take, in a financial record
 * kept for the invoice-dispute window. `actor_id` has an FK to `users`, so
 * the id is deliberately NOT written there — `actor_type` says `api_key` and
 * `actor_id` stays null, which is the honest shape until `credit_ledger`
 * grows a column that can hold a key.
 */
export function creditActorOf(request: AuthenticatedRequest & { apiKey?: { id: string } }): CreditActor {
  if (request.authMethod === "apiKey") return { actorId: null, actorType: "api_key" };
  const sub = request.auth?.sub;
  return sub === undefined ? { actorId: null, actorType: "system" } : { actorId: sub, actorType: "user" };
}

export interface CreditReservation {
  readonly workspaceId: string;
  readonly action: CreditAction;
  /** Who is spending. Carried from the guard so the commit attributes the same person the reserve did. */
  readonly actor: CreditActor;
  /** What was reserved. A flat-priced action commits exactly this. */
  readonly amount: number;
  /**
   * The request's `Idempotency-Key`, and it is REQUIRED — the guard refuses a
   * priced route without one. It is what `ux_credit_ledger_idem` dedupes on,
   * so a reservation that had no key could be opened twice by a redelivery,
   * which is the leak the second-engineer review reproduced.
   */
  readonly idempotencyKey: string;
  /** `credit_ledger.action_code` for this action, resolved once by the guard. */
  readonly ledgerAction: LedgerActionCode;
  /**
   * Which attempt under that key this reservation is.
   *
   * A COLUMN, NOT A SUFFIX. Settlement closes this exact attempt, and the
   * client cannot write it — see migration 0022 for what the string version
   * let a second seat in a workspace do to someone else's reservation.
   */
  readonly attempt: number;
}

/** §1's header, verbatim. Lowercased because Node normalises incoming header names. */
export { CONFIRMED_CREDITS_HEADER };

/**
 * A route declared a priced action this build does not know. Fails CLOSED: an unknown action has no price entry, so
 * resolving it would read `null`, and a null price lets the route run UNPRICED (STORY-110, unknown-key rejection).
 * The type system forbids it at compile time; this is the runtime half, for metadata that was cast or generated.
 */
export class UnknownCreditActionError extends Error {
  constructor(action: unknown) {
    super(`route declares credit action ${JSON.stringify(action)}, which is not one of ${CREDIT_ACTIONS.join(", ")}; refusing rather than running it unpriced`);
    this.name = "UnknownCreditActionError";
  }
}

@Injectable()
export class CreditGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: EntitlementResolver,
    @Inject(PG_POOL) private readonly pool: Pool,
    // STORY-085: read only to resolve a command-bar parse record. Optional so a route that never uses the marker
    // needs no cache, and so a test that builds this guard by hand is unaffected; a marker route without one fails closed.
    @Optional() @Inject(CACHE) private readonly cache?: Cache,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const declared = this.reflector.getAllAndOverride<CreditAction | typeof CREDITS_FROM_COMMAND_PARSE | undefined>(
      CREDITS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (declared === undefined) return true;
    const fromParse = declared === CREDITS_FROM_COMMAND_PARSE;
    if (!fromParse && !(CREDIT_ACTIONS as readonly unknown[]).includes(declared)) throw new UnknownCreditActionError(declared);

    const request = context.switchToHttp().getRequest<CreditScopedRequest>();
    // ⚠ NO `?? request.auth?.ws` FALLBACK, AND ITS REMOVAL IS STORY-153's ONE
    // MECHANICAL FIX. That arm was DEAD on every route that should reach here:
    // on a tenant-scoped route carrying a `ws` claim, WorkspaceGuard has
    // already validated it and set `req.tenant`; on one without a claim it
    // yielded `undefined` anyway. It could only ever YIELD A VALUE on a
    // tenant-less route — where the claim has been validated by nothing, and
    // must not be used at all.
    //
    // STORY-153's early return is what made that reachable. A test forbids
    // pairing this decorator with @SkipTenantContext(), but deleting the arm
    // closes it BY CONSTRUCTION rather than by assertion, and demotes that
    // test to defence in depth — which is where a list like it belongs.
    //
    // Verified dead: removed across all five sites with unit and integration
    // both fully green. The refusal below already handles `undefined`.
    const workspaceId = request.tenant?.workspaceId ?? undefined;
    if (!workspaceId) {
      // A price is a property of a plan, and a request with no workspace has
      // no plan. Refusing beats charging against a default.
      throw new ValidationFailedError({
        message: "a credit-priced route requires a workspace",
        details: {
          issues: [
            {
              path: ["workspace"],
              message:
                "no workspace is resolved for this request, or the route is @SkipTenantContext() — a priced route cannot be tenant-less",
            },
          ],
        },
      });
    }

    // STORY-085: a command-bar execute names its action in the parse record. A record that prices nothing (a task)
    // returns here: the permission was still checked above the price, and nothing is reserved.
    let action: CreditAction;
    let scopeRequest: CreditPreconditionRequest = request;
    if (fromParse) {
      const planned = await this.resolveCommandAction(request, workspaceId);
      if (planned === null) return true;
      action = planned.action;
      // The deep-scan precondition reads the project from `params.id`; this route has no such segment, the parse bound it.
      scopeRequest = { params: { id: planned.projectId } };
    } else {
      action = declared as CreditAction;
    }

    const confirmed = this.confirmedCredits(request);
    const resolved =
      request.entitlementVersion === undefined
        ? await this.resolver.resolveForWorkspace(workspaceId)
        : await this.resolver.resolve(workspaceId, request.entitlementVersion);
    const price = resolved.entitlements[CREDIT_PRICE_KEY[action]]?.value ?? null;

    // NOT THIS GUARD'S REFUSAL. A price that is null or non-numeric means the
    // plan does not sell this action, or an enterprise figure was never
    // negotiated — two different answers with two different remediations, and
    // the module that knows which one applies raises them. Reporting
    // `price_changed` here would tell a free-tier customer their quote went
    // stale when they were never quoted anything.
    if (typeof price !== "number") return true;

    if (confirmed !== price) {
      throw new PriceChangedError({
        message: "the confirmed price does not match this action's current price",
        // BOTH FIGURES, which is what the taxonomy's own shape asks for. A
        // client told only "it changed" has to guess whether to re-quote or
        // give up, and an operator staring at a modal saying 200 deserves to
        // be told the answer is now 500.
        details: {
          shown: confirmed,
          recomputed: price,
          reason: `${CREDIT_PRICE_KEY[action]} resolved to ${String(price)} for this workspace`,
        },
      });
    }

    await this.reserve(request, workspaceId, action, price, confirmed, resolved.entitlements, scopeRequest);
    return true;
  }

  /**
   * §6 STEP 1, made IDEMPOTENT, and the refusal that follows from zero rows.
   *
   * ⚠ THE LEDGER ENTRY IS THE PERMISSION TO MOVE THE BALANCE. The
   * second-engineer review reproduced a 600-credit wallet drained to zero by
   * three retries of one action: guards run before ALL interceptors, so
   * anything that short-circuits in `IdempotencyInterceptor` — a replay, an
   * `in_flight` conflict, a body mismatch — leaves the reservation this guard
   * made with nothing to settle it. Each retry opened another.
   *
   * `ux_credit_ledger_idem` closes it. The `reserve` entry is written FIRST,
   * under the request's `Idempotency-Key`; a redelivery conflicts, the insert
   * reports `false`, and the wallet is never touched a second time. The
   * caller re-attaches to the reservation that already exists.
   *
   * ⚠ AND A PRICED ROUTE WITHOUT A KEY IS REFUSED BEFORE ANY OF THIS. Without
   * one there is nothing to dedupe on, so the leak would be reachable again
   * by simply omitting a header — which is how the review reached it. §1
   * requires the header on every billable POST and `IdempotencyInterceptor`
   * would 400 the request moments later anyway; refusing here means it does
   * so without a reservation behind it.
   */
  private async reserve(
    request: CreditScopedRequest,
    workspaceId: string,
    action: CreditAction,
    price: number,
    confirmed: number,
    entitlements: Readonly<Record<string, { readonly value: unknown }>>,
    scopeRequest: CreditPreconditionRequest = request,
  ): Promise<void> {
    // A zero-priced action has nothing to reserve. Reserving 0 would write a
    // row for a spend that cannot fail and would leave the interceptor with
    // a settlement to make for no credits.
    if (price === 0) return;

    const idempotencyKey = idempotencyKeyOf(request);
    if (idempotencyKey === undefined) {
      throw new ValidationFailedError({
        message: "a credit-spending route requires an Idempotency-Key",
        details: {
          issues: [{ path: ["idempotency-key"], message: "required on a credit-priced route" }],
        },
      });
    }

    // The inline debits (prompt activation) write their own ledger keys in this namespace from inside a handler. A
    // client-chosen key here could collide with one, turning a genuine charge into a refused append.
    if (isReservedLedgerKey(idempotencyKey)) {
      throw new ValidationFailedError({
        message: "this Idempotency-Key is in a namespace reserved for the server",
        details: { issues: [{ path: ["idempotency-key"], message: "must not start with a reserved internal prefix" }] },
      });
    }

    let refusal: InstanceType<typeof InsufficientCreditsError> | null = null;
    let alreadyCommitted = false;
    let attempt = 1;
    /** Set only when re-attaching: what the standing reservation actually holds. */
    let heldCredits: number | null = null;
    /** Collected, not thrown: throwing here would roll back the transaction that read the claim. */
    let reattachMismatch: InstanceType<typeof PriceChangedError> | null = null;
    /** A precondition's refusal — collected for the same reason `refusal` is, and thrown after the same compensation. */
    let unmet: DomainError | null = null;

    const client = await this.pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx: ClientBase) => {
        // Nothing else in the product creates a wallet row — see
        // `provisionWallet`. On the request path so there is no window in
        // which a cycle has begun and the row does not exist.
        //
        // It runs BEFORE the precondition below, so a refused scan on a
        // workspace that has never been charged still creates the wallet and
        // its included `grant` (idempotent per cycle — the lazy provisioning
        // every workspace goes through on its first priced request). A refusal
        // never writes a reserve, a release or a debit; the grant is the only
        // ledger row it can leave (deep-scan-zero-scope-http.spec.ts).
        const period = await resolveBillingPeriod(tx, workspaceId);
        await provisionWalletWithGrant(tx, workspaceId, includedGrantOf(entitlements), period);

        // ⚠ "IS ONE OF THIS KEY'S RESERVATIONS STILL OPEN", not "has this key
        // reserved before". A ledger entry is permanent; a reservation is
        // not. Testing the entry's mere existence re-attached a retry to a
        // reservation that had already been released, and the commit then
        // matched no row — 500, nothing charged, key poisoned forever.
        const claim = await inspectReservations(tx, workspaceId, idempotencyKey);

        if (claim.committed) {
          // THE ACTION ALREADY RAN AND WAS PAID FOR. Reaching here means
          // `IdempotencyInterceptor` lost its stored response — it says it
          // degrades to executing rather than refusing — and executing a
          // paid action a second time would spend at the engine again.
          // Refusing at the GUARD is what stops the handler running at all.
          alreadyCommitted = true;
          return;
        }

        if (claim.openAttempt !== null) {
          // A redelivery of a request whose reservation is still standing.
          // Re-attach: the credits are already held.
          //
          // ⚠ AND SETTLE AGAINST WHAT IS HELD, NOT AGAINST TODAY'S PRICE.
          // `price` is recomputed on every delivery, so a redelivery arriving
          // after the schedule moved would hand settlement a figure this
          // reservation never held — too high and the commit matches no row
          // (a 500 for work that was performed), too low and the difference
          // stays reserved until the cycle ends with nothing to release it.
          attempt = claim.openAttempt;
          heldCredits = claim.openCredits;

          // ⚠ AND THE CONFIRMED FIGURE HAS TO BE CHECKED AGAINST THAT SAME
          // HELD AMOUNT. The check at the top of `canActivate` compared it
          // against today's price, which is the number this delivery will
          // NOT be charged — so a customer who re-quoted after a price drop
          // echoed the new figure, passed the check, and was debited the old
          // reservation's larger amount. Reproduced by the second-engineer
          // review: confirmed 200, settled 500.
          //
          // AC6 is "a customer is never charged a figure they did not see",
          // and the figure they will be charged here is the held one.
          if (heldCredits !== null && confirmed !== heldCredits) {
            reattachMismatch = new PriceChangedError({
              message: "the confirmed price does not match the reservation this request is settling",
              details: {
                shown: confirmed,
                recomputed: heldCredits,
                reason:
                  "a reservation for this Idempotency-Key is still open and holds a different amount; " +
                  "re-quote before retrying",
              },
            });
          }
          return;
        }

        // Every prior attempt was released, so this is a genuine retry and
        // needs credits of its own.
        attempt = claim.attempts + 1;

        // ⚠ NOTHING TO BUY IS REFUSED BEFORE ANYTHING IS RESERVED. STORY-034.
        //
        // Here, and only here: this is the one point where a NEW reservation
        // is about to be made. A committed action and a re-attached
        // reservation return above, so a redelivery keeps the meaning it had.
        //
        // The handler refuses an empty deep scan too (`planManualRun`), but
        // it runs after this guard. On a funded wallet that left a permanent
        // reserve-and-release pair in the customer's own ledger beside a 422
        // saying nothing was charged; on a low balance the wallet refused
        // first and told the customer to buy credits for a scan that could not
        // run. The handler's refusal stays, as the in-transaction backstop.
        const precondition = CREDIT_PRECONDITIONS[action];
        if (precondition !== null) {
          try {
            await precondition(tx, scopeRequest);
          } catch (error) {
            // A domain refusal is COLLECTED, not thrown: it would roll back
            // this transaction, and the daily-cap increment has to be given
            // back outside it (below). Anything else is a defect and escapes.
            if (!(error instanceof DomainError)) throw error;
            unmet = error;
            return;
          }
        }

        const outcome = await reserveCredits(tx, workspaceId, price);
        if (!outcome.ok) {
          const wallet = await readWallet(tx, workspaceId);
          if (wallet === null) {
            throw new Error(`workspace ${workspaceId} has no credit wallet after provisioning`);
          }
          // COLLECTED, NOT THROWN. Throwing from inside `withTenantContext`
          // rolls the transaction back — which is correct for the failed
          // reservation, and fatal for the daily-cap compensation that has to
          // follow it. The review caught exactly that: the compensation was
          // written inside the doomed transaction and died with it.
          refusal = new InsufficientCreditsError({
            message:
              "Your scheduled tracking is unaffected and keeps running. This on-demand action needs more credits than the wallet has.",
            details: {
              required: price,
              available: wallet.available,
              wallet: {
                included_balance: wallet.includedBalance,
                purchased_balance: wallet.purchasedBalance,
                reserved: wallet.reserved,
                cycle_end: wallet.cycleEnd,
              },
              packs: (await purchasableOptions(tx, workspaceId)).map((pack) => ({
                key: pack.key,
                credits: pack.credits,
                price_usd: pack.priceUsd,
              })),
            },
          });
          return;
        }

        // The entry goes in the SAME transaction as the wallet movement, so a
        // reservation without its ledger row is unrepresentable. A conflict
        // means this key already reserved: undo this transaction's own
        // increment by rolling back, and re-attach below.
        const first = await appendLedgerEntry(tx, {
          workspaceId,
          entryType: "reserve",
          actionCode: LEDGER_ACTION[action],
          credits: price,
          idempotencyKey,
          attempt,
          after: outcome.wallet!,
          // ⚠ THE RESERVE CARRIES THE ACTOR AND NOT THE PROJECT, and the
          // asymmetry is real rather than an omission. The person is known
          // before the handler runs; what they are about to operate on is
          // not — the handler resolves that, and the COMMIT is the debit
          // AC10 is about. A reserve that guessed at a project would be
          // wrong on every route whose body names it.
          ...creditActorOf(request),
        });
        // A concurrent delivery computed the same attempt number and won.
        // Roll this one back and let the caller re-attach to theirs.
        if (!first) throw new AlreadyReservedError();
      });
    } catch (error) {
      if (!(error instanceof AlreadyReservedError)) throw error;
      // A concurrent delivery got there first. The rollback undid this
      // attempt's increment; re-read to find the reservation it opened.
      const found = await this.openClaimFor(workspaceId, idempotencyKey);
      if (found.openAttempt === null) {
        // `conflict`, NOT `idempotency_conflict`. That code means "same key,
        // different body" and its details name the two request hashes; this
        // is a lost race between two identical deliveries.
        //
        // The wording does not claim a reservation is still being held: the
        // race winner may have settled in the window between our conflict
        // and this re-read, in which case nothing is in flight any more. A
        // plain retry resolves it either way.
        throw new ConflictError({
          message: "another delivery of this request is being processed; retry with the same Idempotency-Key",
        });
      }
      attempt = found.openAttempt;
      heldCredits = found.openCredits;
      // Same rule as the re-attach branch above: settlement will debit what
      // the winning delivery reserved, so that is the figure the customer
      // must have confirmed.
      if (heldCredits !== null && confirmed !== heldCredits) {
        reattachMismatch = new PriceChangedError({
          message: "the confirmed price does not match the reservation this request is settling",
          details: {
            shown: confirmed,
            recomputed: heldCredits,
            reason:
              "a concurrent delivery of this Idempotency-Key opened a reservation for a different amount; " +
              "re-quote before retrying",
          },
        });
      }
    } finally {
      client.release();
    }

    if (alreadyCommitted) {
      // ⚠ NEVER "retry with a new Idempotency-Key". The review caught that
      // wording telling a client which lost its acknowledgement to run the
      // action again under a fresh key — which reserves, executes and
      // charges a SECOND time. A lost acknowledgement must not become a
      // double charge for one customer intent.
      //
      // ⚠ AND THIS DEVIATES FROM §1 AND `NFR-API-07`, deliberately and
      // visibly. Both say a replayed request returns the cached response and
      // debits nothing more. Reaching here means `IdempotencyInterceptor`
      // lost that response — it degrades to executing rather than refusing —
      // and the guard has no stored result to replay. The available choices
      // are refuse, or execute a paid action a second time. Refusing is the
      // one that does not spend the customer's money twice. Recorded in
      // STORY-072 rather than left as a discovery.
      throw new ConflictError({
        message:
          "This request already completed and the credits were charged. Check the run history before retrying — " +
          "repeating it would charge again.",
      });
    }

    if (reattachMismatch !== null) throw reattachMismatch;

    if (unmet !== null) {
      // Given back like a wallet refusal's: the request spent nothing, so it
      // must not have spent the day's allowance either.
      await this.compensateDaily(request);
      throw unmet;
    }

    if (refusal !== null) {
      // ⚠ OUTSIDE the transaction that failed, and on its own connection.
      // STORY-071 AC6: "a wallet failure compensates the increment.
      // Otherwise a user with no credits burns their allowance discovering
      // they have none." The compensation must OUTLIVE the rollback, which
      // is the whole reason it is here and not three lines above.
      await this.compensateDaily(request);
      throw refusal;
    }

    request.creditReservation = {
      workspaceId,
      action,
      actor: creditActorOf(request),
      // `heldCredits` is set only on the re-attach paths, where the
      // reservation predates this delivery and its amount is the ledger's to
      // state rather than this request's to recompute.
      amount: heldCredits ?? price,
      idempotencyKey,
      // Settlement must close the attempt it actually attached to.
      attempt,
      ledgerAction: LEDGER_ACTION[action],
    };
  }


  /**
   * STORY-085 - resolves the priced action a command-bar execute names, BEFORE anything is reserved.
   *
   * Reads the parse record WITHOUT consuming it: a `price_changed` refusal has to leave the id usable so the bar
   * can re-present the confirmation. The handler consumes it, atomically, once the reservation stands. A replayed,
   * expired, foreign or wrong-action id is refused here as the handler would refuse it, so a dead id never reserves.
   * The underlying endpoint's permission is evaluated now, so a forbidden action never reserves either.
   *
   * Returns null for an action that costs nothing (the permission has still been checked).
   */
  private async resolveCommandAction(
    request: CreditScopedRequest,
    workspaceId: string,
  ): Promise<{ action: CreditAction; projectId: string } | null> {
    if (this.cache === undefined) throw new Error("a command-bar execute route needs the cache to resolve its parse id");
    const body = commandExecuteRequestSchema.safeParse((request as { body?: unknown }).body);
    // The route's own pipe reports the malformed body; here it only means there is nothing to price.
    if (!body.success) return null;
    const actorId = request.tenant?.actorId;
    if (actorId === undefined) return null;
    const read = await peekParseRecord(this.cache, cacheKeyNamespace(), body.data.parse_id, {
      workspaceId,
      actorId,
      actionId: body.data.action_id,
    });
    // A refused id is the handler's to report (one typed 409). Pricing nothing is safe: the handler refuses it before it runs.
    if (!read.ok) return null;
    const projectId = read.record.project_id ?? body.data.project_id ?? null;
    assertMayExecute(read.record, request.membership, projectId, request.session?.lastStrongAuthAt ?? null);
    if (read.record.credit_action === null) return null;
    if (projectId === null) {
      // Nothing to scan. Refused before a reservation exists, for the reason the precondition is consulted here at all.
      throw new ValidationFailedError({
        message: "this action needs a project",
        details: { issues: [{ path: ["project_id"], message: "the parse bound no project; send project_id" }] },
      });
    }
    return { action: read.record.credit_action, projectId };
  }

  /**
   * MISSING IS A 400, NOT A ZERO.
   *
   * §1 lists the header as required on every credit-spending execution route.
   * Treating an absent header as "confirmed 0" would let any caller execute a
   * priced action by omitting a header, which is the opposite of a guard
   * rail; treating it as "confirmed whatever the price is" would make the
   * check unfalsifiable.
   */
  private confirmedCredits(request: CreditScopedRequest): number {
    // The parser is shared with the inline-debit routes (prompt activation): one definition of a well-formed header.
    return requireConfirmedCredits(parseConfirmedCredits(request.headers?.[CONFIRMED_CREDITS_HEADER]));
  }

  /** Re-read which of a key's attempts is open, after losing a race to open one. */
  private async openClaimFor(workspaceId: string, idempotencyKey: string): Promise<ReservationClaim> {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx: ClientBase) =>
        inspectReservations(tx, workspaceId, idempotencyKey),
      );
    } finally {
      client.release();
    }
  }

  /** STORY-071 AC6's compensating decrement, committed on a connection of its own. */
  private async compensateDaily(request: CreditScopedRequest): Promise<void> {
    const compensation = request.dailyCapCompensation;
    if (compensation === undefined) return;

    const client = await this.pool.connect();
    try {
      await withTenantContext(
        client,
        { workspaceId: compensation.workspaceId, actorId: SYSTEM_ACTOR_ID },
        (tx: ClientBase) => compensateDailyCounter(tx, compensation.workspaceId, compensation.action),
      );
    } catch (error) {
      // A failed compensation costs the customer one of the day's actions.
      // Worth a loud log; not worth replacing their `402` with a `500`, which
      // would tell them nothing about the actual problem.
      logger.error(
        `failed to compensate the daily counter for workspace ${compensation.workspaceId}: ${String(error)}`,
      );
    } finally {
      client.release();
    }
  }
}

/** Raised and swallowed inside `reserve` to roll back a duplicate attempt. */
class AlreadyReservedError extends Error {}

/** `@Credits` actions onto `credit_ledger.action_code`'s own CHECK. */
const LEDGER_ACTION: Readonly<Record<CreditAction, LedgerActionCode>> = Object.freeze({
  deep_scan: "manual_scan",
});

/** The request's `Idempotency-Key`, so a redelivery settles the same reservation. */
function idempotencyKeyOf(request: CreditScopedRequest): string | undefined {
  const raw = request.headers?.["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 && value.length <= 255 ? value : undefined;
}
