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
// calls this once per tick. LEAST PRIVILEGE: the owner connection reads the suppression hashes and the ids of the workspaces
// that have an active report, and nothing else (no report name, no recipient). Everything about a workspace's reports is
// read, matched and written inside `tenantWrite`, which opens that workspace's OWN tenant transaction as the runtime role, so
// tenant content never crosses a tenant boundary and nothing is written to a tenant table from the owner connection.
//
// MATCHING is by the peppered hash: each recipient of each active report is hashed in memory, inside that workspace's
// transaction, and compared. The address is never stored, logged, or put in a notification; the notification names the
// REPORT and the KIND.
//
// IDEMPOTENT AND RETRYABLE. A notification's event key is `(suppression, report)`, so a retried pass writes nothing twice. A
// workspace's pass is one transaction. The batch's suppressions are marked `fanned_out_at` only when every workspace was
// written; if one failed they all stay unmarked (a failed workspace's matches are not known) and the next tick finishes it.
// A batch is bounded; the rest waits.
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

      // Ids only: which workspaces have an active report. Their content is read inside their own tenant transactions below.
      const workspaces = await client.query<{ workspace_id: string }>("SELECT DISTINCT workspace_id FROM scheduled_reports WHERE active ORDER BY workspace_id");
      // hash (hex) -> its suppressions (the same address can be suppressed as a bounce and as a complaint)
      const wanted = new Map<string, Array<(typeof pending.rows)[number]>>();
      for (const row of pending.rows) {
        const hex = row.recipient_hash.toString("hex");
        wanted.set(hex, [...(wanted.get(hex) ?? []), row]);
      }

      let notified = 0;
      let failed = 0;
      for (const { workspace_id: workspaceId } of workspaces.rows) {
        try {
          let written = 0;
          await tenantWrite(workspaceId, async (tx) => {
            written = 0;
            // RLS confines this read to the workspace the transaction was opened for.
            const reports = await tx.query<ReportRow>("SELECT id, name, recipients::text[] AS recipients FROM scheduled_reports WHERE active");
            for (const report of reports.rows) {
              const seen = new Set<string>();
              for (const address of report.recipients) {
                const hex = hashEmailKey(normalizeEmail(address), pepper).toString("hex");
                const matches = wanted.get(hex);
                if (matches === undefined || seen.has(hex)) continue;
                seen.add(hex);
                for (const suppression of matches) {
                  await writeNotification(tx, {
                    workspaceId,
                    projectId: null,
                    userId: null,
                    kind: "report.recipient_suppressed",
                    severity: "warning",
                    title: "A scheduled report has a recipient that can no longer be mailed",
                    body: `"${report.name}" has a recipient that is ${KIND_TEXT[suppression.kind]}. It will be skipped on every send until it is replaced. Remove or replace it in the report's recipients.`,
                    eventKey: `email.suppressed:${suppression.id}:${report.id}`,
                    facts: { scheduled_report_id: report.id, suppression_kind: suppression.kind },
                  });
                  written += 1;
                  incrementCounter("nominara_email_suppression_fanout_notifications_total", { kind: suppression.kind });
                }
              }
            }
          });
          notified += written;
        } catch (error) {
          failed += 1;
          // Ids only: never a report name, an address or the hash.
          logger.error({ event: "email.suppression.fanout.write_failed", workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      if (failed === 0) {
        await client.query("UPDATE email_suppressions SET fanned_out_at = now() WHERE id = ANY($1::uuid[]) AND fanned_out_at IS NULL", [pending.rows.map((row) => row.id)]);
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
