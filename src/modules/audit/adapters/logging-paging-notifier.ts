import { Injectable, Logger } from "@nestjs/common";
import type { ChainMismatchAlert, PagingNotifier } from "../ports/paging-notifier.js";

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
    await Promise.resolve();
  }
}
