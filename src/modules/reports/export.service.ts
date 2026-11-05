import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import type { DataSource } from "../../../contracts/analytics/index.js";
import { EXPORT_DOWNLOAD_URL_SECONDS, type ExportRequest, type ExportResponse, type ReportSection } from "../../../contracts/reports/index.js";
import { FeatureNotInPlanError, NotFoundError } from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { combineDataSources, engineDataSourcesForDates } from "../../lib/analytics/data-source.js";
import { resolveWindow } from "../../lib/analytics/window.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { isFeatureGranted, type FeatureFlagKey } from "../../lib/entitlements/classification.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
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
import { MethodologyService, TIMEFRAME_DAYS } from "./methodology.service.js";

// NEW-E-100b — POST /v1/projects/{id}/reports/export (STORY-100, NFR-AGY-05).
//
// OWNER DECISION (E-0): the synchronous per-project path. The file is built in
// the request. Rendering is pure computation over rollup rows: no network call,
// so KAD-06 holds.
//
// STORY-180 (owner decision 54): THE FILE LIVES IN OBJECT STORAGE. The row is
// recorded in the request transaction with `object_key = 'pending:<id>'`; the
// upload to `nominara-reports` happens AFTER that transaction commits (never
// inside it), and a second short transaction records the real key. The response
// carries a presigned URL (15 minutes, minted locally - no network call) for the
// key the upload will use, and a `data:` URL is gone. With storage not
// configured the presign refuses and the export answers 503 `degraded`; there
// is no inline fallback. A failed upload is logged and counted and leaves the
// row `pending:`: nothing downloads a file that is not there (the link route
// answers 404 for it, the cadence path rebuilds it).
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
  ) {}

  /** Post-commit uploads still running, by artifact id. Tests and the mail step wait on them. */
  private readonly uploads = new Map<string, Promise<void>>();

  /** Resolves when the named artifacts' uploads (started by THIS process) have finished, successfully or not. Unknown ids resolve at once. */
  async uploaded(ids: readonly string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.uploads.get(id)));
  }

  async export(projectId: string, body: ExportRequest, idempotencyKey: string | undefined): Promise<ExportResponse> {
    const started = Date.now();
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ExportService requires an active tenant context");
    const tx = store.client;
    const workspaceId = store.context.workspaceId;
    const exportId = uuidV7();
    const relativeKey = `${exportId}.${body.format}`;

    try {
      // BEFORE any work: with storage unconfigured the presign refuses with 503 and nothing has been rendered or written.
      // Minting is a local signature (ObjectStoragePort.presignGet), so a request handler may (KAD-06).
      const bound = this.objects.bind();
      const downloadUrl = await bound.presignGet("reports", relativeKey, { expiresInSeconds: EXPORT_DOWNLOAD_URL_SECONDS });

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
        [exportId, workspaceId, [projectId], window.from, window.to, body.format, `pending:${exportId}`, file.length, JSON.stringify(footer), ARTIFACT_TTL_DAYS],
      );

      this.scheduleUpload(bound, store.context, { id: exportId, relativeKey, file, contentType: body.format === "pdf" ? "application/pdf" : "text/csv" });

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
        download_url: downloadUrl,
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
   * STORY-180 AC1. Registers the upload to run AFTER this request's transaction commits (a rolled-back export uploads nothing).
   * Public so the ordering is testable; call it only from `export`.
   *
   * The work: put the object (no transaction open), then ONE short tenant transaction records the real key. If the row is gone
   * by then (the build was rolled back to a savepoint after the upload was registered) the orphan object is deleted. Never throws:
   * a failure is logged and counted and leaves the row `pending:` (see the header).
   */
  scheduleUpload(bound: BoundObjectStore, context: TenantContext, artifact: { id: string; relativeKey: string; file: Buffer; contentType: string }): void {
    afterCommit(() => {
      const work = new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => this.upload(bound, context, artifact))
        .catch((error: unknown) => {
          logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "error", error: error instanceof Error ? error.name : "unknown" });
        })
        .finally(() => this.uploads.delete(artifact.id));
      this.uploads.set(artifact.id, work);
    });
  }

  private async upload(bound: BoundObjectStore, context: TenantContext, artifact: { id: string; relativeKey: string; file: Buffer; contentType: string }): Promise<void> {
    const started = Date.now();
    let key: string;
    try {
      key = await bound.put("reports", artifact.relativeKey, artifact.file, { contentType: artifact.contentType });
    } catch (error) {
      incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "put_failed" });
      logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "put_failed", error: error instanceof Error ? error.name : "unknown", duration_ms: Date.now() - started });
      return;
    }
    try {
      const client = await this.pool.connect();
      try {
        const recorded = await withTenantContext(client, context, (tx) =>
          tx.query("UPDATE report_artifacts SET object_key = $2 WHERE id = $1 AND object_key = $3", [artifact.id, key, `pending:${artifact.id}`]),
        );
        if ((recorded.rowCount ?? 0) === 0) {
          await bound.delete("reports", artifact.relativeKey);
          incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "orphan_removed" });
          logger.warn({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "orphan_removed", duration_ms: Date.now() - started });
          return;
        }
      } finally {
        client.release();
      }
    } catch (error) {
      incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "record_failed" });
      logger.error({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "record_failed", error: error instanceof Error ? error.name : "unknown", duration_ms: Date.now() - started });
      return;
    }
    incrementCounter("nominara_reports_artifact_uploads_total", { outcome: "ok" });
    // Workspace ID and sizes only: no key, no URL, no figures.
    logger.log({ span: "reports.artifact.upload", workspace_id: context.workspaceId, outcome: "ok", bytes: artifact.file.length, duration_ms: Date.now() - started });
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
