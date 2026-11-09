import { Injectable, Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type {
  ProjectEngineState,
  UpdateProjectEnginesRequest,
  UpdateProjectEnginesResponse,
} from "../../../contracts/projects/index.js";
import { FeatureNotInPlanError, NotFoundError, UnsupportedEngineError } from "../../api/errors/domain-errors.js";
import { isFeatureGranted } from "../../lib/entitlements/classification.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import type { EntitlementValue } from "../../db/seed/plan-entitlements.js";

// `PUT /projects/{id}/engines` (project:update): enable or disable an engine for
// one project, set its weight in the blended Visibility Score, and set its
// sample count.
//
// `project_engines` holds OVERRIDES ONLY (migration 0027). The entitled set is
// DERIVED by `project_entitled_engines` from the catalog and the workspace plan,
// and a row can narrow or reweight an entitled engine, never add one. So the
// entitlement test here is "is the engine in the view for this project": it is
// the same predicate the scheduler and the scorecards read, and it cannot be
// forgotten at a call site. An engine that is unknown, disabled in the catalog
// or above the plan is refused with ONE message, so the entitlement set cannot
// be probed by telling the cases apart.
//
// THIS WRITES CONFIGURATION AND NOTHING ELSE. The scoring functions read
// `weight` as they always did (`lib/scoring/aggregate.ts`); no score is
// recomputed here. No network or storage I/O (ADR-0003), so the whole thing
// runs in the ambient transaction. The request is applied as one unit: a refusal
// on any entry writes none.
const DRIFT_SAMPLING_KEY = "drift_sampling.enabled";
const tracer = trace.getTracer("nominara.projects");

@Injectable()
export class ProjectEnginesService {
  private readonly logger = new Logger(ProjectEnginesService.name);

  constructor(private readonly entitlements: EntitlementResolver) {}

  async update(workspaceId: string, projectId: string, input: UpdateProjectEnginesRequest): Promise<UpdateProjectEnginesResponse> {
    return tracer.startActiveSpan("projects.update_engines", async (span) => {
      try {
        const result = await this.apply(workspaceId, projectId, input);
        incrementCounter("nominara_project_engines_updated_total", {});
        this.logger.log({
          event: "project.engines_updated",
          workspace_id: workspaceId,
          project_id: projectId,
          engines_changed: input.engines.length,
        });
        return result;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        incrementCounter("nominara_project_engines_update_refused_total", { reason: reasonOf(error) });
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private async apply(workspaceId: string, projectId: string, input: UpdateProjectEnginesRequest): Promise<UpdateProjectEnginesResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ProjectEnginesService requires an active tenant context");
    const tx = store.client;

    const project = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL", [projectId, workspaceId]);
    if (project.rowCount === 0) throw new NotFoundError({ message: "no such project" });

    const entitled = await tx.query<{ engine_key: string }>(
      "SELECT engine_key FROM project_entitled_engines WHERE project_id = $1 AND workspace_id = $2 AND engine_key = ANY($3::text[])",
      [projectId, workspaceId, input.engines.map((entry) => entry.engine_key)],
    );
    if (entitled.rows.length !== input.engines.length) {
      // `details.engine_key` is the contract's field; it echoes a key the caller sent.
      const available = new Set(entitled.rows.map((row) => row.engine_key));
      const refused = input.engines.find((entry) => !available.has(entry.engine_key))!.engine_key;
      throw new UnsupportedEngineError({
        message: "an engine in this request is not available to this project",
        details: { engine_key: refused },
      });
    }

    // Stepping DOWN to one sample is always allowed, so a workspace that lost
    // the feature on a downgrade can undo what it set while it had it.
    if (input.engines.some((entry) => entry.sample_count !== undefined && entry.sample_count > 1)) {
      const resolved = await this.entitlements.resolveForWorkspace(workspaceId);
      if (!isFeatureGranted((resolved.entitlements[DRIFT_SAMPLING_KEY]?.value ?? null) as EntitlementValue)) {
        const lowest = await tx.query<{ key: string }>(
          `SELECT key FROM plans WHERE (entitlements -> $1 -> 'value') NOT IN ('false'::jsonb, 'null'::jsonb) ORDER BY sort_order ASC LIMIT 1`,
          [DRIFT_SAMPLING_KEY],
        );
        throw new FeatureNotInPlanError({
          message: "multi-sample drift detection is not included in this plan",
          details: { key: DRIFT_SAMPLING_KEY, min_plan: lowest.rows[0]?.key ?? "unknown" },
        });
      }
    }

    // A field the request omits keeps its stored value; a new row starts from
    // the table defaults. The workspace id comes from the context, never the body.
    for (const entry of input.engines) {
      await tx.query(
        `INSERT INTO project_engines (workspace_id, project_id, engine_key, enabled, weight, sample_count)
         VALUES ($1, $2, $3, COALESCE($4::boolean, true), COALESCE($5::real, 1.0), COALESCE($6::smallint, 1))
         ON CONFLICT (project_id, engine_key) DO UPDATE
            SET enabled = COALESCE($4::boolean, project_engines.enabled),
                weight = COALESCE($5::real, project_engines.weight),
                sample_count = COALESCE($6::smallint, project_engines.sample_count)
          WHERE project_engines.workspace_id = $1`,
        [workspaceId, projectId, entry.engine_key, entry.enabled ?? null, entry.weight ?? null, entry.sample_count ?? null],
      );
    }

    const effective = await tx.query<{ engine_key: string; display_name: string; enabled: boolean; weight: string; sample_count: number }>(
      `SELECT engine_key, display_name, enabled, weight::numeric::text AS weight, sample_count
         FROM project_entitled_engines WHERE project_id = $1 AND workspace_id = $2 ORDER BY engine_key`,
      [projectId, workspaceId],
    );
    const engines: ProjectEngineState[] = effective.rows.map((row) => ({
      engine_key: row.engine_key,
      display_name: row.display_name,
      enabled: row.enabled,
      weight: Number(row.weight),
      sample_count: row.sample_count,
    }));
    return { project_id: projectId, engines };
  }
}

function reasonOf(error: unknown): string {
  if (error instanceof UnsupportedEngineError) return "unsupported_engine";
  if (error instanceof FeatureNotInPlanError) return "feature_not_in_plan";
  if (error instanceof NotFoundError) return "not_found";
  return "error";
}
