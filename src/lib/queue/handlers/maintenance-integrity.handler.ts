import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { UnrecoverableError, type Job } from "bullmq";
import type { Client, ClientBase } from "pg";
import { connect, withKeepalives } from "../../../db/client.js";
import {
  HNSW_INDEXED_TABLES,
  VECTOR_RECALL_THRESHOLD,
} from "../../../db/conventions.js";
import {
  findUnresolvedPurgeFailures,
  PURGE_FAILURE_GRACE_DAYS,
} from "../../../db/purge-check.js";
import { assertMaintenanceDefinerAvailable, computeRecallAtK, MAINTENANCE_DEFINER_UNAVAILABLE_MESSAGE } from "../../../workers/rollup/maintenance.js";
import { scanForOrphans } from "../../../workers/rollup/retention.js";
import { drainAlertEmails, emailAlert } from "../../alerts/alerts.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import {
  globalQueueLockKey,
  releaseAdvisorySessionLock,
  tryAdvisorySessionLock,
} from "../locks.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// STORY-013 AC6 / AC14 / AC16 — `maintenance.integrity`, the nightly tick for three read-only checks that existed, were tested, and
// ran only when an operator typed a command:
//
//   AC14  the orphan scan — "asserts zero fact rows without a parent, per partition, and pages on non-zero"
//   AC16  the purge-failure check — "a purge failure alerts and blocks the next release train if unresolved"
//   AC6   the vector-recall check — "checked nightly against a fixed query set"
//
// ⚠ D4 INFRASTRUCTURE IS PARKED (decision 45): there is no alerting stack, no pager, and no release pipeline. What this handler is, is
// the code-side HOOK those will call later. Each finding is (a) a metric, (b) a structured error log, (c) an alert email through the
// existing Pager leg (a no-op until ALERT_EMAIL_TO is set), and — for the two conditions the story says PAGE — (d) a FAILED job. The
// dead-letter queue is the one channel here an operator actually reads (see `audit-verify.handler.ts`, whose reasoning this follows).
// `db:purge-check` remains the release-train gate; wiring it into a pipeline is the infrastructure remainder.
//
// ⚠ READ-ONLY, AND THE REBUILD IS DELIBERATELY NOT HERE (owner decision 58(b)). A recall below `VECTOR_RECALL_THRESHOLD` raises an ALERT
// ONLY: a metric (`nominara_maintenance_integrity_findings_total{check="vector_recall"}`), an error log and an alert email. The job does
// NOT rebuild. The `REINDEX CONCURRENTLY` at a higher ef_construction stays OPERATOR-RUN (`pnpm db:maintenance:run`), which is the split
// `maintenance-partition.handler.ts` documents for every destructive or resource-heavy step. Nothing in this file may import
// `rebuildHnswIndex` or `runRecallCheck`; the integration case "issues NO REINDEX on any connection" fails if the tick ever rebuilds.
//
// ⚠ ONE CHECK THROWING DOES NOT SKIP THE OTHERS, and a check that could not RUN is not a clean check. An orphan scan that errors
// must never read as "no orphans", so a check failure fails the job (an ordinary error: retrying a database fault is right) after
// the other checks have reported.
//
// ⚠ THE OWNER CONNECTION AND THE COUNT-ONLY DEFINER (owner decision 58(a), docs/adr/ADR-0004): the orphan scan and the recall check read
// FORCE-RLS tenant tables across every workspace, which the documented NOSUPERUSER NOBYPASSRLS identity cannot do directly (it reads 0 rows
// and looks clean). They call three count-only SECURITY DEFINER functions (migration 0160) owned by `nominara_maintenance`. `purge_failures`
// is global with no RLS and no runtime grant, so it is still read directly by the owner connection. Direct (not the pooler) because it
// holds a session advisory lock; keepalives so a partitioned replica cannot strand it for two hours.
//
// ⚠ WHAT IS LOGGED: workspace and project IDs, table and partition names, counts. Never a workspace name, a purge-failure `reason`
// (an error message, which can carry row values) or any row content.

const tracer = trace.getTracer("nominara-api");

const ALERT_DRAIN_BUDGET_MS = 90_000;
/** Bounds each scan statement (transaction-local) so the nightly reader cannot hold AccessShareLock on the hot parents indefinitely. */
const SCAN_STATEMENT_TIMEOUT_MS = 300_000;

interface Finding {
  readonly check:
    | "orphan_facts"
    | "purge_failures_unresolved"
    | "purge_failures_blocking"
    | "vector_recall";
  /** True for the two conditions the story says PAGE: the job fails. */
  readonly pages: boolean;
  readonly summary: string;
}

export function createMaintenanceIntegrityHandler(
  context: QueueHandlerContext,
): JobProcessor {
  const logger = new Logger("maintenance.integrity");

  return async (_client: ClientBase, _job: Job): Promise<void> => {
    await tracer.startActiveSpan("maintenance.integrity", async (span) => {
      try {
        const outcome = await runUnderLock();
        span.setAttribute(
          "nominara.maintenance.integrity.outcome",
          outcome.kind,
        );
        span.setAttribute(
          "nominara.maintenance.integrity.findings",
          outcome.findings.length,
        );
        const paging = outcome.findings.filter((finding) => finding.pages);

        // Alerts leave AFTER the lock and the connection are gone, and the drain waits for the provider's stated budget (~90 s with
        // retries) rather than the 5 s default. Even so the email is BEST-EFFORT: the failed job in the dead-letter queue is the
        // reliable signal, never the mail.
        if (outcome.findings.length > 0) await drainAlertEmails(ALERT_DRAIN_BUDGET_MS);

        const couldNotRun =
          outcome.checkErrors.length > 0
            ? `${String(outcome.checkErrors.length)} check(s) could not run: ${outcome.checkErrors.join(", ")}`
            : undefined;
        if (paging.length > 0) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          // Unrecoverable: ONE page per night, never a retry ladder re-running a scan whose answer has not changed and re-sending the
          // page. A check that also could not run is named in the same message, so neither is lost.
          throw new UnrecoverableError(
            `maintenance.integrity paged: ${paging.map((finding) => finding.summary).join("; ")}` +
              (couldNotRun === undefined ? "" : `; ${couldNotRun}`),
          );
        }
        if (couldNotRun !== undefined) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          // Retryable: nothing has paged, so retrying a database fault sends no duplicate.
          throw new Error(`maintenance.integrity: ${couldNotRun}`);
        }
      } finally {
        span.end();
      }
    });
  };

  async function runUnderLock(): Promise<{
    kind: "ran" | "yielded";
    findings: Finding[];
    checkErrors: string[];
  }> {
    const findings: Finding[] = [];
    const checkErrors: string[] = [];
    const client = await connect(withKeepalives(context.env.DATABASE_URL));
    const lockKey = globalQueueLockKey("maintenance.integrity");
    let held = false;
    try {
      held = await tryAdvisorySessionLock(client, lockKey);
      if (!held) {
        incrementCounter("nominara_maintenance_integrity_yielded_total");
        logger.warn(
          "another replica holds the maintenance-integrity lock; yielding this tick",
        );
        return { kind: "yielded", findings, checkErrors };
      }

      // ⚠ FAIL CLOSED FIRST. If the connection cannot EXECUTE the count-only definer functions, the orphan scan and the recall check cannot
      // see the FORCE-RLS tables and would present as "no orphans" and "nothing to measure" every night. Not a row count: the functions'
      // existence and EXECUTE. If it fails, NOTHING is checked and nothing is observed: no 0 and no skip.
      try {
        await assertMaintenanceDefinerAvailable(client);
      } catch {
        checkErrors.push("definer_function");
        incrementCounter("nominara_maintenance_integrity_check_errors_total", { check: "definer_function" });
        logger.error({
          message: `integrity checks not run: the connection ${MAINTENANCE_DEFINER_UNAVAILABLE_MESSAGE} (FORCE ROW LEVEL SECURITY)`,
          check: "definer_function",
        });
        return { kind: "ran", findings, checkErrors };
      }

      const checks: { name: string; run: () => Promise<void> }[] = [
        { name: "orphan_facts", run: () => checkOrphans(client, findings) },
        {
          name: "purge_failures",
          run: () => checkPurgeFailures(client, findings),
        },
        {
          name: "vector_recall",
          run: () => checkVectorRecall(client, findings),
        },
      ];
      for (const check of checks) {
        try {
          await check.run();
        } catch (error) {
          checkErrors.push(check.name);
          incrementCounter(
            "nominara_maintenance_integrity_check_errors_total",
            { check: check.name },
          );
          // The error class only: a database error message can carry row values.
          logger.error({
            message: "integrity check could not run",
            check: check.name,
            error: error instanceof Error ? error.name : "unknown",
          });
          // A failed statement inside a transaction leaves the session aborted; the next check must start clean.
          await client.query("ROLLBACK").catch(() => undefined);
        }
      }
      return { kind: "ran", findings, checkErrors };
    } finally {
      if (held && !(await releaseAdvisorySessionLock(client, lockKey))) {
        logger.error(
          "maintenance-integrity lock was not held at release — the lock key or the connection changed under us",
        );
      }
      await client.end();
    }
  }

  function raise(
    findings: Finding[],
    finding: Finding,
    alertName: string,
    context: Record<string, unknown>,
    logLine: Record<string, unknown>,
  ): void {
    findings.push(finding);
    incrementCounter("nominara_maintenance_integrity_findings_total", {
      check: finding.check,
    });
    logger.error({ message: finding.summary, ...logLine });
    emailAlert(finding.summary, { alertName, ...context });
  }

  /**
   * The orphan scan anti-joins whole fact partitions against `answer_captures` and so holds AccessShareLock on it for as long as a
   * statement runs; the partition DDL needs ACCESS EXCLUSIVE on that parent. Bounded here (transaction-local, so never session
   * state) and, on the DDL side, by `lock_timeout` in `createPartition`. A timeout is a check error: the job fails, never a clean 0.
   * (The recall check touches only the vector tables, which no partition DDL takes, and opens its own transaction.)
   */
  async function withStatementTimeout<T>(client: Client, fn: () => Promise<T>): Promise<T> {
    await client.query("BEGIN");
    try {
      await client.query(`SET LOCAL statement_timeout = '${String(SCAN_STATEMENT_TIMEOUT_MS)}ms'`);
      const value = await fn();
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async function checkOrphans(
    client: Client,
    findings: Finding[],
  ): Promise<void> {
    const reports = await withStatementTimeout(client, () => scanForOrphans(client));
    const total = reports.reduce((sum, report) => sum + report.orphanCount, 0);
    // 0 is an observation, not absence.
    observeValue("nominara_maintenance_orphan_fact_rows_total", total);
    if (reports.length === 0) return;
    const detail = reports
      .map(
        (report) =>
          `table=${report.table} partition=${report.partition} count=${String(report.orphanCount)}`,
      )
      .join(", ");
    raise(
      findings,
      {
        check: "orphan_facts",
        pages: true,
        summary: `orphan fact row(s) detected — a fact was written outside its parent's transaction (${String(total)} row(s))`,
      },
      "maintenance_orphan_facts",
      {
        rowCount: total,
        partitions: reports.map((report) => report.partition),
      },
      { detail },
    );
  }

  async function checkPurgeFailures(
    client: Client,
    findings: Finding[],
  ): Promise<void> {
    const unresolved = await findUnresolvedPurgeFailures(client);
    observeValue(
      "nominara_retention_purge_failures_unresolved_total",
      unresolved.length,
    );
    if (unresolved.length === 0) return;

    const blocking = unresolved.filter((failure) => failure.blocking);
    const within = unresolved.length - blocking.length;
    if (within > 0) {
      raise(
        findings,
        {
          check: "purge_failures_unresolved",
          pages: false,
          summary: `${String(within)} purge failure(s) unresolved, still inside the ${String(PURGE_FAILURE_GRACE_DAYS)}-day grace window`,
        },
        "retention_purge_failure_unresolved",
        { unresolved: within, graceDays: PURGE_FAILURE_GRACE_DAYS },
        { unresolved: within },
      );
    }
    if (blocking.length > 0) {
      raise(
        findings,
        {
          check: "purge_failures_blocking",
          pages: true,
          summary: `${String(blocking.length)} purge failure(s) unresolved past ${String(PURGE_FAILURE_GRACE_DAYS)} days — db:purge-check will fail the release gate once it is wired (not yet enforced)`,
        },
        "retention_purge_failure_blocking",
        { blocking: blocking.length, graceDays: PURGE_FAILURE_GRACE_DAYS },
        {
          failures: blocking.map(
            (failure) => `scope=${failure.scope} id=${failure.scopeId}`,
          ),
        },
      );
    }
  }

  async function checkVectorRecall(
    client: Client,
    findings: Finding[],
  ): Promise<void> {
    for (const { table, column, indexName } of HNSW_INDEXED_TABLES) {
      const recall = await computeRecallAtK(client, table, column);
      if (recall === null) {
        // Too few rows to measure. null is NOT 0: no observation, no alert, a counted skip.
        incrementCounter("nominara_maintenance_vector_recall_skipped_total", {
          table,
        });
        continue;
      }
      observeValue("nominara_maintenance_vector_recall_ratio_total", recall, {
        table,
      });
      if (recall < VECTOR_RECALL_THRESHOLD) {
        raise(
          findings,
          {
            check: "vector_recall",
            pages: false,
            summary: `vector recall for ${indexName} is below ${String(VECTOR_RECALL_THRESHOLD)} — alert only, NOT rebuilt: the concurrent rebuild is operator-run (pnpm db:maintenance:run)`,
          },
          "maintenance_vector_recall_below_threshold",
          { table, indexName, recall, threshold: VECTOR_RECALL_THRESHOLD },
          { table, indexName, recall },
        );
      }
    }
  }
}
