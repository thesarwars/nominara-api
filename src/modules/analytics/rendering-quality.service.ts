import { Injectable, Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { RenderingAttribute, RenderingQualityQuery, RenderingQualityResponse } from "../../../contracts/analytics/index.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { recordDemoDataServed } from "../../lib/analytics/data-source.js";
import {
  buildRenderingQuality,
  RENDERING_ATTRIBUTES,
  RENDERING_CAUSE_RULES,
  type EngineCounts,
  type OpenFinding,
} from "../../lib/analytics/rendering-quality.js";
import { measurementStatusSql } from "../../lib/rollup/aggregate-day.js";
import { LIVE_FINDING_STATUSES } from "../../lib/aux/lifecycle.js";
import { ATTRIBUTE_CAPABLE_ENGINES } from "../../lib/parser/rendering.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { ScorecardsService } from "./scorecards.service.js";

// NEW-C-11 — `GET /v1/projects/{id}/rendering-quality` (D4; scoring-models §8).
//
// THE SCORE IS NOT COMPUTED HERE. Every engine's score and the blend are the
// scorecards' own `rendering_quality` (the single §8 formula over the stored
// per-mention `render_score`), so this endpoint and the Overview card cannot
// disagree. This adds what the score cannot say: attribute coverage, which
// engines are excluded, and the AUX finding behind a missing attribute.

const logger = new Logger("RenderingQualityService");

const CAUSE_RULES = [...new Set(Object.values(RENDERING_CAUSE_RULES).flat())];

@Injectable()
export class RenderingQualityService {
  constructor(private readonly scorecards: ScorecardsService) {}

  async renderingQuality(projectId: string, query: RenderingQualityQuery): Promise<RenderingQualityResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("RenderingQualityService requires an active tenant context");
    const tx = store.client;

    // Throws the 404 for an unknown or other-tenant project (RLS), and applies
    // the project-scope check, exactly as the scorecards do.
    const cards = await this.scorecards.scorecards(projectId, { timeframe: query.timeframe });
    const counts = await this.attributeCounts(tx, projectId, cards.window);
    const findings = await this.openCauseFindings(tx, projectId);

    const built = buildRenderingQuality({
      engines: cards.engines.map((engine) => ({
        engineKey: engine.engine_key,
        displayName: engine.display_name,
        score: engine.metrics.rendering_quality,
        dataSource: engine.data_source ?? null,
      })),
      counts,
      findings,
      blendedScore: cards.blended.metrics.rendering_quality,
      blendedDataSource: cards.blended.data_source ?? null,
    });

    recordDemoDataServed("rendering_quality", store.context.workspaceId, built.engines.map((e) => e.data_source));
    const causes = built.blended.attributes.filter((a) => a.cause !== null).length;
    incrementCounter("nominara_analytics_rendering_quality_reads_total", {
      timeframe: query.timeframe,
      scored: built.blended.score === null ? "no" : "yes",
    });
    // Workspace ID only; no engine text, no finding titles.
    logger.log({
      event: "rendering_quality_read",
      workspaceId: store.context.workspaceId,
      projectId,
      timeframe: query.timeframe,
      engines: built.engines.length,
      richEngines: built.rich_rendering_engines.length,
      linkedCauses: causes,
    });

    return {
      project_id: projectId,
      timeframe: query.timeframe,
      window: cards.window,
      ...built,
    };
  }

  /**
   * Per attribute-capable engine: the BRAND's mentions on measured captures in
   * the window, and how many carry each attribute. The window and the
   * measurement rule are the aggregation's own, so the coverage describes the
   * same mentions the score was computed from. No workspace predicate: RLS.
   */
  private async attributeCounts(
    tx: ClientBase,
    projectId: string,
    window: { from: string; to: string; timezone: string },
  ): Promise<EngineCounts[]> {
    // Attribute names are bound parameters ($5..), never concatenated.
    const filters = RENDERING_ATTRIBUTES.map(
      (attribute, index) => `count(*) FILTER (WHERE $${index + 5}::text = ANY(m.render_attrs))::text AS ${attribute}`,
    ).join(",\n              ");
    const result = await tx.query<Record<string, string>>(
      `SELECT m.engine_key,
              count(*)::text AS mentions,
              ${filters}
         FROM mention_facts m
         JOIN answer_captures c ON c.id = m.result_id
        WHERE c.project_id = $1
          AND m.entity_type = 'brand'
          AND ${measurementStatusSql()}
          AND (c.captured_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND m.engine_key = ANY($${RENDERING_ATTRIBUTES.length + 5}::text[])
        GROUP BY m.engine_key`,
      [projectId, window.from, window.to, window.timezone, ...RENDERING_ATTRIBUTES, [...ATTRIBUTE_CAPABLE_ENGINES]],
    );
    return result.rows.map((row) => ({
      engineKey: row["engine_key"]!,
      mentions: Number(row["mentions"]),
      withAttr: Object.fromEntries(
        RENDERING_ATTRIBUTES.map((attribute): [RenderingAttribute, number] => [attribute, Number(row[attribute] ?? 0)]),
      ),
    }));
  }

  /** LIVE findings (open, acknowledged, in progress, regressed) of the mapped rules, newest first (the pure builder picks by severity). */
  private async openCauseFindings(tx: ClientBase, projectId: string): Promise<OpenFinding[]> {
    const result = await tx.query<{ id: string; rule_code: string; severity: OpenFinding["severity"]; title: string }>(
      `SELECT f.id::text, f.rule_code, f.severity, f.title
         FROM aux_findings f
        WHERE f.project_id = $1
          AND f.rule_code = ANY($2::text[])
          AND f.status = ANY($3::text[])
        ORDER BY f.last_detected_at DESC, f.id ASC`,
      [projectId, CAUSE_RULES, [...LIVE_FINDING_STATUSES]],
    );
    return result.rows.map((row) => ({ id: row.id, ruleCode: row.rule_code, severity: row.severity, title: row.title }));
  }
}
