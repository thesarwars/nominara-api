import type { ClientBase } from "pg";
import { grantCredits } from "../credits/balance.js";
import { rollIncludedCycle } from "../credits/cycle-roll.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import {
  DowngradeNotSupportedError,
  NegotiatedTierRefusedError,
  NoActiveSubscriptionError,
  PlanChangeTargetMissingError,
  UnknownPlanError,
  WorkspaceLockBusyError,
} from "./errors.js";
import { lockWorkspaceBounded } from "./workspace-lock.js";
import { proRataTopUp, utcMidnight } from "./plan-grant.js";

// STORY-151 — a workspace's plan can change. Nothing in this product could do
// that before, and that single absence made the whole product unreachable:
// `WorkspacesService.create` writes `plan_key` as the literal 'free', free's
// `projects.max` is 0, `POST /v1/projects` is gated on it, and `wouldExceed`
// is `current >= limit`, so every workspace that could exist was refused at
// project creation. Every integration spec hand-writes `plan_key 'growth'` to
// get around it, which is why ~330 spec files never caught it.
//
// ⚠ THERE IS NO ROUTE, AND THAT ABSENCE IS THE SAFETY MECHANISM.
// `billing:write` is held by every workspace OWNER, so an ordinary tenant
// route would let any customer grant themselves Business for free. The
// alternative considered was an environment gate with the shape of
// OTP_DEV_LOG_CODES — and a gate is a PREDICATE that must evaluate correctly
// on every production process across every future config change, failing
// silently and totally. This is an ABSENCE instead: `applyPlanChange` is
// imported by no controller, guard, interceptor or queue handler, so there is
// no route to call, no permission to hold and no NODE_ENV to be wrong about.
// Breaking the property requires writing and merging new code, which is a
// reviewable event — and test/unit/billing/plan-change-import-surface.spec.ts
// turns it into a red build.
//
// ⚠ RLS IS NOT THE CONTROL HERE AND THIS COMMENT WILL NOT PRETEND IT IS.
// `ws_isolation_workspaces` is `USING (id = app.current_workspace())`, so a
// workspace updating its OWN plan_key under its own tenant context PASSES.
// (An earlier draft of this comment claimed test/isolation asserted that by
// name. It did not — the test was never written. A comment that invents a
// control is worse than no comment, so the claim is gone and the fact stays.)
// `subscriptions.provider` (migration 0026) is the detective control for what
// prevention cannot reach.
//
// ⚠ AND IT RUNS AS `nominara_app` UNDER ORDINARY TENANT CONTEXT, deliberately.
// The CLI's privilege is possession of the shell and the connection string,
// not a database role — so STORY-075's webhook handler will execute this
// function byte-identically, with a different reconciler and a different
// provenance, and inherit every property proven here.

/** The statuses `ux_subscriptions_active` treats as live — at most one per workspace. */
const LIVE_SUBSCRIPTION_STATUSES = ["trialing", "active", "past_due"] as const;

/** Priced by contract, resolves to unlimited, and `sort_order` can never refuse it. */
const NEGOTIATED_TIERS = new Set(["enterprise"]);

export type BillingInterval = "monthly" | "annual";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "incomplete" | "paused";

/**
 * A subscription's WHOLE state — closed, every field required.
 *
 * ⚠ A TYPE THAT CANNOT EXPRESS A DELTA IS A STRONGER GUARANTEE THAN A COMMENT
 * SAYING NOT TO WRITE ONE. STORY-075's technical notes call fresh-fetch
 * wholesale reconciliation "the decision that makes webhook handling robust",
 * because providers deliver out of order and redeliver freely, and a handler
 * that applies an update as a diff produces an end state that depends on
 * arrival order — an intermittent, unreproducible bug. Making every field
 * required means the webhook cannot accidentally write a partial record, and
 * it is why `planKeyOnly` has to carry every other column forward explicitly.
 */
export interface ProviderSubscriptionState {
  readonly provider: "operator" | "stripe";
  readonly providerCustomerId: string;
  readonly providerSubscriptionId: string;
  readonly planKey: string;
  readonly billingInterval: BillingInterval;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  readonly currentPeriodEnd: Date;
  readonly trialEndsAt: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly seatsPurchased: number;
  readonly projectsPurchased: number;
}

/** Given what is stored, return what should be stored — the whole record. */
export type SubscriptionReconciler = (current: Readonly<ProviderSubscriptionState>) => ProviderSubscriptionState;

/** Who did this and why — onto the audit row, so a change is never anonymous. */
export interface ChangeProvenance {
  /** The operator's `--ticket`, or the provider's event id. Lands in `audit_log.request_id`. */
  readonly requestId: string;
  /** The operator's identifier, or "stripe-webhook". */
  readonly operator: string;
  readonly reason: string;
}

export interface PlanChangeOutcome {
  readonly changed: boolean;
  readonly from: string;
  readonly to: string;
  readonly entitlementVersion: number;
  readonly creditsToppedUp: number;
  /** Set when the top-up was skipped for a reason worth printing. */
  readonly creditsNote?: string;
}

export interface ApplyPlanOptions {
  /** Grant a contract-priced, unlimited tier. Off unless an operator says so. */
  readonly allowNegotiatedTier?: boolean;
  /** Injected so the pro-rata boundary is testable; never read from the clock here. */
  readonly now?: Date;
  /**
   * STORY-075 AC8 — accept a move to a LOWER plan. Off unless the writer is the
   * signature-verified webhook reconciler: there the provider has already
   * ended or reduced the subscription, so refusing would leave the workspace
   * on a plan nobody is paying for. It changes FEATURE ACCESS only; the
   * structural reductions (pausing excess projects and prompts, the retention
   * tier) are STORY-077's period-end policy and are recorded on the audit row
   * as deferred, never performed here.
   */
  readonly allowDowngrade?: boolean;
}

/** The UTC calendar day of an instant, as the `YYYY-MM-DD` the wallet's `date` columns take. */
function utcDate(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The only reconciler STORY-151 ships: change the plan, carry everything else forward. */
export function planKeyOnly(planKey: string, billingInterval?: BillingInterval): SubscriptionReconciler {
  return (current) => ({ ...current, planKey, billingInterval: billingInterval ?? current.billingInterval });
}

interface WorkspaceRow {
  plan_key: string;
  entitlement_version: number;
  status: string;
  deleted_at: Date | null;
}

interface SubscriptionRow {
  id: string;
  plan_key: string;
  billing_interval: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  status: string;
  current_period_start: Date;
  current_period_end: Date;
  trial_ends_at: Date | null;
  cancel_at_period_end: boolean;
  seats_purchased: number;
  projects_purchased: number;
  provider: string;
}

function toState(row: SubscriptionRow): ProviderSubscriptionState {
  return {
    // A row that has never been through here is 'none'; the reconciler must
    // name a real writer, so 'none' is not in the outgoing union.
    provider: row.provider === "stripe" ? "stripe" : "operator",
    providerCustomerId: row.stripe_customer_id,
    providerSubscriptionId: row.stripe_subscription_id,
    planKey: row.plan_key,
    billingInterval: row.billing_interval === "annual" ? "annual" : "monthly",
    status: row.status as SubscriptionStatus,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    cancelAtPeriodEnd: row.cancel_at_period_end,
    seatsPurchased: row.seats_purchased,
    projectsPurchased: row.projects_purchased,
  };
}

/**
 * Moves a workspace onto `reconcile`'s plan, in ONE transaction.
 *
 * Caller supplies an open transaction with tenant context already set for
 * `workspaceId` — the same shape `AuditChainService.append` requires, and the
 * same one STORY-075's webhook handler will have.
 */
export async function applyPlanChange(
  tx: ClientBase,
  workspaceId: string,
  reconcile: SubscriptionReconciler,
  provenance: ChangeProvenance,
  options: ApplyPlanOptions = {},
): Promise<PlanChangeOutcome> {
  // ⚠ NO ADVISORY LOCK IS TAKEN HERE, AND TAKING ONE CAUSED A DEADLOCK.
  //
  // The first version opened with `pg_advisory_xact_lock(hashtextextended(ws))`
  // to serialise the read-modify-write. That inverts the lock order the whole
  // request pipeline uses: `CreditInterceptor` takes the `credit_wallets` ROW
  // lock first (credit.interceptor.ts:291 → wallet.ts's `FOR UPDATE`) and the
  // advisory chain lock second, when `AuditInterceptor` appends — an ordering
  // api.module.ts:107-123 states explicitly and calls load-bearing. Taking the
  // advisory lock first here and the wallet row lock at step 8 reversed it, and
  // a second-engineer review reproduced `40P01 deadlock detected` with the
  // CUSTOMER'S request as the victim: the reservation already committed, the
  // engine already spent, and the settle transaction killed.
  //
  // It also bought nothing. `workspaces … FOR UPDATE` below already serialises
  // two concurrent plan changes — verified with four simultaneous calls — and
  // `AuditChainService.append` takes the same advisory lock itself at step 9,
  // so the chain is still serialised where it matters. Rows first, advisory
  // second: the canonical order every other writer uses.

  // 1. The workspace, locked. Its pre-image is the audit row's before_state —
  //    the first populated one in this repo: `auditBeforeState` is declared on
  //    the interceptor and read by it, and set by nothing.
  //    The wait is bounded (checkpoint-6): the holder of this row may be inside a Stripe call.
  await lockWorkspaceBounded(tx, workspaceId, () => new WorkspaceLockBusyError(workspaceId));
  const workspace = await tx.query<WorkspaceRow>(
    "SELECT plan_key, entitlement_version, status, deleted_at FROM workspaces WHERE id = $1 FOR UPDATE",
    [workspaceId],
  );
  const before = workspace.rows[0];
  if (before === undefined) throw new PlanChangeTargetMissingError(workspaceId, "no such workspace");
  if (before.deleted_at !== null) throw new PlanChangeTargetMissingError(workspaceId, "it is deleted");
  if (before.status === "pending_deletion") {
    throw new PlanChangeTargetMissingError(workspaceId, "it is pending deletion");
  }

  // 2. Both plans. `plans` is a GLOBAL table — no RLS — so tenant context does
  //    not hide it. This is also where the cycle grants come from for step 7.
  //
  //    ⚠ NOT GATED ON `is_public`. The seed INSERT lists only
  //    (key, display_name, monthly_price, annual_price, credits_per_cycle,
  //    sort_order, entitlements), so `is_public` defaults TRUE for every plan
  //    including enterprise — a check on it would be vacuous today and read
  //    like a control.
  const plans = await tx.query<{ key: string; sort_order: number; credits_per_cycle: number }>(
    "SELECT key, sort_order, credits_per_cycle FROM plans",
  );
  const byKey = new Map(plans.rows.map((row) => [row.key, row]));

  // 3. The live subscription, locked. NEVER inserted — see NoActiveSubscriptionError.
  const subscription = await tx.query<SubscriptionRow>(
    `SELECT id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id, status,
            current_period_start, current_period_end, trial_ends_at, cancel_at_period_end,
            seats_purchased, projects_purchased, provider
       FROM subscriptions
      WHERE workspace_id = $1 AND status = ANY($2::text[])
      FOR UPDATE`,
    [workspaceId, [...LIVE_SUBSCRIPTION_STATUSES]],
  );
  const currentRow = subscription.rows[0];
  if (currentRow === undefined) throw new NoActiveSubscriptionError(workspaceId);

  const current = toState(currentRow);
  const desired = reconcile(current);

  const targetPlan = byKey.get(desired.planKey);
  if (targetPlan === undefined) throw new UnknownPlanError(desired.planKey, [...byKey.keys()]);
  const currentPlan = byKey.get(before.plan_key);
  if (currentPlan === undefined) throw new UnknownPlanError(before.plan_key, [...byKey.keys()]);

  // 4. NO-OP GATE, and it is not tidiness. A version bump is a workspace-wide
  //    soft logout — every member's live token 401s `entitlement_stale` — so
  //    re-running a grant that already holds must not log everyone out twice.
  const planUnchanged = before.plan_key === desired.planKey && currentRow.plan_key === desired.planKey;
  const recordUnchanged = JSON.stringify(current) === JSON.stringify(desired);
  if (planUnchanged && recordUnchanged) {
    return {
      changed: false,
      from: before.plan_key,
      to: desired.planKey,
      entitlementVersion: before.entitlement_version,
      creditsToppedUp: 0,
    };
  }

  // 5. DIRECTION, then the negotiated tier by name — the order matters,
  //    because `sort_order` can never refuse enterprise (it is the maximum).
  const isDowngrade = targetPlan.sort_order < currentPlan.sort_order;
  if (isDowngrade && options.allowDowngrade !== true) {
    throw new DowngradeNotSupportedError(before.plan_key, desired.planKey);
  }
  if (NEGOTIATED_TIERS.has(desired.planKey) && options.allowNegotiatedTier !== true) {
    throw new NegotiatedTierRefusedError(desired.planKey);
  }

  // 6. The subscription, WHOLESALE — every reconciled column from a complete
  //    record. This is STORY-075's "reconciled from a fresh fetch, never
  //    applied as a delta" with the fetch removed, and it is the statement its
  //    webhook will execute unchanged.
  await tx.query(
    `UPDATE subscriptions
        SET plan_key = $2, billing_interval = $3, status = $4,
            current_period_start = $5, current_period_end = $6, trial_ends_at = $7,
            cancel_at_period_end = $8, seats_purchased = $9, projects_purchased = $10,
            stripe_customer_id = $11, stripe_subscription_id = $12,
            provider = $13, updated_at = now()
      WHERE id = $1`,
    [
      currentRow.id,
      desired.planKey,
      desired.billingInterval,
      desired.status,
      desired.currentPeriodStart,
      desired.currentPeriodEnd,
      desired.trialEndsAt,
      desired.cancelAtPeriodEnd,
      desired.seatsPurchased,
      desired.projectsPurchased,
      desired.providerCustomerId,
      desired.providerSubscriptionId,
      desired.provider,
    ],
  );

  // 6b. THE BILLING CYCLE ROLLED: a period that starts LATER than the one on file IS the roll (this statement is the
  //     only writer of `current_period_start`). Strictly later: a redelivery of the same period and a stale event for
  //     an earlier one change nothing, and a reconcile inside the period (seats, an add-on, a cancel flag) never
  //     reaches here with a new start.
  //
  //     STORY-072 AC13 — plans-and-entitlements.md §5 "Grant refresh": the included bucket is RESET to the plan's
  //     grant and the unused credits expire (`rollIncludedCycle`; one `expire` and one `grant` ledger entry, the
  //     auto-top-up counter restarted in the same statement per EC-48). The grant is the plan being moved TO, so a
  //     downgrade that lands at the period end resets to the lower grant.
  //
  //     ⚠ NOT FOR AN UPGRADE. §5's mid-cycle upgrade is a pro-rata top-up that "never reduces" the balance, and it
  //     has a step of its own below (8); a period that advances alongside an upgrade (a first paid subscription
  //     replacing free's synthetic period) must not turn that into a reset that expires credits the customer holds.
  //     The wallet's cycle then moves at the next renewal, which is a plain period advance. Without a wallet yet
  //     there is nothing to roll: the first provisioning grants the new plan in full.
  const periodAdvanced = desired.currentPeriodStart.getTime() > currentRow.current_period_start.getTime();
  const isUpgrade = targetPlan.sort_order > currentPlan.sort_order;
  let cycleRolled = false;
  if (periodAdvanced && !isUpgrade) {
    const rolled = await rollIncludedCycle(tx, {
      workspaceId,
      grant: targetPlan.credits_per_cycle,
      cycleStart: utcDate(desired.currentPeriodStart),
      cycleEnd: utcDate(desired.currentPeriodEnd),
    });
    cycleRolled = rolled.rolled;
  }
  if (periodAdvanced && !cycleRolled) {
    // Auto-top-up's per-cycle counter still restarts with the subscription's period (EC-48 "the counter resets only
    // at cycle roll"; NEW-D-7 checkpoint-3 finding 3) when the wallet itself was not rolled above — an upgrade
    // carrying a new period, or a wallet whose own cycle is already current. Only the counter moves: the
    // configuration is the customer's. No wallet yet: zero rows, no error.
    await tx.query(
      "UPDATE credit_wallets SET auto_topup_count_cycle = 0, updated_at = now() WHERE workspace_id = $1 AND auto_topup_count_cycle <> 0",
      [workspaceId],
    );
  }

  // 7. ⚠ ONE STATEMENT, AND THIS IS THE ONLY CORRECTNESS-CRITICAL CO-CHANGE.
  //    `entitlementsKey(env, ws, version)` puts the version IN the cache key,
  //    so the bump IS the invalidation — there is no invalidate() to call or
  //    forget. Two statements would let a reader observe (new plan, old
  //    version) and poison `{env}:{ws}:ent:{old_v}` with the new map for its
  //    whole TTL, across every instance.
  const bumped = await tx.query<{ plan_key: string; entitlement_version: number }>(
    `UPDATE workspaces
        SET plan_key = $2, entitlement_version = entitlement_version + 1, updated_at = now()
      WHERE id = $1
      RETURNING plan_key, entitlement_version`,
    [workspaceId, desired.planKey],
  );
  const after = bumped.rows[0]!;

  // 8. §5's pro-rata top-up. See plan-grant.ts for why this is arithmetic and
  //    not a question for a human.
  let creditsToppedUp = 0;
  let creditsNote: string | undefined;
  // ⚠ `to_char`, NOT THE RAW COLUMNS, AND THIS IS A BUG THE CODEBASE HAD
  // ALREADY FIXED ONCE. `credit_wallets.cycle_start/cycle_end` are `date`, and
  // node-postgres parses `date` into a JS Date at LOCAL midnight. wallet.ts:83
  // documents exactly this trap — "Every query below asks for `to_char` so
  // there is no Date to..." — after a previous second-engineer review caught
  // the production read keeping it. This write path reintroduced it, and here
  // it MINTS CREDITS rather than rendering a date a day early:
  //
  //   TZ=UTC              half-way through a cycle → 570  (correct)
  //   TZ=America/New_York                          → 576  (+6 free credits)
  //   TZ=America/New_York  three hours PAST the end → 1    (into an ended cycle)
  //
  // `us-east-1` is the default and only region for free/starter/growth, so the
  // realistic deployment is the one that over-grants — and `credits:verify`
  // can never see it, because the wallet and the ledger agree. Only the AMOUNT
  // is wrong, which is the kind of defect that is found by an auditor or not
  // at all.
  const wallet = await tx.query<{ cycle_start: string; cycle_end: string }>(
    `SELECT to_char(cycle_start, 'YYYY-MM-DD') AS cycle_start,
            to_char(cycle_end,   'YYYY-MM-DD') AS cycle_end
       FROM credit_wallets WHERE workspace_id = $1 FOR UPDATE`,
    [workspaceId],
  );
  const cycle = wallet.rows[0];
  if (cycle === undefined) {
    // Wallets are provisioned lazily on first credit use, so a workspace that
    // has never spent has none. Skipping is correct — the first provisioning
    // grants the NEW plan's full amount — and saying so beats a silent zero.
    creditsNote = "no credit wallet yet; the first provisioning will grant the new plan in full";
  } else {
    const topUp = proRataTopUp(
      currentPlan.credits_per_cycle,
      targetPlan.credits_per_cycle,
      // UTC instants, so the boundary means the same thing wherever the
      // process runs. See utcMidnight for why it is built rather than parsed.
      utcMidnight(cycle.cycle_start),
      utcMidnight(cycle.cycle_end),
      options.now ?? new Date(),
    );
    if (topUp > 0) {
      await grantCredits(
        tx,
        {
          workspaceId,
          // ⚠ DETERMINISTIC, AND KEYED ON THE VERSION WE JUST MINTED. The
          // version is monotonic and bumped in this same transaction, so a
          // redelivery, a resync or a re-run writes nothing. That key is
          // exactly what the deleted `refreshIncludedGrant` lacked — its
          // tombstone in wallet.ts reproduces the minting bug it caused.
          idempotencyKey: `grant:plan_change:${workspaceId}:${String(after.entitlement_version)}`,
          actorId: null,
          actorType: "system",
          referenceType: "plan_change",
          // ⚠ NO `referenceId`. `credit_ledger.reference_id` is `uuid`
          // (migration 0002:394) and `provenance.requestId` is an operator's
          // free-text `--ticket` or a provider event id like `evt_1abc…` —
          // neither is a UUID, and passing one raised `22P02` which ABORTED
          // THE WHOLE PLAN CHANGE. It only ever succeeded on a workspace with
          // no wallet, because that path never reaches grantCredits, and every
          // test in this story took exactly that path. The ticket is on the
          // audit row, whose `request_id` is `text` and which is the record
          // that is supposed to carry provenance.
        },
        topUp,
      );
      creditsToppedUp = topUp;
    }
  }

  // 9. The audit row, INSIDE the transaction. A commit that changed the plan
  //     and bumped the version with no audit row is the worst outcome
  //     available here, so an audit failure must roll the plan change back.
  await new AuditChainService().append(tx, {
    workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: `operator:${provenance.operator}`,
    action: "workspace.plan_changed",
    resourceType: "workspace",
    resourceId: workspaceId,
    beforeState: {
      plan_key: before.plan_key,
      entitlement_version: before.entitlement_version,
      subscription: current,
    },
    afterState: {
      plan_key: after.plan_key,
      entitlement_version: after.entitlement_version,
      subscription: desired,
      operator: provenance.operator,
      reason: provenance.reason,
      credits_topped_up: creditsToppedUp,
      ...(isDowngrade ? { downgrade: { feature_access: "applied", structural_reductions: "deferred_to_story_077" } } : {}),
      ...(creditsNote === undefined ? {} : { credits_note: creditsNote }),
    },
    requestId: provenance.requestId,
    supportGrantId: null,
    // Legal per audit_log's CHECK (info, notice, warning, critical). A plan
    // change is not routine 'info' and not an incident — it moves what a
    // customer is entitled to and is expected to be read.
    severity: "notice",
  });

  return {
    changed: true,
    from: before.plan_key,
    to: after.plan_key,
    entitlementVersion: after.entitlement_version,
    creditsToppedUp,
    ...(creditsNote === undefined ? {} : { creditsNote }),
  };
}
