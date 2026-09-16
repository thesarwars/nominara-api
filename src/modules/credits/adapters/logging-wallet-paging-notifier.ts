import { Injectable, Logger } from "@nestjs/common";
import type { WalletMismatch } from "../../../lib/credits/replay.js";
import type { WalletPagingNotifier } from "../ports/wallet-paging-notifier.js";

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
    await Promise.resolve();
  }
}

function describe(balance: { included: number; purchased: number; reserved: number }): string {
  return `[included ${String(balance.included)}, purchased ${String(balance.purchased)}, reserved ${String(balance.reserved)}]`;
}
