import { Injectable, Logger } from "@nestjs/common";
import { emailAlertAndWait } from "../../../lib/alerts/alerts.js";
import type { ChainMismatchAlert, PagingNotifier } from "../ports/paging-notifier.js";

// Group C — no longer log-only: the page is ALSO emailed through the EMAIL_SENDER port when ALERT_EMAIL_TO is set (the
// name is historical; the logging is kept). PagerDuty remains out of scope per the owner's 2026-10-15 decision.
// STORY-020 D-2 — stub. Real target is PagerDuty; no paging client exists in
// this repo yet (disclosed gap STORY-020-E-4). Logs and returns — the calling
// worker script (audit-verify.ts) decides process.exitCode, not this class.

@Injectable()
export class LoggingPagingNotifier implements PagingNotifier {
  private readonly logger = new Logger(LoggingPagingNotifier.name);

  async page(alert: ChainMismatchAlert): Promise<void> {
    this.logger.error(
      `audit chain mismatch: workspaceId=${alert.workspaceId} seq=${alert.seq} reason=${alert.reason}`,
    );
    // Group C — also emailed when ALERT_EMAIL_TO is configured. Ids and an enum-like reason only, never row content. The
    // verifier script exits right after paging, so this waits for the mail to settle; it cannot reject.
    await emailAlertAndWait(`audit chain mismatch for workspace ${alert.workspaceId}`, {
      alertName: "audit_chain_mismatch",
      workspaceId: alert.workspaceId,
      seq: alert.seq,
      reason: alert.reason,
    });
  }
}
