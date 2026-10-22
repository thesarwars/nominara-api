import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import { incrementCounter } from "../../telemetry/metrics.js";
import { defaultCheckDeps, type CheckDeps } from "../../verification/checkers.js";
import { runDomainReverification, type ReverifyResult } from "../../verification/reverify.js";
import { globalQueueLockKey, releaseAdvisorySessionLock, tryAdvisorySessionLock } from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

export { MIN_RECHECK_INTERVAL_MS } from "../../verification/reverify.js";

// STORY-048 AC7 — `domain.reverify`: the daily tick that re-verifies every verified domain, so a domain that
// stops verifying loses full scope WITH a notification instead of silently continuing at full scope.
// OWNER DECISION 2026-10-19: one queue added to the topology for it.
//
// Not tenant-scoped, like `identity.sweep_unverified`: the tick has no workspace to name. The cross-tenant
// DISCOVERY runs on the owner connection; every WRITE is applied in one tenant's context as the runtime role
// (see `verification/reverify.ts`). Idempotent under at-least-once delivery (a domain checked inside the
// minimum interval is not re-checked, and a loss notifies on the transition only) and single-flight across
// replicas by the advisory lock, taken as a TRY: a replica that does not get it yields, losing nothing.

const tracer = trace.getTracer("nominara.domain-reverify");

export interface DomainReverifyDeps {
  readonly checks?: CheckDeps;
  readonly now?: () => Date;
  readonly batchSize?: number;
}

export type DomainReverifyOutcome = ReverifyResult | { readonly status: "yielded" };

export function createDomainReverifyHandler(context: QueueHandlerContext, deps: DomainReverifyDeps = {}): JobProcessor<DomainReverifyOutcome> {
  const logger = new Logger("domain.reverify");
  // Built on first use: QUEUE_HANDLERS is evaluated for every worker group at boot.
  let checks: CheckDeps | undefined = deps.checks;

  // `_client` is the pooled connection `createJobProcessor` checks out for a non-tenant queue. This handler does not use it
  // (discovery runs on its own owner connection, every write on a pool connection inside one tenant's context), yet it
  // stays checked out for the run. Accepted: the queue has concurrency 1, so the cost is one idle pooled connection; the
  // factory has no "release before run" shape and adding one is a worker-factory change this story does not own.
  return async (_client: ClientBase, _job: Job): Promise<DomainReverifyOutcome> => {
    const owner = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("domain.reverify");
    let held = false;
    try {
      held = await tryAdvisorySessionLock(owner, lockKey);
      if (!held) {
        incrementCounter("nominara_domain_reverify_yielded_total");
        logger.warn({ event: "domain.reverify.yielded" });
        return { status: "yielded" };
      }
      checks ??= defaultCheckDeps();
      const resolved = checks;

      return await tracer.startActiveSpan("domain.reverify", async (span) => {
        try {
          const result = await runDomainReverification(owner, context.pool, {
            checks: resolved,
            now: deps.now ?? (() => new Date()),
            ...(deps.batchSize === undefined ? {} : { batchSize: deps.batchSize }),
          });
          span.setAttribute("nominara.domain_reverify.checked", result.checked);
          span.setAttribute("nominara.domain_reverify.lost", result.lost);
          span.setAttribute("nominara.domain_reverify.failed", result.failed);
          span.setAttribute("nominara.domain_reverify.inconclusive", result.inconclusive);
          span.setAttribute("nominara.domain_reverify.gone", result.gone);
          incrementCounter("nominara_domain_reverify_runs_total", { status: result.status });
          for (let i = 0; i < result.lost; i += 1) incrementCounter("nominara_domain_reverify_lost_total");
          // Counts only — never a domain or an address.
          logger.log({ event: "domain.reverify.run", status: result.status, checked: result.checked, lost: result.lost, failed: result.failed, inconclusive: result.inconclusive, gone: result.gone });
          return result;
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          incrementCounter("nominara_domain_reverify_runs_total", { status: "failed" });
          throw error;
        } finally {
          span.end();
        }
      });
    } finally {
      if (held && !(await releaseAdvisorySessionLock(owner, lockKey))) {
        logger.error({ event: "domain.reverify.lock_not_held_at_release" });
      }
      await owner.end();
    }
  };
}
