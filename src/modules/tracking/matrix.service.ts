import { Injectable } from "@nestjs/common";
import type { MatrixCell, MatrixQuery, MatrixResponse, MatrixRow } from "../../../contracts/tracking/index.js";
import { NotFoundError } from "../../api/errors/domain-errors.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";

// STORY-034 AC8 — the prompt × engine grid.
//
// "A cell that could not be captured carries a status, an error code, and the
// last success time — NEVER AN EMPTY OBJECT." The story's note gives the
// reason: "Distinguishing 'could not capture' from 'not mentioned' is the
// same honesty rule as the aggregation layer, surfaced in the read model. An
// empty cell that means either would make the matrix unreadable."
//
// SO EVERY CELL IS EMITTED, including the ones with no row behind them. The
// grid is `prompts × engines`, built from the project's own configuration,
// and captures are joined ONTO it — not the other way round. A query that
// listed captures and grouped them would silently omit every cell that was
// never attempted, which is precisely the case §6 is protecting.

const TIMEFRAME_DAYS: Readonly<Record<MatrixQuery["timeframe"], number>> = Object.freeze({
  "7d": 7,
  "30d": 30,
  "90d": 90,
});

interface CellRow {
  prompt_id: string;
  text: string;
  intent_archetype: string;
  funnel_stage: string;
  is_priority: boolean;
  engine_key: string;
  result_id: string | null;
  status: string | null;
  error_code: string | null;
  captured_at: Date | null;
  cache_layer: string | null;
  last_success_at: Date | null;
}

@Injectable()
export class MatrixService {
  async matrix(projectId: string, query: MatrixQuery): Promise<MatrixResponse> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("MatrixService requires an active tenant context");

    const requested = query.engines?.split(",").map((key) => key.trim()).filter((key) => key.length > 0) ?? null;

    const result = await store.client.query<CellRow>(
      // The grid is a CROSS JOIN of the project's active prompts with its
      // enabled engines. Captures arrive through a LATERAL that takes the most
      // recent one inside the window, which is what makes a cell with no
      // capture emit as `pending` rather than vanish.
      //
      // No `workspace_id` predicate — RLS scopes the tenant (`NFR-SEC-01`).
      // `project_id` is here because the path names a project and RLS does
      // not: without it a sibling project's prompts appear in this grid.
      `SELECT p.id AS prompt_id, p.text, p.intent_archetype, p.funnel_stage, p.is_priority,
              e.engine_key,
              latest.id          AS result_id,
              latest.status      AS status,
              latest.error_code  AS error_code,
              latest.captured_at AS captured_at,
              latest.cache_layer AS cache_layer,
              success.captured_at AS last_success_at
         FROM tracked_prompts p
         CROSS JOIN (
           SELECT engine_key FROM project_engines
            WHERE project_id = $1 AND enabled = true
              AND ($3::text[] IS NULL OR engine_key = ANY($3::text[]))
         ) e
         LEFT JOIN LATERAL (
           SELECT c.id, c.status, c.error_code, c.captured_at, c.cache_layer
             FROM answer_captures c
            WHERE c.project_id = p.project_id
              AND c.prompt_id = p.id
              AND c.engine_key = e.engine_key
              AND c.captured_at >= now() - make_interval(days => $2::int)
            ORDER BY c.captured_at DESC
            LIMIT 1
         ) latest ON true
         -- NOT WINDOWED. The last success is the thing that makes a failure
         -- readable, and a failure whose last success predates the window is
         -- exactly the case worth surfacing — clamping it to the window would
         -- report null for the prompt that has been broken longest.
         LEFT JOIN LATERAL (
           SELECT c.captured_at
             FROM answer_captures c
            WHERE c.project_id = p.project_id
              AND c.prompt_id = p.id
              AND c.engine_key = e.engine_key
              AND c.status IN ('captured', 'parsed', 'skipped')
            ORDER BY c.captured_at DESC
            LIMIT 1
         ) success ON true
        WHERE p.project_id = $1
          AND p.status <> 'archived'
          AND p.deleted_at IS NULL
        ORDER BY p.is_priority DESC, p.created_at ASC, e.engine_key ASC`,
      [projectId, TIMEFRAME_DAYS[query.timeframe], requested],
    );

    if (result.rows.length === 0) await this.assertProjectExists(projectId);

    return {
      project_id: projectId,
      timeframe: query.timeframe,
      engine_keys: [...new Set(result.rows.map((row) => row.engine_key))],
      prompts: this.group(result.rows),
    };
  }

  /**
   * An empty grid is a real answer — a project with no prompts, or none on the
   * requested engines — so it is only a 404 when the PROJECT is missing.
   *
   * Checked lazily, because the common path returns rows and does not need a
   * second query to prove the project exists.
   */
  private async assertProjectExists(projectId: string): Promise<void> {
    const store = currentTenantStore();
    const rows = await store!.client.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
    if (rows.rowCount === 0) throw new NotFoundError({ message: "no such project" });
  }

  private group(rows: readonly CellRow[]): MatrixRow[] {
    const byPrompt = new Map<string, MatrixRow>();
    for (const row of rows) {
      let entry = byPrompt.get(row.prompt_id);
      if (entry === undefined) {
        entry = {
          prompt_id: row.prompt_id,
          text: row.text,
          intent_archetype: row.intent_archetype,
          funnel_stage: row.funnel_stage,
          is_priority: row.is_priority,
          cells: [],
        };
        byPrompt.set(row.prompt_id, entry);
      }
      entry.cells.push(this.cell(row));
    }
    return [...byPrompt.values()];
  }

  private cell(row: CellRow): MatrixCell {
    return {
      engine_key: row.engine_key,
      result_id: row.result_id,
      // `pending` when the LATERAL found nothing: planned, never attempted.
      // The three absences stay distinguishable all the way to the wire.
      status: (row.status ?? "pending") as MatrixCell["status"],
      error_code: row.error_code,
      captured_at: row.captured_at?.toISOString() ?? null,
      last_success_at: row.last_success_at?.toISOString() ?? null,
      cache_layer: row.cache_layer as MatrixCell["cache_layer"],
    };
  }
}
