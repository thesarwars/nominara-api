import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase, Pool } from "pg";
import { hashEmailKey, normalizeEmail } from "../auth/email-otp.js";
import { writeNotification } from "../notifications/writer.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";

// STORY-178 AC4 / owner decision 9 — telling the workspaces a recipient of theirs can no longer be mailed.
//
// WHY A SWEEP STEP AND NOT THE WEBHOOK. The webhook route is tenant-less and runs as `nominara_app`, which RLS confines to one
// workspace at a time; it cannot (and must not) ask "whose reports include this address?". It records the suppression with
// `fanned_out_at` NULL. The report worker's sweep, which already holds an elected owner connection that sees across tenants,
// calls this once per tick. The owner connection only READS (the suppression hashes and each active report's id, workspace,
// name and recipients); every notification is written by `tenantWrite`, which opens that workspace's OWN tenant transaction
// as the runtime role. Nothing is written to a tenant table from the owner connection.
//
// MATCHING is by the peppered hash: each recipient of each active report is hashed in memory and compared. The address is
// never stored, logged, or put in a notification; the notification names the REPORT and the KIND.
//
// IDEMPOTENT AND RETRYABLE. A notification's event key is `(suppression, report)`, so a retried pass writes nothing twice. A
// suppression is marked `fanned_out_at` only when every workspace it touched was written; if one failed it stays unmarked and
// the next tick finishes it. A batch is bounded; the rest waits.
//
// A report that is PAUSED is not told about (it sends nothing); a suppression no report includes is still marked done.

const logger = new Logger("email.suppression.fanout");
const tracer = trace.getTracer("nominara.email");

export const SUPPRESSION_FANOUT_BATCH = 50;

/** Runs `fn` inside one workspace's own tenant transaction, as a runtime role. */
export type TenantWrite = (workspaceId: string, fn: (tx: ClientBase) => Promise<void>) => Promise<void>;

/** The production `TenantWrite`: one short tenant transaction per workspace on the runtime pool (never the owner connection). */
export function poolTenantWrite(pool: Pick<Pool, "connect">): TenantWrite {
  return async (workspaceId, fn) => {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, fn);
    } finally {
      client.release();
    }
  };
}

export interface SuppressionFanoutResult {
  /** Suppressions picked up this pass. */
  readonly claimed: number;
  /** Notifications written (or already present). */
  readonly notified: number;
  /** Workspace writes that failed; their suppression is retried next pass. */
  readonly failed: number;
}

export class SuppressionFanoutBlindError extends Error {
  constructor(who: string) {
    super(`the suppression fan-out is connected as "${who}", which neither bypasses row-level security nor is a superuser: it would find no report and mark every suppression done`);
    this.name = "SuppressionFanoutBlindError";
  }
}

interface ReportRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly recipients: string[];
}

const KIND_TEXT = {
  bounce: "an address that permanently bounced",
  complaint: "an address whose owner marked a report as spam",
} as const;

/** One pass. `client` is an owner connection that sees across tenants. */
export async function runSuppressionFanout(
  client: ClientBase,
  tenantWrite: TenantWrite,
  pepper: string,
  batch: number = SUPPRESSION_FANOUT_BATCH,
): Promise<SuppressionFanoutResult> {
  const role = await client.query<{ can_see: boolean; who: string }>("SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user");
  if (role.rows[0]?.can_see !== true) {
    incrementCounter("nominara_email_suppression_fanout_runs_total", { status: "blind" });
    throw new SuppressionFanoutBlindError(role.rows[0]?.who ?? "unknown");
  }
  return await tracer.startActiveSpan("email.suppression.fanout", async (span) => {
    try {
      const pending = await client.query<{ id: string; recipient_hash: Buffer; kind: "bounce" | "complaint" }>(
        `SELECT id, recipient_hash, kind FROM email_suppressions
          WHERE fanned_out_at IS NULL AND deleted_at IS NULL
          ORDER BY created_at, id LIMIT $1`,
        [batch],
      );
      if (pending.rows.length === 0) return { claimed: 0, notified: 0, failed: 0 } as const;

      const reports = await client.query<ReportRow>("SELECT id, workspace_id, name, recipients::text[] AS recipients FROM scheduled_reports WHERE active");
      // hash (hex) -> the reports that mail it
      const byHash = new Map<string, ReportRow[]>();
      for (const report of reports.rows) {
        const seen = new Set<string>();
        for (const address of report.recipients) {
          const hex = hashEmailKey(normalizeEmail(address), pepper).toString("hex");
          if (seen.has(hex)) continue;
          seen.add(hex);
          const list = byHash.get(hex) ?? [];
          list.push(report);
          byHash.set(hex, list);
        }
      }

      let notified = 0;
      let failed = 0;
      for (const suppression of pending.rows) {
        let suppressionFailed = false;
        for (const report of byHash.get(suppression.recipient_hash.toString("hex")) ?? []) {
          try {
            await tenantWrite(report.workspace_id, async (tx) => {
              await writeNotification(tx, {
                workspaceId: report.workspace_id,
                projectId: null,
                userId: null,
                kind: "report.recipient_suppressed",
                severity: "warning",
                title: "A scheduled report has a recipient that can no longer be mailed",
                body: `"${report.name}" has a recipient that is ${KIND_TEXT[suppression.kind]}. It will be skipped on every send until it is replaced. Remove or replace it in the report's recipients.`,
                eventKey: `email.suppressed:${suppression.id}:${report.id}`,
                facts: { scheduled_report_id: report.id, suppression_kind: suppression.kind },
              });
            });
            notified += 1;
            incrementCounter("nominara_email_suppression_fanout_notifications_total", { kind: suppression.kind });
          } catch (error) {
            suppressionFailed = true;
            failed += 1;
            // Ids only: never a report name, an address or the hash.
            logger.error({ event: "email.suppression.fanout.write_failed", workspace_id: report.workspace_id, scheduled_report_id: report.id, error: error instanceof Error ? error.name : "unknown" });
          }
        }
        if (!suppressionFailed) {
          await client.query("UPDATE email_suppressions SET fanned_out_at = now() WHERE id = $1 AND fanned_out_at IS NULL", [suppression.id]);
        }
      }
      incrementCounter("nominara_email_suppression_fanout_runs_total", { status: failed === 0 ? "complete" : "partial" });
      span.setAttributes({ "nominara.email.fanout.claimed": pending.rows.length, "nominara.email.fanout.notified": notified, "nominara.email.fanout.failed": failed });
      logger.log({ event: "email.suppression.fanout", claimed: pending.rows.length, notified, failed });
      return { claimed: pending.rows.length, notified, failed } as const;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}
