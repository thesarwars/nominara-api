import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { LoggingPagingNotifier } from "../../../modules/audit/adapters/logging-paging-notifier.js";
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
    const client = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("audit.verify");
    let held = false;
    try {
      // Try, not wait — the same reasoning as the reconciler. Two replicas
      // walking every chain simultaneously is pure duplicated cost, and a
      // skipped run loses nothing because the next one asks the same question.
      held = await tryAdvisorySessionLock(client, lockKey);
      if (!held) {
        incrementCounter("audit_verify_yielded_total");
        logger.warn("another replica holds the audit-verify lock; yielding this tick");
        return;
      }

      const result = await verifyAllChains(client, new LoggingPagingNotifier());

      if (result.mismatch === null) {
        logger.log("audit chains verified: no mismatch");
        return;
      }

      // ⚠ PAGED, COUNTED, AND THE JOB STILL SUCCEEDS. `verifyAllChains` has
      // already paged through the notifier — that is the §12 requirement and
      // it has happened by the time we get here. Throwing would ALSO send the
      // tick down the retry ladder to re-walk every chain and page again,
      // identically, on every attempt, and then park in the dead-letter queue
      // looking like a broken verifier rather than a detected mismatch. A
      // mismatch is a finding, not a failure to find.
      incrementCounter("audit_chain_mismatch_detected", { workspace_id: result.mismatch.workspaceId });
      logger.error(
        `audit chain mismatch in workspace ${result.mismatch.workspaceId} at seq ${String(result.mismatch.seq)}: ` +
          result.mismatch.reason,
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
  };
}
