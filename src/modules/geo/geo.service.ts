import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import {
  type GeoAnalysis,
  type GeoAnalysisWrite,
  type GeoDigest,
  type GeoInsightsQuery,
  type GeoSlug,
  geoSentimentDetailSchema,
} from "../../../contracts/analytics/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { composeDigest, summarize, validFindings, type StoredAnalysis, type TaskLookup } from "../../lib/geo/insights.js";
import { writeGeoAnalysis } from "../../lib/geo/persist-analysis.js";
import { SCORING_VERSION } from "../../lib/scoring/index.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { TasksService } from "../tasks/tasks.service.js";

// STORY-062 — the single owner of `geo_analyses`.
//
// READS ARE PERSISTED ROWS ONLY. Nothing here computes an analysis, calls an
// engine or embedding provider, or holds a transaction across an await on
// anything but Postgres. Free and unmetered: no credit guard, no meter.

const tracer = trace.getTracer("nominara.geo-insights");

const WINDOW_DAYS: Readonly<Record<GeoInsightsQuery["timeframe"], number>> = Object.freeze({ "7d": 7, "30d": 30, "90d": 90 });

interface Row {
  analysis: GeoSlug;
  score: string | null;
  evidence_cells: number;
  evidence_passages: number;
  sufficient: boolean;
  suppression_reason: string | null;
  findings: unknown[];
  lever_rank: number | null;
  window_days: number;
  window_start: string;
}

@Injectable()
export class GeoService {
  private readonly logger = new Logger("geo.insights");

  // `tasks` is TasksService's table: the digest asks it for the open task behind a lever, it never queries `tasks` itself.
  constructor(private readonly tasks: TasksService) {}

  /**
   * The ONE write path every analysis persists through. Validates against the
   * write contract (seven slugs — the fan-out analysis is unwritable; every
   * finding evidenced and terminating in a task rule or a no-action verdict;
   * an insufficient analysis publishes nothing but its reason), then upserts
   * on the composite key so a recompute REPLACES.
   */
  async persistAnalysis(projectId: string, input: unknown): Promise<GeoAnalysisWrite> {
    const a = await writeGeoAnalysis(this.tx(), projectId, input);
    // Workspace ID is not available here by design: the log carries the analysis and window only.
    this.logger.log({ event: "geo_analysis_persisted", analysis: a.analysis, window_days: a.window_days, findings: a.findings.length });
    return a;
  }

  async digest(projectId: string, query: GeoInsightsQuery): Promise<GeoDigest> {
    return this.timed("geo.digest.read", "nominara_geo_digest_read_duration_ms", async () => {
      const days = WINDOW_DAYS[query.timeframe];
      const rows = await this.latestRows(projectId, days);
      incrementCounter("nominara_geo_digest_read_total", { sufficient: String(rows.some((r) => r.sufficient)) });
      // STORY-062 AC10: a lever links the OPEN task (todo / in_progress) behind its finding's rule on that analysis, within the
      // caller's scope; none open (or only dismissed / done ones) means null, never a stale task offered as the action.
      return composeDigest(rows, days, await this.openTaskLookup(projectId, rows));
    });
  }

  async analysis(projectId: string, slug: GeoSlug, query: GeoInsightsQuery): Promise<GeoAnalysis> {
    return this.timed("geo.analysis.read", "nominara_geo_analysis_read_duration_ms", async () => {
      const days = WINDOW_DAYS[query.timeframe];
      const row = (await this.latestRows(projectId, days, slug))[0] ?? null;
      incrementCounter("nominara_geo_analysis_read_total", { analysis: slug });
      const detail = this.detailFor(slug, row);
      const sentiment = slug === "sentiment" ? geoSentimentDetailSchema.safeParse(detail) : null;
      const actions =
        sentiment?.success === true
          ? // One action per distinct reason class: a title, and no task id yet. The digest levers resolve an open task (`openTaskLookup`); reuse it here once GEO-rule tasks are produced (STORY-063 follow-up), or the two surfaces will disagree.
            // Under the alert threshold a theme is reported, not assigned (FR-GEO-A6c); a detail persisted before the threshold existed has none and keeps its actions.
            (sentiment.data.threshold?.crossed === false ? [] : sentiment.data.reason_classes).map((rc) => ({ label: rc.task_title, task_title: rc.task_title, task_id: null, href: null, engines: [] as string[] }))
          : row !== null && row.sufficient
          ? validFindings(row)
              .filter((f) => f.task_rule_code !== undefined)
              .map((f) => ({ label: f.headline, task_title: null, task_id: null, href: null, engines: f.engine === undefined ? ([] as string[]) : [f.engine] }))
          : [];
      return { summary: summarize(slug, row, days), detail, actions };
    }, { analysis: slug });
  }

  /**
   * A read's span and duration. The duration is the measure the render-budget objective (edge-cases-and-slos #29, p95 <= 400 ms)
   * is observed on in production; the integration spec only proves a fixture read fits. The line carries the metric and the
   * labels, never a row's content and never the workspace.
   */
  private async timed<T>(span: string, metric: string, read: () => Promise<T>, labels: Record<string, string> = {}): Promise<T> {
    return tracer.startActiveSpan(span, async (active) => {
      const started = performance.now();
      try {
        return await read();
      } catch (error) {
        active.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        observeValue(metric, Math.round(performance.now() - started), { workspace_id: currentTenantStore()?.context.workspaceId ?? "none", ...labels });
        active.end();
      }
    });
  }

  /** One query for the rules the ranked levers may need; the lookup the pure digest composer calls is then a map read. */
  private async openTaskLookup(projectId: string, rows: StoredAnalysis[]): Promise<TaskLookup> {
    const ranked = rows.filter((r) => r.sufficient && r.leverRank !== null);
    const rules = [...new Set(ranked.flatMap((r) => validFindings(r).flatMap((f) => (f.task_rule_code === undefined ? [] : [f.task_rule_code]))))];
    const open = await this.tasks.openGeoTasks(projectId, rules);
    const byKey = new Map(open.map((t) => [`${t.analysis}\u0000${t.rule_code}`, t]));
    return (ruleCode, analysis) => {
      const t = byKey.get(`${analysis}\u0000${ruleCode}`);
      // Relative like `analysis_href`: the client prefixes the workspace/project base.
      return t === undefined ? null : { task_id: t.task_id, label: t.title, href: `plan?task=${t.task_id}` };
    };
  }

  /**
   * Per-slug detail, READ BACK from the finding the rollup persisted it on and
   * never recomputed, so the detail and the stored row cannot disagree. The
   * analyses without a detail yet stay null until their own story. A suppressed
   * analysis has no detail: the suppression reason is the whole answer.
   */
  private detailFor(slug: GeoSlug, row: StoredAnalysis | null): GeoAnalysis["detail"] {
    if (slug === "sentiment") {
      if (row === null || !row.sufficient) return null;
      return validFindings(row).find((f) => f.sentiment !== undefined)?.sentiment ?? null;
    }
    if (slug === "divergence") {
      if (row === null || !row.sufficient) return null;
      return validFindings(row).find((f) => f.divergence !== undefined)?.divergence ?? null;
    }
    if (slug === "topics") {
      if (row === null || !row.sufficient) return null;
      return validFindings(row).find((f) => f.topics !== undefined)?.topics ?? null;
    }
    if (slug === "entity") {
      if (row === null || !row.sufficient) return null;
      return validFindings(row).find((f) => f.entity !== undefined)?.entity ?? null;
    }
    if (slug !== "structure" || row === null || !row.sufficient) return null;
    // Read back, never re-aggregated: a row persisted before the detail rode on the finding has none until the next rollup.
    return validFindings(row).find((f) => f.structure !== undefined)?.structure ?? null;
  }

  /** The newest row per analysis for the window, current scoring version only. */
  private async latestRows(projectId: string, windowDays: number, slug?: GeoSlug): Promise<StoredAnalysis[]> {
    const tx = this.tx();
    const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
    if (project.rowCount === 0) throw new NotFoundError({ message: "no such project" });
    const res = await tx.query<Row>(
      `SELECT DISTINCT ON (analysis)
              analysis, score::text AS score, evidence_cells, evidence_passages, sufficient,
              suppression_reason, findings, lever_rank, window_days, window_start::text AS window_start
         FROM geo_analyses
        WHERE project_id = $1 AND window_days = $2 AND scoring_version = $3
          AND ($4::text IS NULL OR analysis = $4)
        ORDER BY analysis, window_start DESC, computed_at DESC`,
      [projectId, windowDays, SCORING_VERSION, slug ?? null],
    );
    return res.rows.map((r) => ({
      analysis: r.analysis,
      score: r.score === null ? null : Number(r.score),
      evidenceCells: r.evidence_cells,
      evidencePassages: r.evidence_passages,
      sufficient: r.sufficient,
      suppressionReason: r.suppression_reason,
      findings: r.findings,
      leverRank: r.lever_rank,
      windowDays: r.window_days,
      windowStart: r.window_start,
    }));
  }

  private tx(): ClientBase {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("GeoService requires an active tenant context");
    return store.client;
  }
}
