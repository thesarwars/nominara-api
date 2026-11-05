import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import type { DataSource } from "../../../contracts/analytics/index.js";
import { type ExportRequest, type ExportResponse, type ReportSection } from "../../../contracts/reports/index.js";
import { afterTransaction } from "../../api/after-transaction.js";
import { DegradedError, FeatureNotInPlanError, NotFoundError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { combineDataSources, engineDataSourcesForDates } from "../../lib/analytics/data-source.js";
import { resolveWindow } from "../../lib/analytics/window.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { isFeatureGranted, type FeatureFlagKey } from "../../lib/entitlements/classification.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { failedKey, pendingKey } from "../../lib/reports/artifact-key.js";
import { renderCsv } from "../../lib/reports/export-csv.js";
import {
  buildExportDocument,
  type CompetitorSummary,
  type EngineSummary,
  type GrowthMapDay,
  type MetricSummary,
} from "../../lib/reports/export-document.js";
import { renderPdf } from "../../lib/reports/export-pdf.js";
import { CROSS_ENGINE_KEY } from "../../lib/rollup/roll-up-day.js";
import { confidenceFor } from "../../lib/scoring/index.js";
import type { BoundObjectStore } from "../../lib/storage/tenant-object-store.js";
import { TenantObjectStore } from "../../lib/storage/tenant-object-store.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { resolveBillingPeriod } from "../../lib/usage/billing-period.js";
import { commitTierCap, limitValueFor, readCounter, releaseTierCap, UNLIMITED_LIMIT } from "../../lib/usage/tier-caps.js";
import { exportPaletteFrom, type ExportPalette, type StoredThemeValues } from "../../lib/theme/export-palette.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { afterCommit, currentTenantStore, withTenantContext, type TenantContext } from "../../tenancy/tenant-context.js";
import { exportDownloadUrl, EXPORT_PUBLIC_BASE_URL } from "./export-download.service.js";
import { MethodologyService, TIMEFRAME_DAYS } from "./methodology.service.js";

// NEW-E-100b — POST /v1/projects/{id}/reports/export (STORY-100, NFR-AGY-05).
//
// OWNER DECISION (E-0): the synchronous per-project path. The file is built in
// the request. Rendering is pure computation over rollup rows: no network call,
// so KAD-06 holds.
//
// STORY-180 (owner decisions 54 and 60): THE FILE LIVES IN OBJECT STORAGE AND THE EXPORT WAITS FOR IT. The row is recorded in the
// request transaction with `object_key = 'pending:<id>'`. After that transaction COMMITS, and after its pooled connection is released
// (TenantContextInterceptor, afterTransaction), the file is uploaded to `nominara-reports` with no transaction open, ONE short tenant
// transaction records the real key, and only then does the request answer. `download_url` is the API's download route
// (export-download.service.ts), which presigns the STORED key afresh on each click, so it works the moment the response arrives.
// Storage readiness is checked BEFORE the request transaction opens (StorageReadyGuard), so unconfigured storage answers 503
// `degraded` before anything is rendered; there is no inline fallback.
//
// A FAILED UPLOAD IS NEVER LEFT PENDING. If the put fails, the row is marked `failed:<id>`. If the put landed but the key could not
// be recorded, the object is deleted first (no connection held) and then the row is marked `failed:<id>`. Either way the request
// answers 503 `degraded`. If the marking itself fails (the database is the thing that is down) the row stays `pending:` and the
// nightly report cleanup deletes its object and marks it purged. A PDF's `pdf_exports` unit is committed with the row and is NOT
// returned on a failed upload; a retry under the same Idempotency-Key finds the unit already committed and costs nothing more.
//
// WHAT COMES FROM WHERE
//   figures   `metric_daily` only (the rollups), cells-weighted over the window
//   footer    MethodologyService.footer() - the ONE footer builder, shared with
//             the portal. This service passes it to the document as a required
//             input and offers no way to omit it.
//   palette   the workspace's default `brand_themes` row, else the platform
//             default (src/lib/theme/export-palette.ts). Only colours and the
//             brand-line flag are used.
//
// METERING. A PDF consumes one `pdf_exports` unit. QuotaGuard (`@Meter` on the
// route) has already RESERVED it under the Idempotency-Key, and this service
// COMMITS that reservation in the same transaction as the artifact row, so a
// rolled-back export never counts and a committed one always does. A CSV
// consumes none: it is gated by `exports.csv` here. Zero credits either way.

const logger = new Logger("ExportService");

/** The entitlement that lets a theme hide the Nominara brand line (same key AgencyService checks on save). */
const BRAND_REMOVAL_FEATURE = "whitelabel.remove_branding";

/** How long an artifact row is retained as downloadable. */
const ARTIFACT_TTL_DAYS = 7;

/** How long a failed upload is remembered by `uploaded()`. */
const FAILED_UPLOAD_MEMORY_MS = 10 * 60_000;

/** How a post-commit upload ended. Only `ok` leaves a stored file and a row that says so. */
type UploadOutcome = "ok" | "put_failed" | "record_failed" | "orphan_removed" | "error";

interface AggregateRow {
  entity_id: string;
  engine_key: string;
  cells: string;
  present: string;
  visibility: number | null;
  sov: number | null;
  sentiment: number | null;
  citation: number | null;
}

function summaryOf(row: AggregateRow | undefined, dataSource: DataSource | null): MetricSummary {
  const cells = row === undefined ? 0 : Number(row.cells);
  if (row === undefined || cells === 0) {
    return { visibilityScore: null, presenceRate: null, shareOfVoice: null, sentimentScore: null, citationShare: null, measuredCells: 0, confidence: null, dataSource };
  }
  return {
    visibilityScore: row.visibility,
    presenceRate: Number(row.present) / cells,
    shareOfVoice: row.sov,
    sentimentScore: row.sentiment,
    citationShare: row.citation,
    measuredCells: cells,
    confidence: confidenceFor(cells),
    dataSource,
  };
}

@Injectable()
export class ExportService {
  constructor(
    private readonly methodology: MethodologyService,
    private readonly resolver: EntitlementResolver,
    private readonly usage: StructuralUsage,
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly objects: TenantObjectStore,
    /** The API's public origin the download route is addressed on (OAUTH_REDIRECT_BASE_URL). */
    @Inject(EXPORT_PUBLIC_BASE_URL) private readonly publicBaseUrl: string,
  ) {}

  /** Post-commit uploads still running, by artifact id. The scheduled path waits on these through `uploaded()`. */
  private readonly uploads = new Map<string, Promise<UploadOutcome>>();

  /**
   * Resolves when the named artifacts' uploads (started by THIS process) have finished. Unknown ids resolve at once. REJECTS (503
   * `degraded`) if any of them did not end stored: a scheduled email must not go out over a file that is not there.
   */
  async uploaded(ids: readonly string[]): Promise<void> {
    const outcomes = await Promise.all(ids.map((id) => this.uploads.get(id)));
    if (outcomes.some((outcome) => outcome !== undefined && outcome !== "ok")) throw new DegradedError({ message: "a report file could not be stored" });
  }

  /**
   * `options.awaitUpload` (the HTTP export route only): the request does not answer until the file is stored, and fails if it could not
   * be. Without it (the scheduled path, whose delivery waits through `uploaded()`) the upload runs after commit and nothing holds a response.
   */
  async export(projectId: string, body: ExportRequest, idempotencyKey: string | undefined, options: { readonly awaitUpload?: boolean } = {}): Promise<ExportResponse> {
    const started = Date.now();
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ExportService requires an active tenant context");
    const tx = store.client;
    const workspaceId = store.context.workspaceId;
    const exportId = uuidV7();
    const relativeKey = `${exportId}.${body.format}`;

    try {
      const bound = this.objects.bind();

      const entitlements = await this.resolver.resolveForWorkspace(workspaceId);

      // CSV is a feature gate, not a metered one (the PDF cap was already
      // enforced by QuotaGuard). Refused as 403 with the key and the unlocking plan.
      if (body.format === "csv") {
        const granted = isFeatureGranted(entitlements.entitlements["exports.csv"]?.value ?? null);
        if (!granted) {
          const minPlan = await this.usage.minimumPlanFor("exports.csv" as FeatureFlagKey);
          throw new FeatureNotInPlanError({ details: { key: "exports.csv", min_plan: minPlan ?? entitlements.plan_key } });
        }
      }

      const project = await tx.query<{ name: string }>(
        "SELECT name FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL",
        [projectId, workspaceId],
      );
      if (project.rows[0] === undefined) throw new NotFoundError({ message: "no such project" });

      const days = TIMEFRAME_DAYS[body.timeframe];
      const window = await resolveWindow(tx, projectId, days);
      const footer = await this.methodology.footer(projectId, { timeframe: body.timeframe });
      const scoringVersion = footer.scoring_version;
      const sources = await engineDataSourcesForDates(tx, projectId, window.from, window.to, window.timezone, scoringVersion);
      const wanted = new Set<ReportSection>(body.sections);

      const brand = await this.aggregate(tx, projectId, scoringVersion, "brand", window.from, window.to);
      const engineSummary = (rows: AggregateRow[]): { blended: MetricSummary; engines: EngineSummary[] } => {
        const engines = rows
          .filter((r) => r.engine_key !== CROSS_ENGINE_KEY)
          .sort((a, b) => (a.engine_key < b.engine_key ? -1 : 1))
          .map((r): EngineSummary => ({ engineKey: r.engine_key, ...summaryOf(r, sources.get(r.engine_key) ?? null) }));
        const blend = rows.find((r) => r.engine_key === CROSS_ENGINE_KEY);
        return { engines, blended: summaryOf(blend, combineDataSources(engines.map((e) => e.dataSource))) };
      };

      const overview = engineSummary(brand);
      const growthMap = wanted.has("growth_map")
        ? await this.growthMap(tx, projectId, scoringVersion, window.from, window.to)
        : { engineKeys: [] as string[], days: [] as GrowthMapDay[] };

      let competitors: CompetitorSummary[] = [];
      if (wanted.has("competitors") && !body.hide_competitors) {
        const rows = await this.aggregate(tx, projectId, scoringVersion, "competitor", window.from, window.to);
        const names = await tx.query<{ id: string; name: string }>(
          "SELECT id, name FROM competitors WHERE project_id = $1 AND deleted_at IS NULL ORDER BY lower(name), id",
          [projectId],
        );
        competitors = names.rows
          .map((c) => ({ name: c.name, ...engineSummary(rows.filter((r) => r.entity_id === c.id)) }))
          .filter((c) => c.engines.length > 0 || c.blended.measuredCells > 0);
      }

      const doc = buildExportDocument({
        projectName: project.rows[0].name,
        generatedAt: new Date().toISOString(),
        timeframe: body.timeframe,
        window: { from: window.from, to: window.to },
        palette: await this.palette(tx, entitlements.entitlements[BRAND_REMOVAL_FEATURE]?.value === true),
        footer,
        sections: body.sections,
        hideCompetitors: body.hide_competitors,
        hideCosts: body.hide_costs,
        overview,
        growthMap,
        competitors,
      });

      const file = body.format === "pdf" ? await renderPdf(doc) : Buffer.from(renderCsv(doc), "utf8");
      await tx.query(
        `INSERT INTO report_artifacts
           (id, workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at)
         VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9::jsonb, now() + make_interval(days => $10::int))`,
        [exportId, workspaceId, [projectId], window.from, window.to, body.format, pendingKey(exportId), file.length, JSON.stringify(footer), ARTIFACT_TTL_DAYS],
      );

      this.scheduleUpload(bound, store.context, { id: exportId, relativeKey, file, contentType: body.format === "pdf" ? "application/pdf" : "text/csv" }, options.awaitUpload === true);

      if (body.format === "pdf" && idempotencyKey !== undefined) {
        await commitTierCap(tx, workspaceId, "pdf_exports", idempotencyKey);
      }
      const pdf = await this.pdfUsage(tx, workspaceId, entitlements.entitlements["exports.pdf_per_cycle"]?.value ?? null);

      incrementCounter("nominara_reports_exports_total", { format: body.format, outcome: "ok" });
      // Workspace ID, never its name; no figures, no names, no engine text.
      logger.log({
        span: "reports.export",
        workspace_id: workspaceId,
        project_id: projectId,
        format: body.format,
        sections: doc.sections.length,
        unavailable_sections: doc.unavailableSections.length,
        bytes: file.length,
        duration_ms: Date.now() - started,
      });

      const stamp = window.to;
      return {
        export_id: exportId,
        format: body.format,
        filename: `nominara-report-${stamp}.${body.format}`,
        download_url: exportDownloadUrl(this.publicBaseUrl, exportId),
        footer,
        pdf,
      };
    } catch (error) {
      incrementCounter("nominara_reports_exports_total", { format: body.format, outcome: "error" });
      if (error instanceof NotFoundError && body.format === "pdf" && idempotencyKey !== undefined) {
        await this.releaseIfUnserved(workspaceId, idempotencyKey);
      }
      throw error;
    }
  }

  /**
   * STORY-180 AC1 + owner decision 60 (c). Registers the upload to run AFTER this request's transaction commits (a rolled-back export
   * uploads nothing), and makes the request WAIT for it: the response is produced only once the file is stored, and fails (503
   * `degraded`) if it could not be. Public so the ordering is testable; call it only from `export`.
   *
   * The work: put the object (no transaction open, no connection held), then ONE short tenant transaction records the real key. If the
   * row is gone by then (rolled back to a savepoint after the upload was registered) the orphan object is deleted. A failed upload
   * marks the row `failed:` (see the header) and never throws out of the background work; the request-side wait (`awaitInRequest`, the HTTP
   * export route) is what reports it. The scheduled path holds no response and waits through `uploaded()`.
   */
  scheduleUpload(bound: BoundObjectStore, context: TenantContext, artifact: { id: string; relativeKey: string; file: Buffer; contentType: string }, awaitInRequest = false): void {
    let settle!: (outcome: UploadOutcome) => void;
    const outcome = new Promise<UploadOutcome>((resolve) => {
      settle = resolve;
    });
    afterCommit(() => {
      const work: Promise<UploadOutcome> = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.upload(bound, context, artifact))
        .catch((error: unknown): UploadOutcome => {
          logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "error", error: error instanceof Error ? error.name : "unknown" });
          return "error";
        })
        .then((result) => {
          settle(result);
          // A success is forgotten at once (a later uploaded() finds nothing and resolves). A FAILURE is remembered for a while, so a
          // scheduled delivery that asks after the upload has already failed still refuses to mail over a file that is not stored.
          if (result === "ok") this.uploads.delete(artifact.id);
          else setTimeout(() => this.uploads.delete(artifact.id), FAILED_UPLOAD_MEMORY_MS).unref();
          return result;
        });
      this.uploads.set(artifact.id, work);
    });
    if (!awaitInRequest) return;
    afterTransaction(async () => {
      if ((await outcome) !== "ok") throw new DegradedError({ message: "the export file could not be stored: retry the export" });
    });
  }

  private async upload(bound: BoundObjectStore, context: TenantContext, artifact: { id: string; relativeKey: string; file: Buffer; contentType: string }): Promise<UploadOutcome> {
    const started = Date.now();
    let key: string;
    try {
      key = await bound.put("reports", artifact.relativeKey, artifact.file, { contentType: artifact.contentType });
    } catch (error) {
      incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "put_failed" });
      logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "put_failed", error: error instanceof Error ? error.name : "unknown", duration_ms: Date.now() - started });
      await this.markFailed(context, artifact.id);
      return "put_failed";
    }
    let recorded: boolean;
    try {
      const client = await this.pool.connect();
      try {
        const result = await withTenantContext(client, context, (tx) =>
          tx.query("UPDATE report_artifacts SET object_key = $2 WHERE id = $1 AND object_key = $3 AND workspace_id = app.current_workspace()", [artifact.id, key, pendingKey(artifact.id)]),
        );
        recorded = (result.rowCount ?? 0) > 0;
      } finally {
        client.release();
      }
    } catch (error) {
      incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "record_failed" });
      logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "record_failed", error: error instanceof Error ? error.name : "unknown", duration_ms: Date.now() - started });
      // The object is there and the row does not say so. Delete the object FIRST (no connection held), then mark the row: if the delete
      // fails the row stays pending, and the nightly cleanup deletes the object (idempotently) and marks the row.
      if (await this.deleteQuietly(bound, artifact.relativeKey, context)) await this.markFailed(context, artifact.id);
      return "record_failed";
    }
    if (!recorded) {
      // The row is gone (rolled back to a savepoint after the upload was registered): remove the orphan with NO connection held.
      await this.deleteQuietly(bound, artifact.relativeKey, context);
      incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "orphan_removed" });
      logger.warn({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "orphan_removed", duration_ms: Date.now() - started });
      return "orphan_removed";
    }
    incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "ok" });
    // Workspace ID and sizes only: no key, no URL, no figures.
    logger.log({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "ok", bytes: artifact.file.length, duration_ms: Date.now() - started });
    return "ok";
  }

  /** Deletes the object outside any transaction. True when it is gone (delete is idempotent). Never throws. */
  private async deleteQuietly(bound: BoundObjectStore, relativeKey: string, context: TenantContext): Promise<boolean> {
    try {
      await bound.delete("reports", relativeKey);
      return true;
    } catch (error) {
      incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "delete_failed" });
      logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "delete_failed", error: error instanceof Error ? error.name : "unknown" });
      return false;
    }
  }

  /** One short tenant transaction: `pending:<id>` becomes `failed:<id>`. Never throws; if it cannot, the row stays pending for the nightly cleanup. */
  private async markFailed(context: TenantContext, id: string): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await withTenantContext(client, context, (tx) =>
          tx.query("UPDATE report_artifacts SET object_key = $2 WHERE id = $1 AND object_key = $3 AND workspace_id = app.current_workspace()", [id, failedKey(id), pendingKey(id)]),
        );
      } finally {
        client.release();
      }
    } catch (error) {
      incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "mark_failed_failed" });
      logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "mark_failed_failed", error: error instanceof Error ? error.name : "unknown" });
    }
  }

  /**
   * Cumulative weighted figures per (entity, engine) over the window, from `metric_daily` only.
   * Presence is cells_present / cells_total exactly; the other ratios are cells- (or the
   * denominator's) weighted means of the daily rows, and are NULL when their denominator is 0
   * - the table coalesces them to 0, which on the wire would read as a measured zero.
   */
  private async aggregate(
    tx: ClientBase,
    projectId: string,
    scoringVersion: string,
    entityType: "brand" | "competitor",
    from: string,
    to: string,
  ): Promise<AggregateRow[]> {
    const result = await tx.query<AggregateRow>(
      `SELECT entity_id::text, engine_key,
              sum(cells_total)::text   AS cells,
              sum(cells_present)::text AS present,
              (sum(visibility_score * cells_total) / NULLIF(sum(cells_total), 0))::float8 AS visibility,
              (sum(sov * cells_total)              / NULLIF(sum(cells_total), 0))::float8 AS sov,
              (sum(sentiment_score * mentions_total) / NULLIF(sum(mentions_total), 0))::float8 AS sentiment,
              (sum(citation_share * citations_total) / NULLIF(sum(citations_total), 0))::float8 AS citation
         FROM metric_daily
        WHERE project_id = $1 AND scoring_version = $2 AND entity_type = $3
          AND metric_date BETWEEN $4::date AND $5::date
        GROUP BY entity_id, engine_key`,
      [projectId, scoringVersion, entityType, from, to],
    );
    return result.rows;
  }

  private async growthMap(
    tx: ClientBase,
    projectId: string,
    scoringVersion: string,
    from: string,
    to: string,
  ): Promise<{ engineKeys: string[]; days: GrowthMapDay[] }> {
    const result = await tx.query<{ metric_date: string; engine_key: string; visibility: number | null }>(
      `SELECT to_char(metric_date, 'YYYY-MM-DD') AS metric_date, engine_key,
              CASE WHEN sum(cells_total) > 0
                   THEN (sum(visibility_score * cells_total) / sum(cells_total))::float8 END AS visibility
         FROM metric_daily
        WHERE project_id = $1 AND scoring_version = $2 AND entity_type = 'brand'
          AND metric_date BETWEEN $3::date AND $4::date
        GROUP BY metric_date, engine_key
        ORDER BY metric_date, engine_key`,
      [projectId, scoringVersion, from, to],
    );
    const engineKeys = [...new Set(result.rows.filter((r) => r.engine_key !== CROSS_ENGINE_KEY).map((r) => r.engine_key))].sort();
    const byDate = new Map<string, GrowthMapDay>();
    for (const row of result.rows) {
      const day = byDate.get(row.metric_date) ?? { date: row.metric_date, blended: null, byEngine: Object.fromEntries(engineKeys.map((k) => [k, null])) };
      if (row.engine_key === CROSS_ENGINE_KEY) day.blended = row.visibility;
      else day.byEngine[row.engine_key] = row.visibility;
      byDate.set(row.metric_date, day);
    }
    return { engineKeys, days: [...byDate.values()] };
  }

  /**
   * The workspace's default theme as a palette (platform default when none is stored). Brand removal is
   * re-checked against the CURRENT entitlements, not trusted from the stored flag.
   */
  private async palette(tx: ClientBase, brandRemovalGranted: boolean): Promise<ExportPalette> {
    const result = await tx.query<StoredThemeValues>(
      `SELECT color_primary, color_accent, color_bg, color_fg, hide_nominara_brand
         FROM brand_themes ORDER BY is_default DESC, created_at, id LIMIT 1`,
    );
    return exportPaletteFrom(result.rows[0], brandRemovalGranted);
  }

  /** used / cap for the response. `cap` null = uncapped; a zero cap is returned as 0. */
  private async pdfUsage(tx: ClientBase, workspaceId: string, entitlement: unknown): Promise<{ used: number; cap: number | null }> {
    const period = await resolveBillingPeriod(tx, workspaceId);
    const counter = await readCounter(tx, workspaceId, "pdf_exports", period.start);
    if (counter !== undefined) {
      return { used: counter.usedValue, cap: counter.limitValue === UNLIMITED_LIMIT ? null : counter.limitValue };
    }
    // No counter yet (a CSV-only workspace this cycle): nothing used; the cap is the plan's.
    const limit = limitValueFor("pdf_exports", entitlement as Parameters<typeof limitValueFor>[1]);
    return { used: 0, cap: limit === UNLIMITED_LIMIT ? null : limit };
  }

  /**
   * A PDF whose project does not exist can never succeed under this
   * Idempotency-Key, so the unit QuotaGuard reserved for it is given back (on
   * its own connection - this request's transaction is about to roll back).
   * Any OTHER failure keeps the reservation on purpose: a retry under the same
   * key finds it already held and commits it, so a transient failure followed
   * by a successful retry costs exactly one unit; releasing here would make
   * that retry free.
   */
  private async releaseIfUnserved(workspaceId: string, idempotencyKey: string): Promise<void> {
    try {
      const client = await this.pool.connect();
      try {
        await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) =>
          releaseTierCap(tx, workspaceId, "pdf_exports", idempotencyKey),
        );
      } finally {
        client.release();
      }
    } catch (error) {
      // The reservation stands until the period rolls - the safe direction for a ceiling.
      logger.warn({ span: "reports.export.release_failed", workspace_id: workspaceId, reason: error instanceof Error ? error.name : "unknown" });
    }
  }
}
