import { Logger } from "@nestjs/common";
import { UnrecoverableError, type Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { LoggingPagingNotifier } from "../../../modules/audit/adapters/logging-paging-notifier.js";
import type { ChainMismatchAlert, PagingNotifier } from "../../../modules/audit/ports/paging-notifier.js";
import { drainAlertEmails } from "../../alerts/alerts.js";
import { verifyAllChains } from "../../../workers/rollup/audit-verify.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-143 — `security-and-tenancy.md` §12: "A verifier job re-walks each
// chain daily and pages on the first mismatch."
//
// ⚠ THE JOB WAS WRITTEN AND COULD NOT BE RUN BY ANYBODY. `verifyAllChains` has
// been complete since STORY-020 — cross-tenant discovery, the chain walk, the
// paging notifier, its own `main()` — and it had no handler, no schedule, and
// no pnpm script. It was reachable only from its own tests, while
// `credit-reconcile.ts` claimed it is "run exactly as `retention.ts`" (which
// has a script) and the EPIC-03 plan called it "the daily verifier". Both
// statements described something that had never happened once.
//
// That matters more here than in the four gaps before it. This is not
// housekeeping: the audit log is hash-chained so that tampering is
// DETECTABLE, and the verifier is the whole of the detection. An append-only
// trigger stops the ordinary path; it does not stop someone with table
// privileges, which is the threat the chain exists for. Unrun, the chain is a
// cost with no benefit — every row paying for a hash nobody checks.
//
// §4's queue table never allocated it a home, which is why it had none. The
// queue is declared in `topology.ts` as an explicit addition — see
// ADDED_BEYOND_REFERENCE in `test/unit/queue/topology.spec.ts`.

// ⚠ WHAT A "no mismatch" LINE STILL DOES NOT MEAN. The walk proves a chain is
// internally consistent; STORY-143 AC7 added a stored high-water mark
// (`audit_chain_marks`, migration 0123) so it also proves the chain is still
// the one the previous run saw. Two tampers that used to pass clean are now
// findings, each an `UnrecoverableError` like any other mismatch:
//
//   1. TAIL TRUNCATION — the head is behind the mark (`chain_truncated`), or the
//      row at the marked seq is gone / has another hash (`mark_hash_mismatch`,
//      which also catches a self-consistent rewrite and delete-then-regrow).
//   2. WHOLE-CHAIN DELETION — a marked workspace with no rows and no tombstone
//      (`chain_missing`). A hard-deleted workspace writes a tombstone in the
//      same transaction, so its absence is expected.
//
// Three things remain true and are deliberately not hidden:
//
//   a. A chain destroyed BEFORE any run ever marked it is invisible; the mark
//      can only remember what a run saw. The Object Lock export is the planned
//      second witness (decisions 2026-10-13). Pinned by AC7i.
//   b. ANYTHING BEFORE A RECHAINING MARKER. `verifyChain` trusts on-disk hashes
//      before the last marker (STORY-020-E-9, deliberate — erasure rewrites
//      content), so one forged marker moves the whole history into the lenient
//      zone permanently. The mark does not change that: it vouches for the head
//      and the hash at one position, not for content.
//   c. Someone who can write `audit_chain_marks` can lower it. That table is
//      owner-only — no runtime role has any privilege on it — which is why the
//      verifier must hold the owner connection below.

/**
 * ⚠ THE OWNER CONNECTION, because the verifier is cross-tenant by definition.
 * `listAuditedWorkspaceIds` has no workspace filter — it cannot, or it would
 * verify only whatever tenant happened to be in context — and `audit_log`
 * carries FORCE ROW LEVEL SECURITY, so the pooled `nominara_app` role would
 * see zero rows and report a clean estate. That is the same failure a review
 * reproduced against the credit reconciler, and it reports SUCCESS, which is
 * the worst available outcome for an integrity check.
 *
 * Keepalives for the same reason `credit.reconcile` carries them: the session
 * advisory lock below is held for the length of a full estate walk, and a
 * partitioned replica would otherwise strand it for the OS default of two
 * hours, during which every other replica's tick yields and nothing is
 * verified at all.
 */
export function createAuditVerifyHandler(context: QueueHandlerContext): JobProcessor {
  const logger = new Logger("audit.verify");

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    // Group C — PAGES ARE SENT AFTER THE LOCK IS RELEASED, never under it. Paging now emails (Resend: up to ~90 s per
    // send with retries, several alerts per run), and the session advisory lock below is held for the whole estate walk:
    // awaiting a provider inside it would keep every other replica yielding. The walk only COLLECTS mismatches; the outer
    // finally pages them once the lock and the connection are gone, then waits a bounded time for the mail.
    const collected: ChainMismatchAlert[] = [];
    const collector: PagingNotifier = {
      page: (alert) => {
        collected.push(alert);
        return Promise.resolve();
      },
    };
    try {
      await walkUnderLock(collector);
    } finally {
      if (collected.length > 0) {
        const notifier = new LoggingPagingNotifier();
        // Started together, settled by the bounded drain: neither a slow nor a hung provider can stall the job.
        for (const alert of collected) void notifier.page(alert);
        await drainAlertEmails();
      }
    }
  };

  async function walkUnderLock(notifier: PagingNotifier): Promise<void> {
    const client = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("audit.verify");
    let held = false;
    try {
      // Try, not wait — the same reasoning as the reconciler. Two replicas
      // walking every chain simultaneously is pure duplicated cost, and a
      // skipped run loses nothing because the next one asks the same question.
      held = await tryAdvisorySessionLock(client, lockKey);
      if (!held) {
        incrementCounter("nominara_audit_verify_yielded_total");
        logger.warn("another replica holds the audit-verify lock; yielding this tick");
        return;
      }

      const result = await verifyAllChains(client, notifier);

      for (let i = 0; i < result.marksWritten; i += 1) {
        incrementCounter("nominara_audit_chain_marks_written_total");
      }

      if (result.mismatches.length === 0) {
        logger.log(
          `audit chains verified: no mismatch across ${String(result.walked)} workspace(s), ${String(result.marksWritten)} high-water mark(s) written`,
        );
        return;
      }

      for (const mismatch of result.mismatches) {
        incrementCounter("nominara_audit_chain_mismatch_total", { workspace_id: mismatch.workspaceId, reason: mismatch.reason });
        logger.error(
          `audit chain mismatch in workspace ${mismatch.workspaceId} at seq ${String(mismatch.seq)}: ${mismatch.reason}`,
        );
      }

      // ⚠ THE JOB FAILS, AND AN EARLIER VERSION OF THIS COMMENT WAS WRONG
      // ABOUT WHY IT NEED NOT. It claimed `verifyAllChains` "has already paged
      // — that is the §12 requirement and it has happened". It has not.
      // `LoggingPagingNotifier` says so in its own header: a stub, because no
      // paging client exists in this repo (STORY-020-E-4), and
      // `incrementCounter` is a `Logger.log` for the same reason — no metrics
      // backend exists either. So on the old path the complete output of a
      // detected tamper was three log lines and a GREEN job: no failed job, no
      // dead-letter entry, no alert, nothing a machine watches. The audit
      // log's tamper detection would have run nightly and told nobody.
      //
      // That notifier's own comment names what used to close the gap: "the
      // calling worker script decides process.exitCode, not this class." The
      // script's non-zero exit WAS the escalation, and moving the job onto a
      // queue removed it. Failing the job is what puts it back — the
      // dead-letter queue is the one channel here that an operator actually
      // reads.
      //
      // `UnrecoverableError` rather than a plain throw, which answers the
      // objection the old comment was reaching for: it skips the retry ladder
      // entirely, so this is ONE walk, ONE page and ONE dead-letter entry per
      // day, never a re-walk of the estate and never a repeated page.
      //
      // ⚠ AND FOR MOST OF THIS FILE'S LIFE THAT COUNT WAS ZERO, NOT ONE.
      // STORY-154: `attachDeadLetterHandler` decided a failure was terminal
      // from `attemptsMade >= opts.attempts`, and skipping the ladder is
      // exactly what leaves that count at 1 of 4. The mechanism chosen here to
      // guarantee a single dead-letter entry was the mechanism that guaranteed
      // none — landing this detector back in the state the paragraphs above
      // describe as the bug: "no dead-letter entry, nothing a machine
      // watches". The handler now asks `willBullmqRetry` instead.
      //
      // Two tests hold this comment to its word, and it took a review to
      // notice they are different tests. `audit-verify-handler.spec.ts` runs
      // THIS handler against a tampered chain and asserts the thrown CLASS —
      // without that, `UnrecoverableError` could quietly become a plain
      // `Error` with every gate green, and the estate would re-walk and page
      // four times a night instead of once. `queue-terminal-failures.spec.ts`
      // proves an `UnrecoverableError` on attempt 1 of 4 reaches the DLQ at
      // all; it builds its own error rather than calling this handler, so it
      // covers the wiring, not this throw. Weaken either and this paragraph is
      // a promise again rather than a description.
      throw new UnrecoverableError(
        `audit chain mismatch in ${String(result.mismatches.length)} workspace(s); ` +
          `first: ${result.mismatches[0]!.workspaceId} at seq ${String(result.mismatches[0]!.seq)} ` +
          `(${result.mismatches[0]!.reason})`,
      );
    } finally {
      // ⚠ `client.end()` IS WHAT GUARANTEES THE RELEASE; this call is the
      // documentation. Same redundancy as `credit-reconcile.handler.ts`, and
      // measured the same way: removing this line alone passes every test,
      // because ending the connection drops the session lock anyway. It earns
      // its place against `client` ever becoming pooled, where `end()` would
      // become `release()` and hand the lock back still held.
      if (held && !(await releaseAdvisorySessionLock(client, lockKey))) {
        logger.error("audit-verify lock was not held at release — the lock key or the connection changed under us");
      }
      await client.end();
    }
  }
}
