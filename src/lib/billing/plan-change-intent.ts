import { pendingPlanChangeSchema, type PendingPlanChange, type PendingPlanChangeSummary } from "../../../contracts/billing/plan-change.schema.js";

// STORY-184 — reading `subscriptions.pending_plan_change` (jsonb). Fails CLOSED: a column that does not parse is not
// "no change pending" — acting on it would be acting on a guess — so callers get a distinct `malformed` and refuse.

export type PendingPlanChangeRead =
  | { readonly kind: "none" }
  | { readonly kind: "intent"; readonly intent: PendingPlanChange }
  | { readonly kind: "malformed" };

export function readPendingPlanChange(raw: unknown): PendingPlanChangeRead {
  if (raw === null || raw === undefined) return { kind: "none" };
  const parsed = pendingPlanChangeSchema.safeParse(raw);
  return parsed.success ? { kind: "intent", intent: parsed.data } : { kind: "malformed" };
}

/**
 * What `GET /billing/subscription` shows: only a change Stripe has ACCEPTED (`settled_at`). An intent whose outcome is
 * unknown is internal, and a client banner offering to cancel something that may not exist would be a lie.
 */
export function summarizePendingPlanChange(raw: unknown): PendingPlanChangeSummary | null {
  const read = readPendingPlanChange(raw);
  if (read.kind !== "intent" || read.intent.settled_at === undefined) return null;
  return { direction: read.intent.direction, target_plan_key: read.intent.to_plan_key, effective_at: read.intent.effective_at };
}
