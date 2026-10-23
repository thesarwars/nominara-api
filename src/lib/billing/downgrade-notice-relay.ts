import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { DOWNGRADE_NOTICE_QUEUE, downgradeNoticeJobKey, type DowngradeNoticeKind, type EnqueueDowngradeNotice } from "./downgrade-notice-outbox.js";

// STORY-077 — OWNER DECISION 2026-10-23 (2), review round 2 (major): THE RELAY that makes the outbox pay off.
//
// `downgrade_notices` records every pause/resume email inside the plan change's transaction, and one
// `billing.downgrade_notice` job is enqueued after the commit. Two paths used to end with the row at `sent_at IS NULL`
// and nothing that would ever read it again:
//   * the job's ladder (doubling(5): 2+4+8+16+32 s, about a minute) ran out during a provider outage;
//   * the enqueue itself failed after the commit (a Valkey blip at the cut-over).
// This relay re-enqueues them. It rides the capture worker's hourly scheduler tick (scheduler-sweep.ts), on the OWNER
// connection that tick already opens, because the scan must see across tenants (the table is FORCE RLS); every send
// still happens in the job, as the runtime role, in the notice's own tenant context.
//
//   * ONLY ROWS OLDER THAN `NOTICE_RELAY_MIN_AGE_MS` (5 min): a younger row's own job may still be on its ladder.
//   * A NEW JOB KEY EACH HOUR (`downgradeNoticeRelayJobKey`). BullMQ deduplication keeps the base key for the queue's
//     `removeOnComplete.age` (an hour), so a re-add under it would be swallowed by the dead job. Two replicas ticking in
//     the same hour derive the same key, so one job per hour, not one per replica.
//   * CAPPED BY AGE, not by a counter: a row older than `NOTICE_RELAY_MAX_AGE_MS` (23 h) is no longer relayed. That
//     keeps every re-send inside Resend's 24-hour idempotency window for the provider key the handler derives from the
//     notice id, so a send that reached Resend but was never marked sent is still de-duplicated there. A dead address
//     therefore costs at most 23 hourly retries; what is left is counted as abandoned and logged (ids and counts only).
//   * NEVER A DOUBLE SEND: the handler's `sent_at IS NULL` read and its stable provider key are unchanged, so a relayed
//     job for a notice its original job has since sent ends at prepare with nothing sent.
//   * RETENTION (review round 2, data minimisation): the row holds the billing contact's address and the rendered body
//     (project names). Rows older than `NOTICE_RETENTION_MS` (30 days), sent or abandoned, are deleted here. A recent
//     row is kept: it is the dedupe key a Stripe redelivery (at most three days later) relies on. A workspace's rows also
//     go with the workspace (ON DELETE CASCADE, migration 0134). THE 30 DAYS IS A CHOICE, NOT A TRANSCRIPTION: no
//     reference gives this table a retention period; the owner can move it.

const logger = new Logger("billing.downgrade_notice.relay");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const NOTICE_RELAY_MIN_AGE_MS = 5 * MINUTE_MS;
export const NOTICE_RELAY_MAX_AGE_MS = 23 * HOUR_MS;
export const NOTICE_RETENTION_MS = 30 * 24 * HOUR_MS;
/** At most this many notices are relayed per tick; the rest wait for the next. */
export const NOTICE_RELAY_BATCH = 500;

/** The relay's job key: the base key's shape (`dgnotice:{workspace}:{request}:{kind}`), the request carrying the hour. */
export function downgradeNoticeRelayJobKey(workspaceId: string, requestId: string, kind: DowngradeNoticeKind, now: Date): string {
  return downgradeNoticeJobKey(workspaceId, `${requestId}#relay:${String(Math.floor(now.getTime() / HOUR_MS))}`, kind);
}

export interface RelayResult {
  readonly relayed: number;
  readonly failed: number;
  /** Unsent and past the relay window: no longer retried. */
  readonly abandoned: number;
  readonly purged: number;
}

/**
 * One relay pass on `client`, an owner connection that sees across tenants (no transaction is opened: each statement
 * stands alone, and nothing is held across an enqueue). A failed enqueue is counted and logged; it is retried next tick.
 */
export async function relayUnsentDowngradeNotices(client: ClientBase, enqueue: EnqueueDowngradeNotice, now: Date): Promise<RelayResult> {
  const due = await client.query<{ id: string; workspace_id: string; request_id: string; kind: DowngradeNoticeKind }>(
    `SELECT id, workspace_id, request_id, kind FROM downgrade_notices
      WHERE sent_at IS NULL AND created_at < $1 AND created_at >= $2
      ORDER BY created_at
      LIMIT ${String(NOTICE_RELAY_BATCH)}`,
    [new Date(now.getTime() - NOTICE_RELAY_MIN_AGE_MS), new Date(now.getTime() - NOTICE_RELAY_MAX_AGE_MS)],
  );
  let relayed = 0;
  let failed = 0;
  for (const row of due.rows) {
    try {
      await enqueue(DOWNGRADE_NOTICE_QUEUE, row.workspace_id, { noticeId: row.id }, { idempotencyKey: downgradeNoticeRelayJobKey(row.workspace_id, row.request_id, row.kind, now) });
      relayed += 1;
      incrementCounter("nominara_billing_downgrade_notice_relayed_total", { kind: row.kind });
    } catch (error) {
      failed += 1;
      incrementCounter("nominara_billing_downgrade_notice_failed_total", { reason: "relay_enqueue_failed" });
      logger.error({ event: "billing.downgrade_notice.relay_enqueue_failed", workspace_id: row.workspace_id, notice_id: row.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const abandonedRows = await client.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM downgrade_notices WHERE sent_at IS NULL AND created_at < $1",
    [new Date(now.getTime() - NOTICE_RELAY_MAX_AGE_MS)],
  );
  const abandoned = abandonedRows.rows[0]?.n ?? 0;
  if (abandoned > 0) {
    incrementCounter("nominara_billing_downgrade_notice_abandoned_ticks_total");
    logger.error({ event: "billing.downgrade_notice.abandoned", count: abandoned });
  }

  const purgedRows = await client.query("DELETE FROM downgrade_notices WHERE created_at < $1", [new Date(now.getTime() - NOTICE_RETENTION_MS)]);
  const purged = purgedRows.rowCount ?? 0;

  logger.log({ event: "billing.downgrade_notice.relay", relayed, failed, abandoned, purged });
  return { relayed, failed, abandoned, purged };
}
