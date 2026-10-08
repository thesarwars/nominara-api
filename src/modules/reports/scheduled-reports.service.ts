import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type {
  CreateScheduledReportRequest,
  ScheduledReport,
  ScheduledReportDelivery,
  UpdateScheduledReportRequest,
} from "../../../contracts/reports/index.js";
import { DomainError, FeatureNotInPlanError, NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { isFeatureGranted, type FeatureFlagKey } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { isDayValidFor, nextSendAt, type ScheduleCadence } from "../../lib/reports/next-send-at.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import { commitTierCap, provisionUsageCounters, readCounter, releaseTierCap, reserveTierCap, UNLIMITED_LIMIT } from "../../lib/usage/tier-caps.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
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
// The EmailSender port has only the logging adapter, so a delivery is recorded
// `logged`, never `delivered`.

const logger = new Logger("ScheduledReportsService");
const PDF_ENTITLEMENT = "exports.pdf_per_cycle";
const CSV_ENTITLEMENT = "exports.csv";
/**
 * The app origin an emailed artifact link is resolved against. A link is a URL, not an object-storage key (no
 * bucket key is built here; artifacts are inline this week). The download route is the signed-link story (scenario 11).
 */
const ARTIFACT_LINK_ORIGIN = "https://app.nominara.com";

interface ReportRow {
  id: string;
  name: string;
  project_ids: string[];
  cadence: ScheduleCadence;
  day_of_period: number;
  send_hour_local: number;
  timeframe: ScheduledReport["timeframe"];
  format: ScheduledReport["format"];
  recipients: string[];
  theme_id: string | null;
  include_sections: ScheduledReport["sections"];
  next_send_at: Date | string | null;
  active: boolean;
}

interface DeliveryRow {
  id: string;
  scheduled_report_id: string;
  attempted_at: Date | string;
  status: ScheduledReportDelivery["status"];
  reason: string | null;
  recipient_count: number;
}

const COLUMNS = `id, name, project_ids, cadence, day_of_period, send_hour_local, timeframe, format, recipients::text[] AS recipients,
                 theme_id, include_sections, next_send_at, active`;

const iso = (v: Date | string): string => new Date(v).toISOString();

function toDelivery(r: DeliveryRow): ScheduledReportDelivery {
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
    deliveries: deliveries.filter((d) => d.scheduled_report_id === r.id).map(toDelivery),
  };
}

function failureReason(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return `report build failed (${error instanceof Error ? error.name : "unknown"})`;
}

@Injectable()
export class ScheduledReportsService {
  constructor(
    private readonly resolver: EntitlementResolver,
    private readonly usage: StructuralUsage,
    private readonly exports: ExportService,
    @Inject(EMAIL_SENDER) private readonly email: EmailSender,
  ) {}

  async list(): Promise<ScheduledReport[]> {
    const { client } = this.store();
    const reports = await client.query<ReportRow>(`SELECT ${COLUMNS} FROM scheduled_reports ORDER BY created_at DESC, id`);
    if (reports.rows.length === 0) return [];
    const deliveries = await client.query<DeliveryRow>(
      `SELECT id, scheduled_report_id, attempted_at, status, reason, recipient_count
         FROM scheduled_report_deliveries WHERE scheduled_report_id = ANY($1::uuid[]) ORDER BY attempted_at DESC, id DESC`,
      [reports.rows.map((r) => r.id)],
    );
    return reports.rows.map((r) => toReport(r, deliveries.rows));
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
    const needsPdf = report.format === "pdf" || report.format === "both";
    const needsCsv = report.format === "csv" || report.format === "both";

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

    const failures = await this.sendEmails(report, artifacts);
    if (needsPdf) await commitTierCap(client, workspaceId, "pdf_exports", jobId);
    return failures === 0
      ? this.record(client, workspaceId, report, deliveryId, "logged", null, report.recipients.length, artifacts[0] ?? null)
      : this.record(client, workspaceId, report, deliveryId, "failed", `${String(failures)} of ${String(report.recipients.length)} recipients could not be sent`, report.recipients.length - failures, artifacts[0] ?? null);
  }

  /** One export per project and format; the export path is given no Idempotency-Key, so it commits no unit - the run's one unit is committed above. */
  private async build(report: ReportRow): Promise<string[]> {
    const formats = report.format === "both" ? (["pdf", "csv"] as const) : ([report.format] as const);
    const ids: string[] = [];
    for (const projectId of report.project_ids) {
      for (const format of formats) {
        const out = await this.exports.export(
          projectId,
          { format, sections: report.include_sections, timeframe: report.timeframe, hide_competitors: false, hide_costs: false },
          undefined,
        );
        ids.push(out.export_id);
      }
    }
    return ids;
  }

  private async sendEmails(report: ReportRow, artifacts: string[]): Promise<number> {
    const links = artifacts.map((a) => new URL(`/report-artifacts/${encodeURIComponent(a)}`, ARTIFACT_LINK_ORIGIN).href).join("\n");
    let failures = 0;
    for (const to of report.recipients) {
      try {
        await this.email.send({ to, subject: "Your scheduled Nominara report is ready", textBody: `Your report "${report.name}" is ready:\n${links}\n` });
      } catch {
        failures += 1;
      }
    }
    return failures;
  }

  private async skipForCap(client: ClientBase, workspaceId: string, report: ReportRow, deliveryId: string, periodStart: string, resetsAt: string): Promise<ScheduledReportDelivery> {
    const counter = await readCounter(client, workspaceId, "pdf_exports", periodStart);
    const cap = counter === undefined || counter.limitValue === UNLIMITED_LIMIT ? null : counter.limitValue;
    const capText = cap === null ? "the PDF export cap" : `the cap of ${String(cap)} PDF exports per cycle`;
    const reason = `Skipped: ${capText} is reached; it resets on ${resetsAt}.`;
    await client.query(
      `INSERT INTO notifications (id, workspace_id, kind, severity, title, body, payload)
       VALUES ($1,$2,'report.skipped_cap','warning',$3,$4,$5)`,
      [uuidV7(), workspaceId, "A scheduled report was skipped", `"${report.name}" was not sent. ${reason}`,
        JSON.stringify({ scheduled_report_id: report.id, cap, resets_at: resetsAt })],
    );
    return this.record(client, workspaceId, report, deliveryId, "skipped_cap", reason, 0, null);
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
    incrementCounter("nominara_reports_scheduled_deliveries_total", { status });
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
      `SELECT id, scheduled_report_id, attempted_at, status, reason, recipient_count
         FROM scheduled_report_deliveries WHERE scheduled_report_id = $1 ORDER BY attempted_at DESC, id DESC`,
      [id],
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
