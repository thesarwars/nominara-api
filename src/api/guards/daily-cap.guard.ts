import { CanActivate, ExecutionContext, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { ClientBase, Pool } from "pg";
import { PG_POOL } from "../../db/pg-pool.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import {
  compensateDailyCounter,
  incrementDailyCounter,
  nextUtcMidnight,
} from "../../lib/usage/daily-cap.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import {
  DAILY_CAP_ENTITLEMENT,
  DAILY_CAP_KEY,
  type DailyCapAction,
} from "../decorators/daily-cap.decorator.js";
import { DailyLimitReachedError } from "../errors/domain-errors.js";
import type { WorkspaceScopedRequest } from "./workspace.guard.js";

// STORY-071 — replaces STORY-022's pass-through no-op. The slot is already
// correct: security-and-tenancy.md §5 puts DailyCapGuard after QuotaGuard and
// before CreditGuard, and api.module.ts has registered it there since
// STORY-022. This file adds the logic and touches no wiring.
//
// ⚠ THE CAP BINDS REGARDLESS OF BALANCE, and that is the whole story.
// `plans-and-entitlements.md` §2: "a pack raises the MONTHLY ceiling only.
// The daily cap still applies, so a pack is spent over many days —
// self-limiting." This guard reads `credit_daily_counters` and the plan's
// entitlements. It has no access to `credit_wallets` and no reason to want
// one, so a purchase cannot loosen it by any path.

/** §1's response headers — "only on plans with a daily cap; omitted otherwise". */
export const DAILY_LOOKUPS_HEADER = "x-nominara-daily-lookups";
export const DAILY_RESETS_AT_HEADER = "x-nominara-daily-resets-at";

/** What a downstream failure needs in order to give the increment back. */
export interface DailyCapCompensation {
  readonly workspaceId: string;
  readonly action: DailyCapAction;
}

export interface DailyCapScopedRequest extends WorkspaceScopedRequest {
  /**
   * AC6 — set when this guard consumed an allowance.
   *
   * The wallet reservation happens LATER in the request, in a slot STORY-072
   * fills, and the two do not share a transaction: this statement has already
   * committed by then so that a concurrent request can see it. So the undo
   * cannot be a rollback and has to be an explicit compensation, which is
   * what this hands forward. See `compensateDailyCounter`.
   */
  dailyCapCompensation?: DailyCapCompensation;
}

@Injectable()
export class DailyCapGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: EntitlementResolver,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.getAllAndOverride<DailyCapAction | undefined>(DAILY_CAP_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (action === undefined) return true;

    const request = context.switchToHttp().getRequest<DailyCapScopedRequest>();
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
      throw new Error(
        "route declares @DailyCap() but no workspace is resolved. A daily allowance is a property of a plan, " +
          "so the request is refused rather than allowed against a default.",
      );
    }

    const resolved =
      request.entitlementVersion === undefined
        ? await this.resolver.resolveForWorkspace(workspaceId)
        : await this.resolver.resolve(workspaceId, request.entitlementVersion);

    const limit = dailyLimitOf(resolved.entitlements, DAILY_CAP_ENTITLEMENT[action]);

    // AC9 — A TIER WITH NO DAILY CAP SKIPS THE COUNTER ENTIRELY. Writing an
    // effectively-infinite row would put a row per workspace per action per
    // day in the table for every paid customer, to answer a question that has
    // no answer on their plan. Only `free` carries a cap today.
    if (limit === null) return true;

    const outcome = await this.consume(workspaceId, action, limit);

    if (outcome === null) {
      // AC7 — the daily failure, AND IT DEBITS NOTHING. It cannot: the wallet
      // is two guards away and this throw stops the chain before CreditGuard
      // is reached at all.
      throw new DailyLimitReachedError({
        message: `today's ${action} allowance is used up`,
        details: {
          action_code: action,
          used: limit,
          limit,
          resets_at: nextUtcMidnight(new Date()),
        },
      });
    }

    // AC11 — exposed on the response so a client can render a daily limit and
    // a monthly one as the two separate things they are, without a second
    // call. Set here rather than in an interceptor because the numbers exist
    // only at this moment, and passing them forward to be re-read would be a
    // second source for one fact.
    setDailyHeaders(context, outcome.used, outcome.limit);

    request.dailyCapCompensation = { workspaceId, action };
    return true;
  }

  private async consume(workspaceId: string, action: DailyCapAction, limit: number) {
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx: ClientBase) =>
        incrementDailyCounter(tx, workspaceId, action, limit),
      );
    } finally {
      client.release();
    }
  }

  /**
   * AC6's other half, called by whatever raises the wallet failure.
   *
   * Exposed on the guard rather than buried in the module so the settlement
   * slot STORY-072 fills has one obvious thing to call, and so the ordering
   * requirement — increment first, compensate on failure — is readable in one
   * file instead of inferred from two.
   */
  async compensate(compensation: DailyCapCompensation): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(
        client,
        { workspaceId: compensation.workspaceId, actorId: SYSTEM_ACTOR_ID },
        (tx: ClientBase) => compensateDailyCounter(tx, compensation.workspaceId, compensation.action),
      );
    } finally {
      client.release();
    }
  }
}

/**
 * The limit, or null where the plan sets none.
 *
 * `null` in the entitlement means UNCAPPED — every paid tier carries
 * `credits.lookups_per_day_max: null`. A `0` would be a different claim
 * entirely (the action is not available at all) and is left to
 * `feature_not_in_plan`, exactly as QuotaGuard separates a zero cap from an
 * exhausted one: the remediation differs, upgrade versus wait.
 */
function dailyLimitOf(
  entitlements: Readonly<Record<string, { readonly value: unknown }>>,
  key: string,
): number | null {
  const value = entitlements[key]?.value;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function setDailyHeaders(context: ExecutionContext, used: number, limit: number): void {
  const response = context.switchToHttp().getResponse<{ header?: (name: string, value: string) => void }>();
  response.header?.(DAILY_LOOKUPS_HEADER, `${String(used)}/${String(limit)}`);
  response.header?.(DAILY_RESETS_AT_HEADER, nextUtcMidnight(new Date()));
}
