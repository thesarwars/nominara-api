import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { failManualAudit } from "./fail-manual-audit.js";

// AUXLIVE-3 (owner decision 40) - the reaper for a MANUAL audit whose job never finished.
//
// `POST /projects/{id}/aux-audits` charges the audit and queues its row; the row leaves `queued` only when a `crawl.audit` worker claims it. A job lost for
// good (the queue wiped, a worker down for ever, a job dead-lettered before its recover hook ran) would leave the row `queued` with the credits taken. So a
// manual audit still `queued` or `running` after MANUAL_AUDIT_STALE_AFTER_MINUTES is failed (`{"reason":"stale"}`) and refunded IN FULL, through the same
// idempotent refund as every other failed audit (fail-manual-audit.ts).
//
// ONLY `manual`: an onboarding or scheduled audit has no charge and no row until it runs, so there is nothing to give back or to fail.
//
// RUNS ON THE SWEEP'S OWNER CONNECTION (it must see across tenants to find them), but every write is inside a per-audit withTenantContext, so RLS is the
// guarantee for the refund. A job that is in fact still running when the bound passes loses the race to nothing: its commit finds a `failed` row and
// writes nothing (claimAudit), and the customer has their credits back.

const logger = new Logger("aux.stale-audit-reaper");

/** Owner decision 40: 60 minutes. */
export const MANUAL_AUDIT_STALE_AFTER_MINUTES = 60;
const MANUAL_AUDIT_STALE_AFTER_MS = MANUAL_AUDIT_STALE_AFTER_MINUTES * 60 * 1000;

export async function reapStaleManualAudits(client: ClientBase, now: Date, boundMs: number = MANUAL_AUDIT_STALE_AFTER_MS): Promise<{ readonly reaped: number }> {
  const cutoff = new Date(now.getTime() - boundMs);
  // IDs only: no tenant content is read.
  const stale = await client.query<{ id: string; workspace_id: string }>(
    `SELECT id, workspace_id FROM aux_audits
      WHERE trigger = 'manual' AND status IN ('queued', 'running') AND created_at < $1
      ORDER BY created_at ASC LIMIT 500`,
    [cutoff],
  );
  let reaped = 0;
  for (const row of stale.rows) {
    try {
      const done = await withTenantContext(client, { workspaceId: row.workspace_id, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        failManualAudit(tx, { workspaceId: row.workspace_id, auditId: row.id, reason: "stale", at: now, createdBefore: cutoff }),
      );
      if (!done) continue;
      reaped += 1;
      incrementCounter("nominara_aux_stale_audits_reaped_total", {});
      logger.log({ event: "aux.audit.reaped_stale", workspace_id: row.workspace_id, audit_id: row.id });
    } catch (error) {
      // One audit's failure must not stop the others, nor the sweep that called us.
      logger.error({ event: "aux.audit.reap_failed", workspace_id: row.workspace_id, audit_id: row.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { reaped };
}
