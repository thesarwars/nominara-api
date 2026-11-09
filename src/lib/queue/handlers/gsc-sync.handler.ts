import { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { AuditChainService } from "../../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../../tenancy/constants.js";
import { afterCommit } from "../../../tenancy/tenant-context.js";
import { uuidV7 } from "../../ids/uuidv7.js";
import { writeNotification } from "../../notifications/writer.js";
import { dekById, openSecret, sealSecret } from "../../gsc/credentials.js";
import { GSC_CLIENT_FACTORY } from "../../gsc/client-factory.js";
import { GscQuotaError, GscSourceError, GscUnauthorizedError, type GscClient, type GscReportRow } from "../../gsc/port.js";
import { toDailyRows, type DailyRow } from "../../gsc/report-rows.js";
import { planSlice, type SlicePlan } from "../../gsc/sync-plan.js";
import { incrementCounter, observeValue } from "../../telemetry/metrics.js";
import { createQueueWorkerConnection, queueKeyPrefix } from "../connection.js";
import { QueueProducer } from "../queue-producer.js";
import type { QueueHandlerContext } from "../handlers.js";
import { PHASES_DONE, phasedProcessor, signingKeysFromEnv, type JobProcessor } from "../worker-factory.js";

// STORY-115 - `gsc.sync`: one slice of one connection's Search Console pull.
//
// PHASED (ADR-0003 / KAD-06). Google is called between two short tenant transactions and the job holds neither a transaction nor a
// pooled connection while it waits:
//   prepare  read the connection, decide the slice (sync-plan.ts), open the credentials. Writes nothing.
//   run      refresh the token if it has expired, then pull the three datasets. Nothing is written.
//   commit   ONE transaction replaces the slice's days and advances the watermark. A failure anywhere before it leaves the watermark
//            where it was, so a slice is stored whole or not at all, and the next run repeats it.
//
// ONE LOOP, ONE WATERMARK. Backfill and incremental are the same job over `last_sync_date` (sync-plan.ts explains the dates). A slice
// that stops short of the frontier asks for the next one AFTER COMMIT, keyed per slice, so a backfill is a chain of short resumable jobs.
//
// IDEMPOTENT UNDER AT-LEAST-ONCE DELIVERY. The slice's days are deleted and re-inserted per (report, dimension) inside one
// transaction, so a redelivery or a second run recomputes the same rows, a figure the source has since revised is picked up, and a row
// the source has since dropped goes. The delete is confined to this project, these dates and one report/dimension at a time: the two
// reports are never touched by each other's write.
//
// STOPS WHEN THE CREDENTIAL IS GONE. A connection that is `unauthorized` or `revoked` is skipped in `prepare` with no call to Google.
// Its synced rows are never deleted.
//
// DEGRADES, DOES NOT FAIL. A spent quota is SETTLED in `recover`: health becomes `degraded` with a reason code, the watermark does not
// move, and the job ends cleanly so nothing is dead-lettered and no project is affected. A report the source cannot serve (today, the
// AI-surface report) is NOT a reason to lose the others: the classic datasets are committed, the connection is `degraded` with the reason,
// and the AI-surface rows stay absent. `gsc_connections` has one watermark, so that reason on the row is what tells the rollup the
// watermark does NOT cover AI-surface impressions (attribution-rollup.ts). Any other failure rides the queue's retry ladder.
//
// NEVER LOGS a token, a property, a URL or a query: workspace and connection ids, counts and reason codes only.

const tracer = trace.getTracer("nominara-api");
const logger = new Logger("gsc.sync");

const payloadSchema = z.object({ workspaceId: z.string().uuid(), kid: z.string(), connectionId: z.string().uuid() }).strict();

const INSERT_CHUNK = 5_000;
const AI_SURFACE_UNAVAILABLE = "ai_surface_report_unavailable";

interface Prepared {
  readonly workspaceId: string;
  readonly connectionId: string;
  readonly projectId: string;
  readonly property: string;
  readonly plan: SlicePlan;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly needsRefresh: boolean;
}

interface Fetched {
  /** `null` when the source cannot serve the AI-surface report: that dataset is then left exactly as it was, never emptied. */
  readonly aiPages: readonly GscReportRow[] | null;
  /** The reason code to record as the connection's degraded cause when the pull was only partly possible; `null` when everything was served. */
  readonly degradedReason: string | null;
  readonly classicPages: readonly GscReportRow[];
  readonly classicQueries: readonly GscReportRow[];
  readonly refreshed: { readonly accessToken: string; readonly expiresInSeconds: number } | null;
}

export interface GscSyncDeps {
  /** Injected in tests; production builds the Google adapter on first use. */
  readonly client?: GscClient;
  /** Injected in tests; production enqueues through a producer built on first use. */
  readonly enqueue?: (queue: "gsc.sync", workspaceId: string, payload: Record<string, unknown>, options: { idempotencyKey: string }) => Promise<unknown>;
}

interface ConnectionRow {
  id: string;
  project_id: string;
  property_url: string;
  credentials_enc: string;
  refresh_enc: string | null;
  dek_id: string;
  health_status: string;
  last_sync_date: string | null;
  today: string;
  needs_refresh: boolean;
}

export function createGscSyncHandler(context: QueueHandlerContext, deps: GscSyncDeps = {}): JobProcessor {
  let client: GscClient | undefined = deps.client;
  const google = (): GscClient => (client ??= GSC_CLIENT_FACTORY());

  let producer: QueueProducer | undefined;
  const enqueue =
    deps.enqueue ??
    (async (queue: "gsc.sync", workspaceId: string, payload: Record<string, unknown>, options: { idempotencyKey: string }): Promise<unknown> => {
      producer ??= new QueueProducer(createQueueWorkerConnection(context.env.QUEUE_REDIS_URL), queueKeyPrefix(context.env.NODE_ENV), signingKeysFromEnv(context.env));
      return producer.enqueueTenantJob(queue, workspaceId, payload, options);
    });

  const payloadOf = (job: Job) => payloadSchema.parse((job.data as { payload: unknown }).payload);

  return phasedProcessor<Prepared, Fetched>({
    async prepare(tx, job) {
      const payload = payloadOf(job);
      const found = await tx.query<ConnectionRow>(
        `SELECT g.id, g.project_id, g.property_url, g.credentials_enc, g.refresh_enc, g.dek_id, g.health_status, g.last_sync_date::text AS last_sync_date,
                to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today,
                (g.token_expires_at IS NULL OR g.token_expires_at <= now() + interval '60 seconds') AS needs_refresh
           FROM gsc_connections g
           JOIN projects p ON p.id = g.project_id AND p.workspace_id = g.workspace_id AND p.deleted_at IS NULL
          WHERE g.id = $1 AND g.workspace_id = app.current_workspace() AND g.revoked_at IS NULL`,
        [payload.connectionId],
      );
      const row = found.rows[0];
      if (row === undefined || row.health_status === "unauthorized" || row.health_status === "revoked") {
        incrementCounter("nominara_gsc_sync_runs_total", { outcome: "skipped" });
        logger.log({ event: "gsc.sync.skipped", workspace_id: payload.workspaceId, connection_id: payload.connectionId, reason: row === undefined ? "not_found" : row.health_status });
        return PHASES_DONE;
      }
      const plan = planSlice({ today: row.today, lastSyncDate: row.last_sync_date });
      if (plan === null) {
        incrementCounter("nominara_gsc_sync_runs_total", { outcome: "up_to_date" });
        return PHASES_DONE;
      }
      const dek = await dekById(tx, payload.workspaceId, row.dek_id);
      return {
        workspaceId: payload.workspaceId,
        connectionId: row.id,
        projectId: row.project_id,
        property: row.property_url,
        plan,
        accessToken: openSecret(dek, payload.workspaceId, row.id, "credentials_enc", row.credentials_enc),
        refreshToken: row.refresh_enc === null ? null : openSecret(dek, payload.workspaceId, row.id, "refresh_enc", row.refresh_enc),
        needsRefresh: row.needs_refresh,
      };
    },

    async run(prepared) {
      const started = Date.now();
      return tracer.startActiveSpan("gsc.sync.pull", async (span) => {
        try {
          let accessToken = prepared.accessToken;
          let refreshed: Fetched["refreshed"] = null;
          if (prepared.needsRefresh) {
            // No refresh token means the grant cannot be renewed: the customer has to reconnect.
            if (prepared.refreshToken === null) throw new GscUnauthorizedError();
            refreshed = await google().refresh(prepared.refreshToken);
            accessToken = refreshed.accessToken;
          }
          const base = { accessToken, property: prepared.property, startDate: prepared.plan.from, endDate: prepared.plan.to };
          // THE AI-SURFACE REPORT MUST NOT TAKE THE CLASSIC DATA DOWN WITH IT. A source that cannot serve it (the adapter has no confirmed
          // request for it yet) costs only that dataset: it is left absent, the connection is recorded as degraded with the reason, and the
          // classic pulls below are still made and committed. Any other failure of this call still fails the slice as before.
          let aiPages: readonly GscReportRow[] | null = null;
          let degradedReason: string | null = null;
          try {
            aiPages = await google().fetchReport({ ...base, report: "ai_surface", dimension: "page" });
          } catch (error) {
            if (!(error instanceof GscSourceError && error.reason === AI_SURFACE_UNAVAILABLE)) throw error;
            degradedReason = AI_SURFACE_UNAVAILABLE;
          }
          const classicPages = await google().fetchReport({ ...base, report: "classic", dimension: "page" });
          const classicQueries = await google().fetchReport({ ...base, report: "classic", dimension: "query" });
          span.setAttribute("gsc.slice_days", 1 + (Date.parse(prepared.plan.to) - Date.parse(prepared.plan.from)) / 86_400_000);
          return { aiPages, degradedReason, classicPages, classicQueries, refreshed };
        } catch (error) {
          span.setStatus({ code: SpanStatusCode.ERROR });
          throw error;
        } finally {
          span.end();
          observeValue("nominara_gsc_sync_pull_duration_ms", Date.now() - started);
        }
      });
    },

    async commit(tx, prepared, fetched) {
      const locked = await tx.query<{ health_status: string; dek_id: string }>(
        "SELECT health_status, dek_id FROM gsc_connections WHERE id = $1 AND workspace_id = app.current_workspace() AND revoked_at IS NULL FOR UPDATE",
        [prepared.connectionId],
      );
      const current = locked.rows[0];
      // Disconnected, or revoked by another run, while Google was being asked: what was pulled is discarded, never stored.
      if (current === undefined || current.health_status === "unauthorized" || current.health_status === "revoked") {
        incrementCounter("nominara_gsc_sync_runs_total", { outcome: "discarded" });
        return;
      }
      const { from, to } = prepared.plan;
      let dropped = 0;
      const datasets: Array<{ report: "ai_surface" | "classic"; dimension: "page" | "query"; rows: DailyRow[] }> = [];
      for (const [report, dimension, source] of [
        ["ai_surface", "page", fetched.aiPages],
        ["classic", "page", fetched.classicPages],
        ["classic", "query", fetched.classicQueries],
      ] as const) {
        // No AI-surface answer means no AI-surface write: neither the delete nor the insert runs, so earlier rows stay.
        if (source === null) continue;
        const built = toDailyRows(dimension, source);
        dropped += built.dropped;
        // The slice is the contract: a row outside it is not stored, so the delete below and the insert always cover the same days.
        datasets.push({ report, dimension, rows: built.rows.filter((r) => r.metricDate >= from && r.metricDate <= to) });
      }
      for (const { report, dimension, rows } of datasets) {
        await tx.query(
          "DELETE FROM gsc_daily WHERE workspace_id = app.current_workspace() AND project_id = $1 AND report = $2 AND dimension = $3 AND metric_date BETWEEN $4::date AND $5::date",
          [prepared.projectId, report, dimension, from, to],
        );
        for (let at = 0; at < rows.length; at += INSERT_CHUNK) {
          const chunk = rows.slice(at, at + INSERT_CHUNK);
          await tx.query(
            `INSERT INTO gsc_daily (workspace_id, project_id, metric_date, report, dimension, page_url, page_url_hash, query_text, query_hash, clicks, impressions, ctr, avg_position, country, device)
             SELECT app.current_workspace(), $1, u.d, $2, $3, u.pu, u.ph, u.qt, u.qh, u.cl, u.im, u.ctr, u.pos, u.country, u.device
               FROM unnest($4::date[], $5::text[], $6::bytea[], $7::text[], $8::bytea[], $9::int[], $10::int[], $11::real[], $12::real[], $13::text[], $14::text[])
                    AS u(d, pu, ph, qt, qh, cl, im, ctr, pos, country, device)`,
            [
              prepared.projectId, report, dimension,
              chunk.map((r) => r.metricDate), chunk.map((r) => r.pageUrl), chunk.map((r) => r.pageUrlHash), chunk.map((r) => r.queryText), chunk.map((r) => r.queryHash),
              chunk.map((r) => r.clicks), chunk.map((r) => r.impressions), chunk.map((r) => r.ctr), chunk.map((r) => r.avgPosition), chunk.map((r) => r.country), chunk.map((r) => r.device),
            ],
          );
        }
        observeValue("nominara_gsc_sync_rows_per_run", rows.length, { report, dimension });
      }

      let sealedAccess: string | null = null;
      if (fetched.refreshed !== null) {
        const dek = await dekById(tx, prepared.workspaceId, current.dek_id);
        sealedAccess = sealSecret(dek, prepared.workspaceId, prepared.connectionId, "credentials_enc", fetched.refreshed.accessToken);
      }
      // The watermark never moves back, and never past the slice's own end, which sync-plan.ts holds at or before the frontier.
      await tx.query(
        `UPDATE gsc_connections
            SET last_sync_date = GREATEST(coalesce(last_sync_date, $2::date), $2::date), last_sync_at = now(),
                health_status = CASE WHEN $6::text IS NULL THEN 'healthy' ELSE 'degraded' END, last_error = $6::text,
                backfill_completed = backfill_completed OR $3::boolean,
                credentials_enc = coalesce($4, credentials_enc),
                token_expires_at = CASE WHEN $5::int IS NULL THEN token_expires_at ELSE now() + make_interval(secs => $5::int) END
          WHERE id = $1 AND workspace_id = app.current_workspace()`,
        [prepared.connectionId, to, !prepared.plan.more, sealedAccess, fetched.refreshed?.expiresInSeconds ?? null, fetched.degradedReason],
      );

      if (prepared.plan.more) {
        afterCommit(() => {
          void enqueue("gsc.sync", prepared.workspaceId, { connectionId: prepared.connectionId }, { idempotencyKey: `gsc:${prepared.connectionId}:${to}` }).catch((error: unknown) => {
            incrementCounter("nominara_gsc_sync_enqueue_failed_total");
            // The daily sweep (src/lib/attribution/sweep.ts) re-enqueues from the stored watermark, so a lost continuation delays the backfill by up to a day and loses nothing.
            logger.warn({ event: "gsc.sync.continuation_not_enqueued", workspace_id: prepared.workspaceId, connection_id: prepared.connectionId, error: error instanceof Error ? error.name : "unknown" });
          });
        });
      }
      incrementCounter("nominara_gsc_sync_runs_total", { outcome: prepared.plan.more ? "slice_done" : "caught_up" });
      logger.log({
        event: "gsc.sync.done",
        workspace_id: prepared.workspaceId,
        connection_id: prepared.connectionId,
        slice_days: 1 + (Date.parse(to) - Date.parse(from)) / 86_400_000,
        rows: datasets.reduce((sum, d) => sum + d.rows.length, 0),
        dropped,
        more: prepared.plan.more,
      });
    },

    async recover(tx, job, failure) {
      if (failure.phase !== "run") return false;
      const payload = payloadOf(job);
      const error = failure.error;
      if (error instanceof GscUnauthorizedError) {
        await markUnauthorized(tx, payload.workspaceId, payload.connectionId);
        return true;
      }
      if (error instanceof GscQuotaError) return degrade(tx, payload.workspaceId, payload.connectionId, "quota_exhausted");
      return false;
    },
  });
}

async function degrade(tx: ClientBase, workspaceId: string, connectionId: string, reason: string): Promise<boolean> {
  await tx.query(
    `UPDATE gsc_connections SET health_status = 'degraded', last_error = $2
      WHERE id = $1 AND workspace_id = app.current_workspace() AND revoked_at IS NULL AND health_status NOT IN ('unauthorized','revoked')`,
    [connectionId, reason],
  );
  incrementCounter("nominara_gsc_sync_runs_total", { outcome: "degraded" });
  logger.warn({ event: "gsc.sync.degraded", workspace_id: workspaceId, connection_id: connectionId, reason });
  return true;
}

/** FR-GSC-01e: health `unauthorized`, one notification, one audit row, no deletion of anything synced. Only the transition notifies. */
async function markUnauthorized(tx: ClientBase, workspaceId: string, connectionId: string): Promise<void> {
  const changed = await tx.query<{ project_id: string; day: string }>(
    `UPDATE gsc_connections SET health_status = 'unauthorized', last_error = 'credential_revoked'
      WHERE id = $1 AND workspace_id = app.current_workspace() AND revoked_at IS NULL AND health_status <> 'unauthorized'
      RETURNING project_id, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day`,
    [connectionId],
  );
  const row = changed.rows[0];
  incrementCounter("nominara_gsc_sync_runs_total", { outcome: "unauthorized" });
  if (row === undefined) return;
  await writeNotification(tx, {
    workspaceId,
    projectId: row.project_id,
    userId: null,
    kind: "integration_unauthorized",
    severity: "warning",
    title: "Search Console access was revoked",
    body: "Google no longer accepts the saved Search Console connection, so syncing has stopped. Everything already synced is kept. Reconnect Search Console to resume.",
    eventKey: `gsc.unauthorized:${connectionId}:${row.day}`,
    facts: { integration: "gsc" },
  });
  await new AuditChainService().append(tx, {
    workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: "worker:gsc.sync",
    action: "gsc.credential_revoked",
    resourceType: "gsc_connection",
    resourceId: connectionId,
    beforeState: { health_status: "healthy_or_degraded" },
    afterState: { health_status: "unauthorized", last_error: "credential_revoked" },
    requestId: `gsc.sync:${uuidV7()}`,
    supportGrantId: null,
    severity: "warning",
  });
  logger.warn({ event: "gsc.sync.unauthorized", workspace_id: workspaceId, connection_id: connectionId });
}
