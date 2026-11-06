import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { UnrecoverableError, type Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { LoggingWalletPagingNotifier } from "../../../modules/credits/adapters/logging-wallet-paging-notifier.js";
import type { WalletPagingNotifier } from "../../../modules/credits/ports/wallet-paging-notifier.js";
import { verifyAllWallets } from "../../../workers/rollup/credit-verify.js";
import { drainAlertEmails } from "../../alerts/alerts.js";
import type { WalletMismatch } from "../../credits/replay.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-073 AC4 - `credit.verify`: NFR-CRD-03, "a nightly job asserts equality and pages on mismatch".
//
// `verifyAllWallets` was complete (replay over `seq`, lifetime counters, a paging notifier) and ran only as
// `pnpm credits:verify`. This is the tick that runs it nightly. Same shape as `audit-verify.handler.ts`, for the same reasons:
//
//   * THE OWNER CONNECTION. The walk is cross-tenant and `credit_ledger` / `credit_wallets` carry FORCE ROW LEVEL SECURITY, so the
//     pooled `nominara_app` role would see zero rows and report a CLEAN estate - success, the worst outcome for an integrity check.
//   * SINGLE-FLIGHT by a session advisory lock taken as a TRY: concurrency 1 bounds one Worker, not the queue. A yielded tick loses
//     nothing because the next one asks the same question.
//   * THE PAGE IS SENT AFTER THE LOCK AND THE CONNECTION ARE GONE. Paging emails (up to ~90 s with retries); awaiting a provider
//     under an estate-wide lock would keep every other replica yielding.
//   * A MISMATCH FAILS THE JOB with `UnrecoverableError`: one walk, one page, one dead-letter entry a day. Decision 45 parks the
//     pager (there is none), so the failed job, the error log line and `nominara_credit_wallet_mismatch_total` ARE the hook an
//     alert will attach to; the infra remainder is listed as "infra (decision 45)".
//
// ⚠ IT CORRECTS NOTHING. `verifyAllWallets` imports no adjustment and writes no statement (a test records every statement and
// asserts none was attempted); this handler adds none. STORY-073 AC5: a discrepancy is resolved by a human-authored adjustment
// with a reason, never by the system rewriting a balance.

const tracer = trace.getTracer("nominara-api");

export function createCreditVerifyHandler(context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("credit.verify");

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    const collected: WalletMismatch[] = [];
    const collector: WalletPagingNotifier = {
      page: (mismatch) => {
        collected.push(mismatch);
        return Promise.resolve();
      },
    };
    try {
      await walkUnderLock(collector);
    } finally {
      if (collected.length > 0) {
        const notifier = new LoggingWalletPagingNotifier();
        for (const mismatch of collected) void notifier.page(mismatch);
        await drainAlertEmails();
      }
    }
  };

  async function walkUnderLock(notifier: WalletPagingNotifier): Promise<void> {
    await tracer.startActiveSpan("credit.verify", async (span) => {
      const client = await connect(withKeepalives(context.env.DATABASE_URL));
      const lockKey = globalQueueLockKey("credit.verify");
      let held = false;
      try {
        held = await tryAdvisorySessionLock(client, lockKey);
        if (!held) {
          span.setAttribute("nominara.credit_verify.yielded", true);
          incrementCounter("nominara_credit_wallet_verify_yielded_total");
          logger.warn("another replica holds the credit-verify lock; yielding this tick");
          return;
        }

        const result = await verifyAllWallets(client, notifier);
        span.setAttribute("nominara.credit_verify.workspaces_checked", result.checked);
        incrementCounter("nominara_credit_wallet_verify_runs_total");

        if (result.mismatch === null) {
          logger.log(`credit wallets verified: no mismatch across ${String(result.checked)} workspace(s)`);
          return;
        }

        const mismatch = result.mismatch;
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_credit_wallet_mismatch_total", { workspace_id: mismatch.workspaceId });
        // The workspace ID and the reason - never a name, and no balance owner. The balances travel in the page itself.
        logger.error(
          `credit wallet mismatch in workspace ${mismatch.workspaceId} at ${mismatch.seq === null ? "no single entry" : `ledger seq ${String(mismatch.seq)}`}: ${mismatch.reason}`,
        );
        throw new UnrecoverableError(
          `credit wallet mismatch in workspace ${mismatch.workspaceId} ` +
            `(${mismatch.seq === null ? "no single entry" : `seq ${String(mismatch.seq)}`}: ${mismatch.reason})`,
        );
      } catch (error) {
        if (!(error instanceof UnrecoverableError)) span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        // `client.end()` is what guarantees the release; the explicit unlock is the documentation (see credit-reconcile.handler.ts).
        if (held && !(await releaseAdvisorySessionLock(client, lockKey))) {
          logger.error("credit-verify lock was not held at release - the lock key or the connection changed under us");
        }
        await client.end();
        span.end();
      }
    });
  }
}
