import { Inject, Injectable, Logger, type OnModuleDestroy } from "@nestjs/common";
import type { ClientBase, Pool, PoolClient } from "pg";
import { SCHEDULED_REPORT_MAX_RECIPIENTS } from "../../../contracts/reports/index.js";
import { loadEnv } from "../../config/env.js";
import { PG_POOL, isConnectionClassFailure } from "../../db/pg-pool.js";
import { RESEND_WORST_CASE_SEND_MS } from "../identity/adapters/resend-email-sender.adapter.js";
import type {
  CreateScheduledReportRequest,
  ScheduledReport,
  ScheduledReportDelivery,
  ScheduledReportListQuery,
  UpdateScheduledReportRequest,
} from "../../../contracts/reports/index.js";
import { FeatureNotInPlanError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { pageFrom, Page } from "../../api/pagination/page.js";
import { decodeTimestampIdCursor, MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import { isFeatureGranted, type FeatureFlagKey } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { isDayValidFor, nextSendAt, type ScheduleCadence } from "../../lib/reports/next-send-at.js";
import {
  buildReportArtifacts,
  CSV_ENTITLEMENT,
  describeCapSkip,
  failureReason,
  PDF_ENTITLEMENT,
  reportNeedsCsv,
  reportNeedsPdf,
  resolveReportSender,
  SCHEDULED_REPORT_COLUMNS,
  deliveryOutcome,
  sendReportEmails,
  writeCapSkipNotification,
  type ReportSender,
  type ScheduledReportRow,
} from "../../lib/reports/run-scheduled-report.js";
import { mailDepsFromEnv, planArtifactMail, type ArtifactMailPlan } from "../../lib/reports/report-artifact-mail.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import { commitTierCap, provisionUsageCounters, releaseTierCap, reserveTierCap } from "../../lib/usage/tier-caps.js";
import { afterCommit, currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { EMAIL_SENDER, type EmailSender } from "../identity/ports/email-sender.js";
import { ExportService } from "./export.service.js";

// NEW-E-100c — STORY-100 part C. Owns scheduled_reports and
// scheduled_report_deliveries. Calls Drizzle-free SQL on the ambient tenant
// transaction (RLS is the guarantee; nothing here filters by workspace for
// correctness).
//
// SEND-NOW. Zero credits. A pdf/both report consumes ONE pdf_exports unit per
// run (not per project), reserved before the build and committed with the
// delivery row. Three distinct outcomes, never conflated:
//   no allowance (cap 0)  403 feature_not_in_plan - upgrade; no attempt exists
//   cap reached           200, a `skipped_cap` delivery AND a notification
//                         naming the cap and the reset date - wait; never silent
//   build/send failure    200, a `failed` delivery with its reason
// THE SEND IS NOT IN THE REQUEST TRANSACTION (Group C review, owner decision B). The request reserves the cap, builds,
// commits the unit and records the delivery `sending`; the response is that `sending` row. AFTER the commit the emails go
// out and a second, short tenant transaction moves the row to its final state: `delivered` (a sender that really delivers,
// i.e. Resend accepted it), `logged` (a sender that delivers to nobody: never `delivered`), or `failed` (with last_error and
// the "N of M recipients" text). No row lock and no pooled connection is held while the provider is slow.
// A process that dies between the commit and the second transaction leaves the row `sending`; reads show a `sending` row
// older than STALE_SENDING_MS as `failed`, and the report group's stale-delivery sweep (lib/reports/stale-delivery-sweep.ts, STORY-183) rewrites the row itself.

const logger = new Logger("ScheduledReportsService");
/**
 * A `sending` delivery older than this reads as `failed`: its sender process is presumed dead. DERIVED, not chosen: the
 * recipients go one at a time, so the longest honest delivery is every recipient at the provider's worst case, plus a margin
 * for the cap/build before and the finalising transaction after. test/unit/scheduled-report-stale-window.spec.ts pins it, so
 * growing a recipient limit, timeout, attempt count or Retry-After cap fails there instead of silently turning slow sends into
 * `failed`. (25 x 90 s + 5 min = 42.5 min today.)
 */
export const STALE_SENDING_MARGIN_MS = 5 * 60 * 1000;
export const STALE_SENDING_MS = SCHEDULED_REPORT_MAX_RECIPIENTS * RESEND_WORST_CASE_SEND_MS + STALE_SENDING_MARGIN_MS;
/** How long shutdown waits for in-flight deliveries. Not the full window: a stuck one is left `sending` and reads stale. */
export const DELIVERY_DRAIN_TIMEOUT_MS = 30_000;
/** How long recording an outcome waits for a pooled connection before giving up (the row then stays `sending` and reads stale). */
export const DELIVERY_CONNECT_TIMEOUT_MS = 10_000;

/** The row shape and column list live with the cadence path (src/lib/reports/run-scheduled-report.ts) so the two cannot drift. */
type ReportRow = ScheduledReportRow;

interface DeliveryRow {
  id: string;
  scheduled_report_id: string;
  attempted_at: Date | string;
  status: ScheduledReportDelivery["status"];
  reason: string | null;
  recipient_count: number;
  /**
   * Computed by the DATABASE (see DELIVERY_COLUMNS): a `sending` row older than STALE_SENDING_MS. Judged on the database
   * clock, so an API host with a skewed clock cannot turn a live send into `failed`. `now()` is the START of the reading
   * transaction, which can only make a row look slightly younger, never older: the safe direction.
   */
  stale?: boolean;
}

/** The delivery columns every history read selects; `$N` is STALE_SENDING_MS as a bind parameter. */
const deliveryColumns = (staleParam: number): string =>
  `id, scheduled_report_id, attempted_at, status, reason, recipient_count,
   (status = 'sending' AND now() - attempted_at > $${String(staleParam)} * interval '1 millisecond') AS stale`;

const COLUMNS = SCHEDULED_REPORT_COLUMNS;

const iso = (v: Date | string): string => new Date(v).toISOString();

function toDelivery(r: DeliveryRow): ScheduledReportDelivery {
  if (r.status === "sending" && r.stale === true) {
    return { delivery_id: r.id, at: iso(r.attempted_at), status: "failed", reason: "delivery did not complete: the sending process did not report back", recipients: r.recipient_count };
  }
  return { delivery_id: r.id, at: iso(r.attempted_at), status: r.status, reason: r.reason, recipients: r.recipient_count };
}

function toReport(r: ReportRow, deliveries: DeliveryRow[]): ScheduledReport {
  return {
    id: r.id,
    label: r.name,
    project_ids: r.project_ids,
    sections: r.include_sections,
    cadence: r.cadence,
    day: r.day_of_period,
    hour: r.send_hour_local,
    format: r.format,
    recipients: r.recipients,
    timeframe: r.timeframe,
    theme_id: r.theme_id,
    paused: !r.active,
    next_run_at: r.next_send_at === null ? null : iso(r.next_send_at),
    deliveries: deliveries.filter((d) => d.scheduled_report_id === r.id).map((d) => toDelivery(d)),
  };
}

@Injectable()
export class ScheduledReportsService implements OnModuleDestroy {
  constructor(
    private readonly resolver: EntitlementResolver,
    private readonly usage: StructuralUsage,
    private readonly exports: ExportService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly objects: TenantObjectStore,
  ) {}

  /** Built once, on the first send-now (validated: a bad signing key fails closed there, not at boot). */
  private mailDeps: ReturnType<typeof mailDepsFromEnv> | undefined;

  /** Set at the start of shutdown: deliveries that have not yet begun sending do not begin (see `deliver`). */
  private stopping = false;

  /** Deliveries whose post-commit send is still running. Tracked so tests and shutdown can wait for them. */
  private readonly inflight = new Set<Promise<void>>();

  /** Resolves when every post-commit delivery started by this instance has finished (or failed to record). */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /**
   * Graceful shutdown: give in-flight deliveries a bounded chance to record their outcome. MUST run before DbModule ends
   * PG_POOL, because finalising takes a pooled connection. Nest runs every `onModuleDestroy` (modules in reverse distance
   * order) BEFORE any `beforeApplicationShutdown`, and DbModule ends the pool in its own `onModuleDestroy`, so the later
   * hook would be too late; this one is ordered ahead of DbModule's by module distance, which
   * test/integration/scheduled-reports-http.spec.ts proves on the real module graph.
   */
  async onModuleDestroy(): Promise<void> {
    // FIRST: a delivery whose turn comes after this point must not start a send the drain below can no longer wait for.
    this.stopping = true;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        logger.warn("scheduled report deliveries still running at shutdown; their rows stay sending and will read as stale");
        resolve();
      }, DELIVERY_DRAIN_TIMEOUT_MS);
    });
    try {
      await Promise.race([this.settled(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** NEW-E-7 checkpoint-6 — keyset page ordered (created_at DESC, id DESC); the cursor key carries the microsecond created_at. */
  async list(query: ScheduledReportListQuery): Promise<Page<ScheduledReport>> {
    const { client } = this.store();
    const after = query.cursor === undefined ? undefined : decodeTimestampIdCursor(query.cursor, "reports.scheduled_reports");
    const reports = await client.query<ReportRow & { created_at_key: string }>(
      `SELECT ${COLUMNS}, to_char(created_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS created_at_key
         FROM scheduled_reports
        WHERE ($1::timestamptz IS NULL OR (created_at, id) < ($1::timestamptz, $2::uuid))
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, query.limit + 1],
    );
    const page = pageFrom(reports.rows, query.limit, "reports.scheduled_reports", (r) => r, (r) => [r.created_at_key, r.id]);
    if (page.items.length === 0) return new Page<ScheduledReport>([], page.pagination);
    const deliveries = await client.query<DeliveryRow>(
      `SELECT ${deliveryColumns(2)}
         FROM scheduled_report_deliveries WHERE scheduled_report_id = ANY($1::uuid[]) ORDER BY attempted_at DESC, id DESC`,
      [page.items.map((r) => r.id), STALE_SENDING_MS],
    );
    return new Page(page.items.map((r) => toReport(r, deliveries.rows)), page.pagination);
  }

  async create(body: CreateScheduledReportRequest): Promise<ScheduledReport> {
    const { client, workspaceId, actorId } = this.store();
    const projectIds = [...new Set(body.project_ids)];
    this.assertDay(body.cadence, body.day);
    await this.assertProjectsReadable(client, projectIds);
    if (body.theme_id !== null) await this.assertThemeInWorkspace(client, body.theme_id);
    const next = nextSendAt({ cadence: body.cadence, day: body.day, hour: body.hour, timezone: await this.timezone(client) }, new Date());
    const inserted = await client.query<ReportRow>(
      `INSERT INTO scheduled_reports (id, workspace_id, name, project_ids, cadence, day_of_period, send_hour_local, timeframe, format,
                                      recipients, theme_id, include_sections, next_send_at, active, created_by)
       VALUES ($1,$2,$3,$4::uuid[],$5,$6,$7,$8,$9,$10::citext[],$11,$12::text[],$13,true,$14)
       RETURNING ${COLUMNS}`,
      [uuidV7(), workspaceId, body.label, projectIds, body.cadence, body.day, body.hour, body.timeframe, body.format,
        dedupeEmails(body.recipients), body.theme_id, body.sections, next, actorId],
    );
    this.log("created", workspaceId, inserted.rows[0]!.id);
    return toReport(inserted.rows[0]!, []);
  }

  async update(id: string, body: UpdateScheduledReportRequest): Promise<ScheduledReport> {
    const { client, workspaceId } = this.store();
    const current = await this.load(client, id);
    const cadence = body.cadence ?? current.cadence;
    const day = body.day ?? current.day_of_period;
    const hour = body.hour ?? current.send_hour_local;
    const active = body.paused === undefined ? current.active : !body.paused;
    this.assertDay(cadence, day);
    const projectIds = body.project_ids === undefined ? current.project_ids : [...new Set(body.project_ids)];
    if (body.project_ids !== undefined) await this.assertProjectsReadable(client, projectIds);
    if (body.theme_id !== undefined && body.theme_id !== null) await this.assertThemeInWorkspace(client, body.theme_id);
    const next = active ? nextSendAt({ cadence, day, hour, timezone: await this.timezone(client) }, new Date()) : null;
    const updated = await client.query<ReportRow>(
      `UPDATE scheduled_reports
          SET name = $2, project_ids = $3::uuid[], cadence = $4, day_of_period = $5, send_hour_local = $6, timeframe = $7, format = $8,
              recipients = $9::citext[], theme_id = $10, include_sections = $11::text[], next_send_at = $12, active = $13
        WHERE id = $1
    RETURNING ${COLUMNS}`,
      [id, body.label ?? current.name, projectIds, cadence, day, hour, body.timeframe ?? current.timeframe, body.format ?? current.format,
        dedupeEmails(body.recipients ?? current.recipients), body.theme_id === undefined ? current.theme_id : body.theme_id,
        body.sections ?? current.include_sections, next, active],
    );
    this.log("updated", workspaceId, id);
    return toReport(updated.rows[0]!, await this.deliveriesOf(client, id));
  }

  async remove(id: string): Promise<void> {
    const { client, workspaceId } = this.store();
    const deleted = await client.query("DELETE FROM scheduled_reports WHERE id = $1", [id]);
    if ((deleted.rowCount ?? 0) === 0) throw new NotFoundError({ message: "no such scheduled report" });
    this.log("deleted", workspaceId, id);
  }

  async sendNow(id: string): Promise<ScheduledReportDelivery> {
    const { client, workspaceId } = this.store();
    const report = await this.load(client, id);
    const entitlements = await this.resolver.resolveForWorkspace(workspaceId);
    const needsPdf = reportNeedsPdf(report.format);
    const needsCsv = reportNeedsCsv(report.format);

    // No allowance is an upgrade problem, refused before anything is reserved or built.
    for (const [needed, key] of [[needsPdf, PDF_ENTITLEMENT], [needsCsv, CSV_ENTITLEMENT]] as const) {
      if (needed && !isFeatureGranted(entitlements.entitlements[key]?.value ?? null)) {
        const minPlan = await this.usage.minimumPlanFor(key as FeatureFlagKey);
        throw new FeatureNotInPlanError({ details: { key, min_plan: minPlan ?? entitlements.plan_key } });
      }
    }

    const deliveryId = uuidV7();
    const jobId = `scheduled-report:${deliveryId}`;
    if (needsPdf) {
      const period = await resolveBillingPeriod(client, workspaceId);
      await provisionUsageCounters(client, workspaceId, period.start, entitlements.entitlements);
      const reserved = await reserveTierCap(client, { workspaceId, metric: "pdf_exports", periodStart: period.start, quantity: 1, jobId });
      if (!reserved.ok) return this.skipForCap(client, workspaceId, report, deliveryId, period.start, period.end);
    }

    await client.query("SAVEPOINT scheduled_report_build");
    let artifacts: string[];
    try {
      artifacts = await this.build(report);
      await client.query("RELEASE SAVEPOINT scheduled_report_build");
    } catch (error) {
      await client.query("ROLLBACK TO SAVEPOINT scheduled_report_build");
      if (needsPdf) await releaseTierCap(client, workspaceId, "pdf_exports", jobId);
      return this.record(client, workspaceId, report, deliveryId, "failed", failureReason(error), 0, null);
    }

    if (needsPdf) await commitTierCap(client, workspaceId, "pdf_exports", jobId);
    const recorded = await this.record(client, workspaceId, report, deliveryId, "sending", null, 0, artifacts[0] ?? null);
    // STORY-100 AC10: the agency's display name and Reply-To, read from the theme row in THIS transaction (the send itself
    // holds none) and carried to the post-commit send.
    const sender = await resolveReportSender(client, report.theme_id, entitlements.entitlements["whitelabel.remove_branding"]?.value === true);
    // STORY-180 AC3: attach or link, decided and (for a link) the token's hash stored, in THIS transaction. The bytes are read
    // after the commit, by the delivery.
    const mail = await planArtifactMail(client, { ...(this.mailDeps ??= mailDepsFromEnv(this.objects, loadEnv())), uploaded: (ids) => this.exports.uploaded(ids) }, workspaceId, artifacts, sender.theme?.showBrandLine ?? true);
    // The request's WHOLE tenant context (project scope included) carries to the second transaction.
    const context = currentTenantStore()!.context;
    afterCommit(() => this.startDelivery(context, report, deliveryId, mail, sender));
    return recorded;
  }

  /** Runs after the request transaction has committed. Never throws; a failure to record leaves the row `sending` (read as stale `failed`). */
  private startDelivery(context: TenantContext, report: ReportRow, deliveryId: string, mail: ArtifactMailPlan, sender: ReportSender): void {
    // setImmediate: the request's own connection is released right after its afterCommit tasks run, so the work (and the pooled
    // connection it takes for the second transaction) starts on the next turn, never while the request still holds its own.
    const work = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.deliver(context, report, deliveryId, mail, sender))
      .catch((error: unknown) => {
        logger.error({ message: "scheduled report delivery could not be finalised; the row stays sending", workspace_id: context.workspaceId, scheduled_report_id: report.id, error: error instanceof Error ? error.name : "unknown" });
      })
      .finally(() => this.inflight.delete(work));
    this.inflight.add(work);
  }

  private async deliver(context: TenantContext, report: ReportRow, deliveryId: string, mail: ArtifactMailPlan, sender: ReportSender): Promise<void> {
    if (this.stopping) {
      // Shutdown began before this delivery's turn: send NOTHING (the drain has already stopped waiting) and record it as
      // failed, best effort. If recording fails too, the row stays `sending`, reads `failed` after STALE_SENDING_MS, and no
      // mail went out, so a resend is the correct response.
      await this.recordOutcome(context, deliveryId, report.id, "failed", "server shutting down before send", 0);
      return;
    }
    // NOTE: `report.recipients` is the list captured at REQUEST time: edits made while the send runs do not change who is mailed.
    const result = await sendReportEmails(this.email, report, mail, sender);
    // `delivered` only when the sender really delivers mail; the logging/dev senders keep the owner's honesty rule (`logged`).
    const { status, reason } = deliveryOutcome(result, report.recipients.length, this.email.delivers === true);
    await this.recordOutcome(context, deliveryId, report.id, status, reason, result.sent);
  }

  /**
   * The second (post-commit) transaction. Not hold-and-wait: startDelivery deferred this to a later turn than the request's
   * release, and after the sends. If the report was DELETED while the send ran, the delivery row cascaded away with it and the
   * UPDATE matches 0 rows: a silent no-op, correctly.
   */
  private async recordOutcome(context: TenantContext, deliveryId: string, reportId: string, status: ScheduledReportDelivery["status"], reason: string | null, sent: number): Promise<void> {
    const client = await this.connectWithin(DELIVERY_CONNECT_TIMEOUT_MS);
    let failure: unknown;
    try {
      await withTenantContext(client, context, (tx) => this.finalize(tx, context.workspaceId, reportId, deliveryId, status, reason, sent));
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      // As TenantContextInterceptor does: a connection-class failure destroys the connection instead of returning it.
      if (failure !== undefined && isConnectionClassFailure(failure)) incrementCounter("nominara_db_connection_lost_total", { stage: "report_delivery" });
      client.release(failure !== undefined && isConnectionClassFailure(failure) ? (failure as Error) : undefined);
    }
  }

  /**
   * pg's Pool takes its wait bound pool-wide (`connectionTimeoutMillis`), not per call, so the bound is applied here: a
   * connection that arrives after the deadline is released straight back instead of leaking.
   */
  private async connectWithin(ms: number): Promise<PoolClient> {
    const connecting = this.pool.connect();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out waiting for a database connection to record the delivery")), ms);
    });
    try {
      return await Promise.race([connecting, timeout]);
    } catch (error) {
      void connecting.then((late) => late.release()).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** `WHERE status = 'sending'` makes a replay (a retried or duplicated finalisation) a no-op: the first outcome wins. */
  private async finalize(tx: ClientBase, workspaceId: string, reportId: string, deliveryId: string, status: ScheduledReportDelivery["status"], reason: string | null, sent: number): Promise<void> {
    const moved = await tx.query(
      `UPDATE scheduled_report_deliveries SET status = $2, reason = $3, recipient_count = $4 WHERE id = $1 AND status = 'sending'`,
      [deliveryId, status, reason, sent],
    );
    if ((moved.rowCount ?? 0) === 0) return;
    if (status === "failed") await tx.query("UPDATE scheduled_reports SET last_error = $2 WHERE id = $1", [reportId, reason]);
    else await tx.query("UPDATE scheduled_reports SET last_sent_at = now(), last_error = NULL WHERE id = $1", [reportId]);
    incrementCounter("nominara_reports_scheduled_deliveries_total", { status });
    logger.log({ span: "reports.scheduled.deliver", workspace_id: workspaceId, scheduled_report_id: reportId, status });
  }

  /** One export per project and format (the shared builder, so the request and cadence paths build identically). */
  private build(report: ReportRow): Promise<string[]> {
    return buildReportArtifacts(this.exports, report);
  }

  private async skipForCap(client: ClientBase, workspaceId: string, report: ReportRow, deliveryId: string, periodStart: string, resetsAt: string): Promise<ScheduledReportDelivery> {
    const skip = await describeCapSkip(client, workspaceId, periodStart, resetsAt);
    await writeCapSkipNotification(client, workspaceId, report, skip, resetsAt);
    return this.record(client, workspaceId, report, deliveryId, "skipped_cap", skip.reason, 0, null);
  }

  private async record(client: ClientBase, workspaceId: string, report: ReportRow, deliveryId: string, status: ScheduledReportDelivery["status"], reason: string | null, recipients: number, artifactId: string | null): Promise<ScheduledReportDelivery> {
    const inserted = await client.query<DeliveryRow>(
      `INSERT INTO scheduled_report_deliveries (id, workspace_id, scheduled_report_id, status, reason, recipient_count, report_artifact_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, scheduled_report_id, attempted_at, status, reason, recipient_count`,
      [deliveryId, workspaceId, report.id, status, reason, recipients, artifactId],
    );
    if (status === "logged") await client.query("UPDATE scheduled_reports SET last_sent_at = now(), last_error = NULL WHERE id = $1", [report.id]);
    if (status === "failed") await client.query("UPDATE scheduled_reports SET last_error = $2 WHERE id = $1", [report.id, reason]);
    // `sending` is not an outcome: each delivery is counted once, at its final status (see `finalize`).
    if (status !== "sending") incrementCounter("nominara_reports_scheduled_deliveries_total", { status });
    // Workspace ID and report ID only: no label, no recipients, no figures.
    logger.log({ span: "reports.scheduled.send_now", workspace_id: workspaceId, scheduled_report_id: report.id, status });
    return toDelivery(inserted.rows[0] ?? { id: deliveryId, scheduled_report_id: report.id, attempted_at: new Date(), status, reason, recipient_count: recipients });
  }

  private async load(client: ClientBase, id: string): Promise<ReportRow> {
    const found = await client.query<ReportRow>(`SELECT ${COLUMNS} FROM scheduled_reports WHERE id = $1`, [id]);
    const row = found.rows[0];
    if (row === undefined) throw new NotFoundError({ message: "no such scheduled report" });
    return row;
  }

  private async deliveriesOf(client: ClientBase, id: string): Promise<DeliveryRow[]> {
    const r = await client.query<DeliveryRow>(
      `SELECT ${deliveryColumns(2)}
         FROM scheduled_report_deliveries WHERE scheduled_report_id = $1 ORDER BY attempted_at DESC, id DESC`,
      [id, STALE_SENDING_MS],
    );
    return r.rows;
  }

  private async timezone(client: ClientBase): Promise<string> {
    const r = await client.query<{ timezone: string }>("SELECT timezone FROM workspaces LIMIT 1");
    return r.rows[0]?.timezone ?? "UTC";
  }

  private assertDay(cadence: ScheduleCadence, day: number): void {
    if (!isDayValidFor(cadence, day)) {
      throw new ValidationFailedError({
        message: `day ${String(day)} is out of range for a ${cadence} schedule`,
        details: { issues: [{ path: ["day"], message: cadence === "weekly" || cadence === "biweekly" ? "weekday must be 1-7" : "day of month must be 1-28" }] },
      });
    }
  }

  /** project_ids must be readable in this tenant context (RLS hides other workspaces' projects). */
  private async assertProjectsReadable(client: ClientBase, projectIds: readonly string[]): Promise<void> {
    const found = await client.query<{ id: string }>("SELECT id FROM projects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [projectIds]);
    const known = new Set(found.rows.map((r) => r.id));
    const missing = projectIds.findIndex((id) => !known.has(id));
    if (missing !== -1) {
      throw new ValidationFailedError({
        message: "project_ids names a project that does not exist in this workspace",
        details: { issues: [{ path: ["project_ids", missing], message: "no such project" }] },
      });
    }
  }

  private async assertThemeInWorkspace(client: ClientBase, themeId: string): Promise<void> {
    const found = await client.query("SELECT 1 FROM brand_themes WHERE id = $1", [themeId]);
    if (found.rows.length === 0) {
      throw new ValidationFailedError({
        message: "theme_id does not name a theme of this workspace",
        details: { issues: [{ path: ["theme_id"], message: "no such theme" }] },
      });
    }
  }

  private log(event: string, workspaceId: string, id: string): void {
    incrementCounter("nominara_reports_scheduled_changes_total", { event });
    logger.log({ span: "reports.scheduled.change", workspace_id: workspaceId, scheduled_report_id: id, event });
  }

  private store(): { client: ClientBase; workspaceId: string; actorId: string } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ScheduledReportsService requires an active tenant context");
    return { client: store.client, workspaceId: store.context.workspaceId, actorId: store.context.actorId };
  }
}

function dedupeEmails(emails: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const e of emails) if (!seen.has(e.toLowerCase())) seen.set(e.toLowerCase(), e);
  return [...seen.values()];
}
