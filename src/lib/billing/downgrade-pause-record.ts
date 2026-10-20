import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import type { EmailMessage } from "../../modules/identity/ports/email-sender.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { reconcileDowngradePause } from "./downgrade-pause.js";
import { downgradeNoticeContact, downgradePausedEmail, downgradeResumedEmail } from "./downgrade-pause-notice.js";

// STORY-077 slice A — the cut-over (and any later upgrade) as ONE step that EVERY plan writer runs, inside its own
// tenant-context transaction, right after the plan is adopted:
//   * the Stripe webhook (stripe-subscription.handler.ts), after the plan and add-ons are adopted;
//   * the operator CLI `plan:set` (workers/billing/plan-set.ts), after `applyPlanChange` - a comp after a cancellation
//     to Free must resume what the cancellation paused (AC5, "resume automatically on a later upgrade").
// It reconciles the pause (downgrade-pause.ts), audits each direction on the hash chain, and RETURNS the notices: the
// caller sends them only after its transaction commits, so a rolled-back change never emails.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("billing.downgrade_pause");

export interface PauseProvenance {
  /** The provider's event id or the operator's ticket: `audit_log.request_id`. */
  readonly requestId: string;
  /** "stripe-webhook" or the operator: `audit_log.actor_ua` is `operator:<this>`. */
  readonly operator: string;
}

/** Reconciles, audits and returns the emails to send after the commit (none when nothing moved). */
export async function reconcileAndRecordDowngradePause(tx: ClientBase, workspaceId: string, provenance: PauseProvenance): Promise<EmailMessage[]> {
  return await tracer.startActiveSpan("billing.downgrade_pause.reconcile", async (span) => {
    try {
      const result = await reconcileDowngradePause(tx, workspaceId);
      const pausedCount = result.paused.projects.length + result.paused.prompts.length;
      const resumedCount = result.resumed.projects.length + result.resumed.prompts;
      span.setAttributes({ "nominara.downgrade_pause.paused": pausedCount, "nominara.downgrade_pause.resumed": resumedCount });
      if (pausedCount === 0 && resumedCount === 0) return [];

      const audit = new AuditChainService();
      const append = (action: string, afterState: Record<string, unknown>) =>
        audit.append(tx, {
          workspaceId,
          actorType: "system",
          actorId: SYSTEM_ACTOR_ID,
          actorIp: null,
          actorUa: `operator:${provenance.operator}`,
          action,
          resourceType: "workspace",
          resourceId: workspaceId,
          beforeState: null,
          afterState,
          requestId: provenance.requestId,
          supportGrantId: null,
          severity: "notice",
        });
      if (pausedCount > 0) {
        // NAMES and counts, not ids: the audit redactor (lib/crypto/redact.ts) treats any long high-entropy string as a
        // secret, so a UUID in before/after_state is stored as "[redacted]". The rows themselves carry the marker.
        await append("billing.downgrade.paused", { project_count: result.paused.projects.length, project_names: result.paused.projects.map((p) => p.name), prompt_count: result.paused.prompts.length });
        incrementCounter("nominara_billing_downgrade_pause_total", { direction: "paused" });
      }
      if (resumedCount > 0) {
        await append("billing.downgrade.resumed", { project_count: result.resumed.projects.length, project_names: result.resumed.projects.map((p) => p.name), prompt_count: result.resumed.prompts });
        incrementCounter("nominara_billing_downgrade_pause_total", { direction: "resumed" });
      }
      logger.log({ message: "downgrade pause reconciled", request_id: provenance.requestId, workspace_id: workspaceId, paused: pausedCount, resumed: resumedCount });

      const contact = await downgradeNoticeContact(tx, workspaceId);
      if (contact === null) {
        incrementCounter("nominara_billing_downgrade_notice_failed_total", { reason: "no_billing_contact" });
        logger.error({ message: "downgrade pause reconciled but nobody could be emailed: no billing contact", workspace_id: workspaceId });
        return [];
      }
      const plan = await tx.query<{ display_name: string }>("SELECT p.display_name FROM workspaces w JOIN plans p ON p.key = w.plan_key WHERE w.id = $1", [workspaceId]);
      const planName = plan.rows[0]?.display_name ?? "new";
      return [downgradePausedEmail(contact, planName, result.paused), downgradeResumedEmail(contact, planName, result.resumed)].filter((m): m is EmailMessage => m !== null);
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Sends the notices after the commit. The pause is committed and audited, and the product shows it: a failed send is logged and counted, never thrown. */
export async function sendDowngradeNotices(send: (message: EmailMessage) => Promise<void>, workspaceId: string, notices: readonly EmailMessage[]): Promise<void> {
  for (const message of notices) {
    try {
      await send(message);
    } catch {
      incrementCounter("nominara_billing_downgrade_notice_failed_total", { reason: "send_failed" });
      logger.error({ message: "downgrade pause notice could not be sent", workspace_id: workspaceId });
    }
  }
}
