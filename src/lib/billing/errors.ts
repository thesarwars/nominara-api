// STORY-151 — refusals from the operator plan-change path.
//
// ⚠ PLAIN `Error`s, NOT `DomainError`s, DELIBERATELY. A `DomainError` carries
// an `ErrorCode` from §2's closed taxonomy and a status code, because it is
// going onto the wire in an RFC 9457 envelope. Nothing here ever does: there
// is no route, and the only caller is a CLI an operator reads on a terminal.
// Minting taxonomy codes for operator-facing refusals would put values in
// contracts/common/error-code.schema.ts that no client can ever receive, and
// test/unit/error-taxonomy.spec.ts keeps an independent copy of that table
// which would then need transcribing for a code that cannot happen.
//
// Each one names the thing it refused, because the reader is a person holding
// a ticket reference and a half-finished upgrade.

export class UnknownPlanError extends Error {
  constructor(planKey: string, known: readonly string[]) {
    super(`no such plan "${planKey}" — known plans are ${known.join(", ")}`);
    this.name = "UnknownPlanError";
  }
}

/** The workspace row is held by a billing change (it is inside a Stripe call): retry shortly. Thrown by writers that run outside a request (the plan-set worker, retention). */
export class WorkspaceLockBusyError extends Error {
  constructor(workspaceId: string) {
    super(`workspace ${workspaceId} is locked by another change: retry shortly`);
    this.name = "WorkspaceLockBusyError";
  }
}

export class PlanChangeTargetMissingError extends Error {
  constructor(workspaceId: string, reason: string) {
    super(`workspace ${workspaceId} cannot take a plan change: ${reason}`);
    this.name = "PlanChangeTargetMissingError";
  }
}

/**
 * ⚠ NEVER INSERTS ONE. `ux_subscriptions_active` is a partial unique index
 * allowing at most one live subscription per workspace, and a workspace
 * without one is a defect to surface — `WorkspacesService.create` writes the
 * row in the same transaction as the workspace, so its absence means either
 * that transaction half-committed or something deleted it. Papering over it
 * with an INSERT would hide whichever it was.
 */
export class NoActiveSubscriptionError extends Error {
  constructor(workspaceId: string) {
    super(
      `workspace ${workspaceId} has no subscription in (trialing, active, past_due) — ` +
        `every workspace gets one at creation, so this is a data defect rather than a missing upgrade`,
    );
    this.name = "NoActiveSubscriptionError";
  }
}

/**
 * ⚠ THERE IS NO DOWNGRADE PATH AT ALL, INCLUDING TO REVERSE A MISTAKEN
 * UPGRADE. That is accepted and visible rather than hidden: a downgrade is not
 * a plan write, it is §14's period-end cut-over — "the system pauses — never
 * deletes — the most recently created excess projects and prompts, retains all
 * their data under the new retention tier, and emails the list" — and doing
 * the write without that policy would silently strand a customer over their
 * new limits with no notice and no chooser. STORY-077 owns it.
 *
 * Reversing a mistake meanwhile is a hand-written statement plus a manually
 * appended audit row under the same ticket. A mistaken upgrade fails in the
 * customer-favourable direction, which is why that is tolerable.
 */
export class DowngradeNotSupportedError extends Error {
  constructor(from: string, to: string) {
    super(
      `refusing ${from} → ${to}: a downgrade is not a plan write. §14 requires the period-end ` +
        `cut-over that pauses excess projects and prompts and notifies the customer — STORY-077 owns it`,
    );
    this.name = "DowngradeNotSupportedError";
  }
}

/**
 * ⚠ REFUSED BY NAME, BECAUSE THE DIRECTION CHECK CANNOT CATCH IT. Enterprise
 * is seeded at `sort_order 4` — the maximum — so `sort_order(target) <
 * sort_order(current)` never fires for it, and it is simultaneously the
 * highest-value grant available: `"projects.max": "custom"` resolves to
 * `{kind: "unlimited"}`, on a plan seeded at `monthly_price 0` whose real
 * price is negotiated per contract. Granting the unlimited tier must be a
 * separate deliberate act, not one flag value away from an ordinary upgrade.
 */
export class NegotiatedTierRefusedError extends Error {
  constructor(planKey: string) {
    super(
      `refusing to grant "${planKey}": it resolves to unlimited and is priced by contract. ` +
        `Pass allowNegotiatedTier with a ticket reference to grant it deliberately`,
    );
    this.name = "NegotiatedTierRefusedError";
  }
}
