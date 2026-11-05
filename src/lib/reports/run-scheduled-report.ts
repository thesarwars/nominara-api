import { createHash } from "node:crypto";
import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { REPORT_LINK_TTL_DAYS, type ExportRequest, type ScheduledReport } from "../../../contracts/reports/index.js";
import { DomainError } from "../../api/errors/domain-errors.js";
import { EmailSuppressedError, type EmailSender } from "../../modules/identity/ports/email-sender.js";
import { isFeatureGranted, type FeatureFlagKey } from "../entitlements/classification.js";
import type { EntitlementResolver } from "../entitlements/entitlement-resolver.js";
import type { StructuralUsage } from "../entitlements/structural-usage.js";
import { uuidV7 } from "../ids/uuidv7.js";
import { buildIdempotencyKey } from "../queue/idempotency.js";
import { writeNotification } from "../notifications/writer.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { resolveBillingPeriod } from "../usage/billing-period.js";
import { commitTierCap, provisionUsageCounters, readCounter, releaseTierCap, reserveTierCap, UNLIMITED_LIMIT } from "../usage/tier-caps.js";
import { advanceNextSendAt, type ScheduleCadence } from "./next-send-at.js";
import { planArtifactMail, resolveMailParts, type ArtifactMailDeps, type ArtifactMailPlan } from "./report-artifact-mail.js";

// STORY-100 — the DI-free core of running a scheduled report, shared by two callers: ScheduledReportsService (the request
// path, send-now) and the `report.build` queue handler (the cadence path, AC5). Nothing here knows about Nest: everything it
// needs is an argument, so a worker process can run it without a container.
//
// THE CADENCE PATH (owner decisions 2026-10-26, items 6 and 7). A due period is ONE signed `report.build` job keyed
// `rep:{report}:{period}`, where the period is the `next_send_at` that fired. The job is PHASED (ADR-0003 / NFR-ARCH-04):
//
//   prepare  one short tenant transaction: lock the report row, re-derive that the period is still due, check the plan and
//            the cap, RESERVE the export unit, BUILD the artifacts (pure computation over rollups, no network), record the
//            delivery `sending` and commit the unit. A cap skip and a terminal refusal settle the period right here.
//   run      NO transaction, no connection: the emails, one recipient at a time, each under a provider idempotency key that
//            is stable across the job's retries (so a retry cannot deliver twice). Any failure is THROWN until the final
//            attempt, so the queue retries on its documented ladder (topology: doubling(3)).
//   commit   a second short tenant transaction: the delivery's final status, and `next_send_at` ADVANCED.
//
// IDEMPOTENCY. The period moves on only in the transaction that settles it, so a redelivered job finds `next_send_at` no
// longer equal to its period and ends with nothing done. A retry after a failed send finds the delivery still `sending`
// (its id is derived from report and period, never random): it REUSES the artifacts the first prepare recorded (never rebuilds
// them: a rebuild mints new artifact ids, so the email body would differ under the same provider key, which Resend refuses
// with 409 invalid_idempotent_request) and does NOT reserve a second unit. Only when those artifacts are gone (purged) does it
// rebuild.
//
// FAILURE (owner decision 7): at the FINAL attempt a failure advances `next_send_at` (the period is skipped, so a broken
// report cannot retry forever or block later periods) and writes a notification naming the REASON. The reason is a domain
// error's own message or the error's class name, never raw text from the provider or an address. The rule holds for ANY failure
// on the final attempt, not only a build or a send one: the `report.build` handler's `recover` hook runs `settleAfterFailure`
// in a fresh transaction (a prepare or commit fault otherwise leaves a terminally failed job that wedges the report for
// `removeOnFail`'s 7 days and then runs a stale period late).

const logger = new Logger("reports.scheduled");

export const PDF_ENTITLEMENT = "exports.pdf_per_cycle";
export const CSV_ENTITLEMENT = "exports.csv";

export interface ScheduledReportRow {
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

export const SCHEDULED_REPORT_COLUMNS = `id, name, project_ids, cadence, day_of_period, send_hour_local, timeframe, format, recipients::text[] AS recipients,
                 theme_id, include_sections, next_send_at, active`;

/** What the report build needs from the export service (a structural type, so this module stays DI-free). */
export interface ReportExporter {
  export(projectId: string, body: ExportRequest, idempotencyKey: string | undefined): Promise<{ export_id: string }>;
  /** STORY-180: resolves when these artifacts' post-commit uploads have finished (immediately for ones this process did not upload). */
  uploaded(ids: readonly string[]): Promise<void>;
}

export interface ReportRunDeps {
  readonly resolver: Pick<EntitlementResolver, "resolveForWorkspace">;
  readonly usage: Pick<StructuralUsage, "minimumPlanFor">;
  readonly exports: ReportExporter;
  /** STORY-180 AC3: how the built files reach the recipients (attach or link). Required to prepare a run. */
  readonly mail?: Omit<ArtifactMailDeps, "uploaded">;
  readonly now?: () => Date;
}

/** The agency's identity on the email: a display name and a Reply-To, both optional. */
export interface ReportSender {
  readonly fromName?: string;
  readonly replyTo?: string;
}

export function reportNeedsPdf(format: ScheduledReport["format"]): boolean {
  return format === "pdf" || format === "both";
}

export function reportNeedsCsv(format: ScheduledReport["format"]): boolean {
  return format === "csv" || format === "both";
}

export function failureReason(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return `report build failed (${error instanceof Error ? error.name : "unknown"})`;
}

/**
 * The theme a report's email is sent under: the report's own theme, else the workspace default (the portal's rule). The ONE
 * place the mail identity is read, from the theme row, so there is no second branding source (STORY-097 AC4). A theme that
 * stores neither field, or none at all, gives an empty sender: the platform's own name, and no Reply-To header.
 */
export async function resolveReportSender(client: ClientBase, themeId: string | null): Promise<ReportSender> {
  const found = await client.query<{ email_from_name: string | null; email_reply_to: string | null }>(
    `SELECT email_from_name, email_reply_to FROM brand_themes
      WHERE ($1::uuid IS NOT NULL AND id = $1::uuid) OR is_default
      ORDER BY (id = $1::uuid) DESC NULLS LAST, is_default DESC, created_at, id LIMIT 1`,
    [themeId],
  );
  const row = found.rows[0];
  return {
    ...(row?.email_from_name != null ? { fromName: row.email_from_name } : {}),
    ...(row?.email_reply_to != null ? { replyTo: row.email_reply_to } : {}),
  };
}

/** One export per project and format; the export path is given no Idempotency-Key, so it commits no unit - the run's one unit is committed by the caller. */
export async function buildReportArtifacts(exporter: ReportExporter, report: ScheduledReportRow): Promise<string[]> {
  const formats = report.format === "both" ? (["pdf", "csv"] as const) : ([report.format] as const);
  const ids: string[] = [];
  for (const projectId of report.project_ids) {
    for (const format of formats) {
      const out = await exporter.export(
        projectId,
        { format, sections: report.include_sections, timeframe: report.timeframe, hide_competitors: false, hide_costs: false },
        undefined,
      );
      ids.push(out.export_id);
    }
  }
  return ids;
}

/**
 * The artifacts the FIRST prepare of this delivery built, in the order `buildReportArtifacts` builds them, or undefined when any
 * is gone. They are found by what they are (project, format) and by when they were made: the first prepare's transaction made
 * the artifacts and the delivery row at the same `now()`, so the earliest artifact at or after the delivery's `attempted_at` is
 * that prepare's. Reusing them keeps a retried email byte-identical, which the provider's idempotency key requires.
 */
async function recordedArtifacts(tx: ClientBase, report: ScheduledReportRow, deliveryId: string): Promise<string[] | undefined> {
  const formats = report.format === "both" ? (["pdf", "csv"] as const) : ([report.format] as const);
  const ids: string[] = [];
  for (const projectId of report.project_ids) {
    for (const format of formats) {
      const found = await tx.query<{ id: string }>(
        `SELECT a.id FROM report_artifacts a
           JOIN scheduled_report_deliveries d ON d.id = $1
          WHERE a.project_ids = ARRAY[$2]::uuid[] AND a.format = $3 AND a.created_at >= d.attempted_at AND a.expires_at > now() AND a.object_key NOT LIKE 'pending:%'
          ORDER BY a.created_at, a.id LIMIT 1`,
        [deliveryId, projectId, format],
      );
      const id = found.rows[0]?.id;
      if (id === undefined) return undefined;
      ids.push(id);
    }
  }
  return ids;
}

export interface SendReportEmailsResult {
  /** Recipients the sender accepted. */
  readonly sent: number;
  /** Recipients it did not (a failure of any kind, a refused lookup included). */
  readonly failed: number;
  /** STORY-178 — recipients NOT mailed because the address is suppressed (a bounce or a complaint). Not a failure: not retried. */
  readonly suppressed: number;
}

/**
 * The emails for one delivery, one recipient at a time, through the one EMAIL_SENDER path. `idempotencyBase`, when given,
 * makes each recipient's provider key stable across retries of the same logical delivery (a recipient is identified by a hash
 * of its address, so an edited list cannot send recipient B under recipient A's key).
 */
export async function sendReportEmails(
  email: EmailSender,
  report: { readonly name: string; readonly recipients: readonly string[] },
  plan: ArtifactMailPlan,
  sender: ReportSender,
  idempotencyBase?: string,
): Promise<SendReportEmailsResult> {
  // STORY-180 AC3: the files are resolved ONCE, before the first recipient. A file that never reached storage fails the whole
  // delivery (every recipient counts as failed and nothing is sent) rather than mailing a report with a file missing.
  let parts: Awaited<ReturnType<typeof resolveMailParts>>;
  try {
    parts = await resolveMailParts(plan);
  } catch (error) {
    incrementCounter("nominara_reports_mail_artifacts_total", { outcome: "unavailable" });
    logger.warn({ span: "reports.scheduled.mail_artifacts", outcome: "unavailable", error: error instanceof Error ? error.name : "unknown" });
    return { sent: 0, failed: report.recipients.length, suppressed: 0 };
  }
  incrementCounter("nominara_reports_mail_artifacts_total", { outcome: "ready" });
  const lines = [`Your report "${report.name}" is ready.`];
  if (parts.attachments.length > 0) lines.push("", "Attached:", ...parts.attachments.map((a) => `- ${a.filename}`));
  if (parts.links.length > 0) {
    lines.push("", `Too large to attach. Download (each link is valid for ${String(REPORT_LINK_TTL_DAYS)} days):`, ...parts.links.map((l) => `- ${l.filename}: ${l.url}`));
  }
  const textBody = `${lines.join("\n")}\n`;
  let failed = 0;
  let suppressed = 0;
  for (const to of report.recipients) {
    try {
      await email.send({
        to,
        subject: "Your scheduled Nominara report is ready",
        textBody,
        ...(parts.attachments.length > 0 ? { attachments: parts.attachments } : {}),
        ...(sender.fromName !== undefined ? { fromName: sender.fromName } : {}),
        ...(sender.replyTo !== undefined ? { replyTo: sender.replyTo } : {}),
        ...(idempotencyBase !== undefined ? { idempotencyKey: `${idempotencyBase}:${recipientDigest(to)}` } : {}),
      });
    } catch (error) {
      // A suppressed address is a decision, not a fault: retrying cannot change it, so it is counted apart from `failed`.
      if (error instanceof EmailSuppressedError) suppressed += 1;
      else failed += 1;
    }
  }
  return { sent: report.recipients.length - failed - suppressed, failed, suppressed };
}

/**
 * STORY-178 AC3 — a delivery's final status and reason from what the sends did. Shared by the request path (send-now) and the
 * cadence path, so both say the same thing. With no suppression the reason is exactly what it has always been.
 *
 *   any send failed            `failed`, "F of T recipients could not be sent" (+ the suppressed count when there is one)
 *   all suppressed, none sent  `failed`, "Not sent: all T recipients are suppressed ..."
 *   some suppressed, rest sent `delivered`/`logged`, with the reason naming how many were not sent
 *   otherwise                  `delivered`/`logged`, no reason
 * The wording names counts only: never an address.
 */
export function deliveryOutcome(result: { readonly sent: number; readonly failed: number; readonly suppressed: number }, total: number, delivers: boolean): { status: "delivered" | "logged" | "failed"; reason: string | null } {
  const { sent, failed, suppressed } = result;
  if (failed > 0) {
    const tail = suppressed > 0 ? `; ${String(suppressed)} not sent because the address is suppressed` : "";
    return { status: "failed", reason: `${String(failed)} of ${String(total)} recipients could not be sent${tail}` };
  }
  if (suppressed > 0 && sent === 0) {
    return { status: "failed", reason: `Not sent: all ${String(total)} recipients are suppressed after a bounce or a spam complaint` };
  }
  const status = delivers ? "delivered" : "logged";
  if (suppressed > 0) {
    return { status, reason: `${String(suppressed)} of ${String(total)} recipients were not sent: their addresses are suppressed after a bounce or a spam complaint` };
  }
  return { status, reason: null };
}

function recipientDigest(address: string): string {
  return createHash("sha256").update(address.trim().toLowerCase()).digest("hex").slice(0, 24);
}

export interface CapSkip {
  readonly cap: number | null;
  readonly reason: string;
}

/** The skip's reason, naming the cap and the reset date (STORY-100 AC: never silent). */
export async function describeCapSkip(client: ClientBase, workspaceId: string, periodStart: string, resetsAt: string): Promise<CapSkip> {
  const counter = await readCounter(client, workspaceId, "pdf_exports", periodStart);
  const cap = counter === undefined || counter.limitValue === UNLIMITED_LIMIT ? null : counter.limitValue;
  const capText = cap === null ? "the PDF export cap" : `the cap of ${String(cap)} PDF exports per cycle`;
  return { cap, reason: `Skipped: ${capText} is reached; it resets on ${resetsAt}.` };
}

export async function writeCapSkipNotification(client: ClientBase, workspaceId: string, report: { id: string; name: string }, skip: CapSkip, resetsAt: string): Promise<void> {
  await client.query(
    `INSERT INTO notifications (id, workspace_id, kind, severity, title, body, payload)
     VALUES ($1,$2,'report.skipped_cap','warning',$3,$4,$5)`,
    [uuidV7(), workspaceId, "A scheduled report was skipped", `"${report.name}" was not sent. ${skip.reason}`,
      JSON.stringify({ scheduled_report_id: report.id, cap: skip.cap, resets_at: resetsAt })],
  );
}

/**
 * The delivery id of one period's run: a valid UUIDv7 whose timestamp is the PERIOD and whose random bits are a hash of the
 * report, so the same (report, period) is the same row on every attempt without a lookup column. Still a time-ordered v7 id.
 */
export function scheduledRunDeliveryId(reportId: string, period: Date): string {
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(period.getTime() % 2 ** 48, 0, 6);
  const digest = createHash("sha256").update(`scheduled-report-run:${reportId}`).digest();
  bytes[6] = 0x70 | (digest[0]! & 0x0f);
  bytes[7] = digest[1]!;
  bytes[8] = 0x80 | (digest[2]! & 0x3f);
  for (let i = 1; i < 8; i += 1) bytes[8 + i] = digest[2 + i]!;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join("-");
}

/** The job's id for one report's period: `rep:{report}:{period}` (system-architecture.md §4). */
export function reportBuildJobKey(reportId: string, period: Date): string {
  return buildIdempotencyKey("report.build", { report: reportId, period: period.toISOString() });
}

// ---------------------------------------------------------------------------------------------------------------------
// The cadence phases
// ---------------------------------------------------------------------------------------------------------------------

/** What the prepare phase hands the run and commit phases. Ids, the recipients and the artifact ids: no figures. */
export interface PreparedRun {
  readonly workspaceId: string;
  readonly reportId: string;
  readonly reportName: string;
  readonly period: Date;
  readonly deliveryId: string;
  readonly recipients: readonly string[];
  readonly artifacts: readonly string[];
  /** STORY-180: what each artifact travels as (attached or linked). Set by prepare; the run phase refuses a prepared run without it. */
  readonly mail?: ArtifactMailPlan;
  readonly sender: ReportSender;
  readonly finalAttempt: boolean;
}

export type PrepareOutcome =
  | { readonly kind: "settled"; readonly outcome: "stale_period" | "report_gone" | "skipped_cap" | "refused" | "failed" }
  | { readonly kind: "send"; readonly prepared: PreparedRun };

export interface PrepareInput {
  readonly workspaceId: string;
  readonly reportId: string;
  readonly period: Date;
  /** True when this delivery is the job's last: a build failure then settles the period instead of retrying. */
  readonly finalAttempt: boolean;
}

interface ReportClock {
  readonly now: () => Date;
}

const clockOf = (deps: ReportRunDeps): ReportClock => ({ now: deps.now ?? (() => new Date()) });

export async function prepareScheduledRun(tx: ClientBase, deps: ReportRunDeps, input: PrepareInput): Promise<PrepareOutcome> {
  const { workspaceId, reportId, period, finalAttempt } = input;
  const found = await tx.query<ScheduledReportRow>(`SELECT ${SCHEDULED_REPORT_COLUMNS} FROM scheduled_reports WHERE id = $1 FOR UPDATE`, [reportId]);
  const report = found.rows[0];
  if (report === undefined) return { kind: "settled", outcome: "report_gone" };
  // Re-derived from the row, never trusted from the payload: an edit, a pause or an earlier delivery of this same job moved it.
  if (!report.active || report.next_send_at === null || new Date(report.next_send_at).getTime() !== period.getTime()) {
    return { kind: "settled", outcome: "stale_period" };
  }

  const deliveryId = scheduledRunDeliveryId(reportId, period);
  const existing = await tx.query<{ status: string }>("SELECT status FROM scheduled_report_deliveries WHERE id = $1", [deliveryId]);
  const resuming = existing.rows[0]?.status === "sending";
  const settle = (status: "failed" | "skipped_cap", reason: string, notification: SettleNotification) =>
    settleRun(tx, deps, report, { workspaceId, period, deliveryId, status, reason, sent: 0, artifactId: null, notification });

  // A project deleted since the schedule was made cannot be exported: terminal, not retryable.
  const known = await tx.query<{ id: string }>("SELECT id FROM projects WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL", [report.project_ids]);
  const live = new Set(known.rows.map((r) => r.id));
  if (report.project_ids.some((id) => !live.has(id))) {
    await settle("failed", "A project in this report no longer exists.", "failed");
    return { kind: "settled", outcome: "refused" };
  }

  const entitlements = await deps.resolver.resolveForWorkspace(workspaceId);
  // No allowance is an upgrade problem, not a transient one: nothing is reserved or built, and the period is settled.
  for (const [needed, key] of [[reportNeedsPdf(report.format), PDF_ENTITLEMENT], [reportNeedsCsv(report.format), CSV_ENTITLEMENT]] as const) {
    if (needed && !isFeatureGranted(entitlements.entitlements[key]?.value ?? null)) {
      const minPlan = (await deps.usage.minimumPlanFor(key as FeatureFlagKey)) ?? entitlements.plan_key;
      await settle("failed", `Your plan does not include ${key === PDF_ENTITLEMENT ? "PDF" : "CSV"} exports; the ${minPlan} plan unlocks them.`, "failed");
      return { kind: "settled", outcome: "refused" };
    }
  }

  const jobId = `scheduled-report:${deliveryId}`;
  const needsPdf = reportNeedsPdf(report.format);
  if (needsPdf && !resuming) {
    const billing = await resolveBillingPeriod(tx, workspaceId);
    await provisionUsageCounters(tx, workspaceId, billing.start, entitlements.entitlements);
    const reserved = await reserveTierCap(tx, { workspaceId, metric: "pdf_exports", periodStart: billing.start, quantity: 1, jobId });
    if (!reserved.ok) {
      const skip = await describeCapSkip(tx, workspaceId, billing.start, billing.end);
      await writeCapSkipNotification(tx, workspaceId, report, skip, billing.end);
      await settleRun(tx, deps, report, { workspaceId, period, deliveryId, status: "skipped_cap", reason: skip.reason, sent: 0, artifactId: null, notification: "none" });
      return { kind: "settled", outcome: "skipped_cap" };
    }
  }

  await tx.query("SAVEPOINT scheduled_report_build");
  let artifacts: string[];
  try {
    artifacts = (resuming ? await recordedArtifacts(tx, report, deliveryId) : undefined) ?? (await buildReportArtifacts(deps.exports, report));
    await tx.query("RELEASE SAVEPOINT scheduled_report_build");
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT scheduled_report_build");
    if (!finalAttempt) {
      // The throw rolls this whole transaction back (the reservation with it): the retry starts clean.
      incrementCounter("nominara_reports_build_attempts_total", { outcome: "retry" });
      throw error;
    }
    if (needsPdf && !resuming) await releaseTierCap(tx, workspaceId, "pdf_exports", jobId);
    await settle("failed", failureReason(error), "failed");
    return { kind: "settled", outcome: "failed" };
  }

  if (needsPdf && !resuming) await commitTierCap(tx, workspaceId, "pdf_exports", jobId);
  await tx.query(
    `INSERT INTO scheduled_report_deliveries (id, workspace_id, scheduled_report_id, status, reason, recipient_count, report_artifact_id)
     VALUES ($1,$2,$3,'sending',NULL,0,$4)
     ON CONFLICT (id) DO UPDATE SET report_artifact_id = EXCLUDED.report_artifact_id
       WHERE scheduled_report_deliveries.status = 'sending'`,
    [deliveryId, workspaceId, reportId, artifacts[0] ?? null],
  );
  if (deps.mail === undefined) throw new Error("a scheduled run needs its artifact mail dependencies");
  const mail = await planArtifactMail(tx, { ...deps.mail, uploaded: (ids) => deps.exports.uploaded(ids) }, workspaceId, artifacts);
  return {
    kind: "send",
    prepared: {
      mail,
      workspaceId,
      reportId,
      reportName: report.name,
      period,
      deliveryId,
      recipients: report.recipients,
      artifacts,
      sender: await resolveReportSender(tx, report.theme_id),
      finalAttempt,
    },
  };
}

export class ReportSendError extends Error {
  constructor(
    readonly failed: number,
    readonly total: number,
  ) {
    super(`${String(failed)} of ${String(total)} recipients could not be sent`);
    this.name = "ReportSendError";
  }
}

export interface RunOutcome {
  readonly sent: number;
  readonly failed: number;
  readonly suppressed: number;
  readonly delivers: boolean;
}

/**
 * The run phase: NO transaction and NO connection is held. A failure before the final attempt is THROWN (the queue retries on
 * its ladder; recipients that already received it are protected by the provider idempotency key). At the final attempt the
 * outcome is returned and the commit phase settles the period as failed.
 */
export async function sendPreparedRun(email: EmailSender, prepared: PreparedRun): Promise<RunOutcome> {
  if (prepared.mail === undefined) throw new Error("a prepared scheduled run carries no artifact plan");
  const result = await sendReportEmails(email, { name: prepared.reportName, recipients: prepared.recipients }, prepared.mail, prepared.sender, `scheduled-report/${prepared.deliveryId}`);
  if (result.failed > 0 && !prepared.finalAttempt) {
    incrementCounter("nominara_reports_build_attempts_total", { outcome: "retry" });
    throw new ReportSendError(result.failed, prepared.recipients.length);
  }
  return { sent: result.sent, failed: result.failed, suppressed: result.suppressed, delivers: email.delivers === true };
}

/** The commit phase: the delivery's final status and the period advanced, in one short tenant transaction. */
export async function commitPreparedRun(tx: ClientBase, deps: ReportRunDeps, prepared: PreparedRun, outcome: RunOutcome): Promise<void> {
  const found = await tx.query<ScheduledReportRow>(`SELECT ${SCHEDULED_REPORT_COLUMNS} FROM scheduled_reports WHERE id = $1 FOR UPDATE`, [prepared.reportId]);
  const report = found.rows[0];
  // Deleted while the send ran: the delivery cascaded away with it, so there is nothing to settle.
  if (report === undefined) return;
  // `delivered` only when the sender really delivers mail; the logging/dev senders keep the owner's honesty rule (`logged`).
  const { status, reason } = deliveryOutcome(outcome, prepared.recipients.length, outcome.delivers);
  await settleRun(tx, deps, report, {
    workspaceId: prepared.workspaceId,
    period: prepared.period,
    deliveryId: prepared.deliveryId,
    status,
    reason,
    sent: outcome.sent,
    artifactId: null,
    notification: status === "failed" ? "failed" : outcome.suppressed > 0 ? "suppressed" : "none",
  });
}

/**
 * The last resort of the FINAL attempt: whatever broke (a pool or DB error in prepare, a fault in commit), the period is settled
 * `failed` with a generic reason, `next_send_at` advances and the workspace is told. Runs in a FRESH tenant transaction. A period
 * that is no longer the report's due one (already settled, edited, paused, or the report gone) changes nothing.
 */
export async function settleAfterFailure(tx: ClientBase, deps: ReportRunDeps, input: { workspaceId: string; reportId: string; period: Date; error: unknown; sentUnknown?: boolean }): Promise<void> {
  const { workspaceId, reportId, period } = input;
  const found = await tx.query<ScheduledReportRow>(`SELECT ${SCHEDULED_REPORT_COLUMNS} FROM scheduled_reports WHERE id = $1 FOR UPDATE`, [reportId]);
  const report = found.rows[0];
  if (report === undefined || !report.active || report.next_send_at === null || new Date(report.next_send_at).getTime() !== period.getTime()) return;
  await settleRun(tx, deps, report, {
    workspaceId,
    period,
    deliveryId: scheduledRunDeliveryId(reportId, period),
    status: "failed",
    reason: input.sentUnknown === true ? `${failureReason(input.error)}; some recipients may already have been mailed` : failureReason(input.error),
    sent: 0,
    artifactId: null,
    notification: "failed",
  });
  incrementCounter("nominara_reports_build_attempts_total", { outcome: "recovered" });
}

type SettleNotification = "failed" | "suppressed" | "none";

/** `workspaces.timezone` is free text; a zone Intl rejects must not stop a settled period from advancing (UTC is the fallback). */
function usableZone(zone: string | undefined): string {
  if (zone === undefined) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

interface Settlement {
  readonly workspaceId: string;
  readonly period: Date;
  readonly deliveryId: string;
  readonly status: "delivered" | "logged" | "failed" | "skipped_cap";
  readonly reason: string | null;
  readonly sent: number;
  readonly artifactId: string | null;
  readonly notification: SettleNotification;
}

/**
 * Settles ONE period, in the caller's transaction: the delivery row reaches its final status, the report row records it, a
 * failure notifies the workspace with the reason, and `next_send_at` ADVANCES (compare-and-set on the period, so a second
 * settlement of the same period changes nothing). A failed or skipped period advances too (owner decision 7).
 */
async function settleRun(tx: ClientBase, deps: ReportRunDeps, report: ScheduledReportRow, s: Settlement): Promise<void> {
  const { workspaceId, deliveryId, status, reason } = s;
  await tx.query(
    `INSERT INTO scheduled_report_deliveries (id, workspace_id, scheduled_report_id, status, reason, recipient_count, report_artifact_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, recipient_count = EXCLUDED.recipient_count
       WHERE scheduled_report_deliveries.status = 'sending'`,
    [deliveryId, workspaceId, report.id, status, reason, s.sent, s.artifactId],
  );
  if (status === "failed") await tx.query("UPDATE scheduled_reports SET last_error = $2 WHERE id = $1", [report.id, reason]);
  else if (status !== "skipped_cap") await tx.query("UPDATE scheduled_reports SET last_sent_at = now(), last_error = NULL WHERE id = $1", [report.id]);

  if (s.notification === "failed") {
    await writeNotification(tx, {
      workspaceId,
      projectId: null,
      userId: null,
      kind: "report.failed",
      severity: "warning",
      title: "A scheduled report could not be sent",
      body: `"${report.name}" was not sent for this period and will next run on its following date. Reason: ${reason ?? "unknown"}.`,
      eventKey: `report.failed:${report.id}:${s.period.toISOString()}`,
      facts: { scheduled_report_id: report.id, period: s.period.toISOString() },
    });
  }

  if (s.notification === "suppressed") {
    await writeNotification(tx, {
      workspaceId,
      projectId: null,
      userId: null,
      kind: "report.recipient_suppressed",
      severity: "warning",
      title: "A scheduled report skipped a suppressed recipient",
      body: `"${report.name}" was sent, but not to every recipient: ${reason ?? "some addresses are suppressed"}. Remove or replace the address in the report's recipients.`,
      eventKey: `report.recipient_suppressed:${report.id}:${s.period.toISOString()}`,
      facts: { scheduled_report_id: report.id, period: s.period.toISOString() },
    });
  }

  const zone = await tx.query<{ timezone: string }>("SELECT timezone FROM workspaces WHERE id = $1", [workspaceId]);
  const next = advanceNextSendAt(
    { cadence: report.cadence, day: report.day_of_period, hour: report.send_hour_local, timezone: usableZone(zone.rows[0]?.timezone) },
    s.period,
    clockOf(deps).now(),
  );
  await tx.query("UPDATE scheduled_reports SET next_send_at = $3 WHERE id = $1 AND next_send_at = $2", [report.id, s.period, next]);

  incrementCounter("nominara_reports_scheduled_deliveries_total", { status });
  incrementCounter("nominara_reports_build_attempts_total", { outcome: status });
  // Workspace ID and report ID only: no label, no recipients, no figures.
  logger.log({ span: "reports.scheduled.cadence", workspace_id: workspaceId, scheduled_report_id: report.id, status });
}
