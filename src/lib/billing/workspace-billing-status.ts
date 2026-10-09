import type { ClientBase } from "pg";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";

// STORY-075b / STORY-075 AC10 — past-due handling sets the WORKSPACE status,
// which is what the capture scheduler reads (`w.status IN ('trialing','active')`,
// scheduler.ts). The subscription row already carries `past_due`; without this
// the scheduler would keep spending engine money on an account whose payment
// has failed.
//
// ⚠ ONLY THE BILLING PAIR MOVES: `trialing`/`active` <-> `past_due`. A workspace
// that is `soft_capped`, `suspended`, `pending_deletion` or `deleted` was put
// there by something stronger than a failed card, and a payment event must
// neither lift that restriction (past_due -> active would) nor mask it.
//
// The caller holds the workspace row lock (`SELECT … FOR UPDATE`), so the read
// below is the one the write is ordered by.

export interface BillingStatusChange {
  readonly changed: boolean;
  readonly from: string;
  readonly to: string;
}

export async function syncWorkspaceBillingStatus(
  tx: ClientBase,
  workspaceId: string,
  provenance: { readonly eventId: string; readonly eventType: string },
): Promise<BillingStatusChange | null> {
  const result = await tx.query<{ workspace_status: string; subscription_status: string }>(
    `SELECT w.status AS workspace_status, s.status AS subscription_status
       FROM workspaces w
       JOIN subscriptions s ON s.workspace_id = w.id AND s.status IN ('trialing','active','past_due')
      WHERE w.id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;

  const from = row.workspace_status;
  let to = from;
  if (row.subscription_status === "past_due" && (from === "active" || from === "trialing")) to = "past_due";
  else if ((row.subscription_status === "active" || row.subscription_status === "trialing") && from === "past_due") to = row.subscription_status;
  if (to === from) return { changed: false, from, to };

  await tx.query("UPDATE workspaces SET status = $2, updated_at = now() WHERE id = $1", [workspaceId, to]);
  await new AuditChainService().append(tx, {
    workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: "operator:stripe-webhook",
    action: "workspace.billing_status_changed",
    resourceType: "workspace",
    resourceId: workspaceId,
    beforeState: { status: from },
    afterState: { status: to, subscription_status: row.subscription_status, event_type: provenance.eventType },
    requestId: provenance.eventId,
    supportGrantId: null,
    // A failed payment is something the owner is expected to read, not routine.
    severity: to === "past_due" ? "warning" : "notice",
  });
  return { changed: true, from, to };
}
