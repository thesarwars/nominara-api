import { Injectable, Logger } from "@nestjs/common";
import { emailAlertAndWait } from "../../../lib/alerts/alerts.js";
import type { WalletMismatch } from "../../../lib/credits/replay.js";
import type { WalletPagingNotifier } from "../ports/wallet-paging-notifier.js";

// Group C — no longer log-only: the page is ALSO emailed through the EMAIL_SENDER port when ALERT_EMAIL_TO is set (the
// name is historical; the logging is kept).
// STORY-073 D-1 — stub. Real target is PagerDuty; no paging client exists in
// this repo yet. Logs at error and returns — `credit-verify.ts` decides
// `process.exitCode`, not this class, the same division
// `LoggingPagingNotifier` and `audit-verify.ts` already use.

@Injectable()
export class LoggingWalletPagingNotifier implements WalletPagingNotifier {
  private readonly logger = new Logger(LoggingWalletPagingNotifier.name);

  async page(mismatch: WalletMismatch): Promise<void> {
    const at = mismatch.seq === null ? "no single entry" : `ledger seq ${mismatch.seq}`;
    const counter =
      mismatch.counter === null
        ? ""
        : ` lifetime_${mismatch.counter.counter}=${String(mismatch.counter.wallet)} ` +
          `replayed=${String(mismatch.counter.replayed)}`;
    this.logger.error(
      `credit wallet mismatch: workspaceId=${mismatch.workspaceId} at=${at} reason="${mismatch.reason}" ` +
        `wallet=${describe(mismatch.wallet)} replayed=${describe(mismatch.replayed)}${counter}`,
    );
    // Group C — also emailed when ALERT_EMAIL_TO is set. The balances are credit COUNTS; no actor, reference or request
    // key travels (same rule as this port's header). The script exits right after paging, so this waits; it cannot reject.
    await emailAlertAndWait(`credit wallet mismatch for workspace ${mismatch.workspaceId}`, {
      alertName: "wallet_ledger_mismatch",
      workspaceId: mismatch.workspaceId,
      seq: mismatch.seq ?? "none",
      reason: mismatch.reason,
      wallet_included: mismatch.wallet.included,
      wallet_purchased: mismatch.wallet.purchased,
      wallet_reserved: mismatch.wallet.reserved,
      replayed_included: mismatch.replayed.included,
      replayed_purchased: mismatch.replayed.purchased,
      replayed_reserved: mismatch.replayed.reserved,
      // A lifetime-counter mismatch (balances agree, a counter does not): which counter, and the two values.
      ...(mismatch.counter === null
        ? {}
        : { counter: mismatch.counter.counter, counter_wallet: mismatch.counter.wallet, counter_replayed: mismatch.counter.replayed }),
    });
  }
}

function describe(balance: { included: number; purchased: number; reserved: number }): string {
  return `[included ${String(balance.included)}, purchased ${String(balance.purchased)}, reserved ${String(balance.reserved)}]`;
}
