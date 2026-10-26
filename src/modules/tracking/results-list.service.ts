import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import type { ResultListItem, ResultsListQuery } from "../../../contracts/tracking/index.js";
import { NotFoundError, RetentionExceededError } from "../../api/errors/domain-errors.js";
import { decodeTimestampIdCursor, MICROS_FORMAT } from "../../api/pagination/timestamp-id-cursor.js";
import { pageFrom, type Page } from "../../api/pagination/page.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { assertProjectInScope } from "../../tenancy/project-scope.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { rawRetentionCutoff } from "./raw-retention.js";

// STORY-034 AC7 (the list half) and AC10 - `GET /v1/projects/{id}/results`, a cursor over `answer_captures`.
//
// NEWEST FIRST ON (captured_at, id), and the cursor carries both at full microsecond precision: two captures that share a
// millisecond (a whole run's cells commit together) would otherwise be skipped or repeated at a page boundary, which is the exact
// failure NFR-API-03's cursor exists to prevent. `ix_results_ws_proj_engine` serves the project + time scan; RLS is the tenant guard.
//
// THE WINDOW IS THE PLAN'S RETENTION. A `from` before the boundary, a `to` at or before it, or a `run_id` that ended before it is `507 retention_exceeded` (AC10) - not an empty page, which
// would read as "the engines said nothing". With no `from`, the list opens AT the boundary, so a row the sweep has not reached yet
// is not listed as if it were readable.

const LIST = "tracking.results";

interface ResultRow {
  id: string;
  run_id: string;
  prompt_id: string;
  engine_key: string;
  sample_index: number;
  captured_at: Date;
  captured_key: string;
  status: ResultListItem["status"];
  error_code: string | null;
  cache_layer: ResultListItem["cache_layer"];
  brand_present: boolean | null;
  citation_count: number;
  scoring_version: string;
  response_excerpt: string | null;
}

@Injectable()
export class ResultsListService {
  async list(projectId: string, query: ResultsListQuery): Promise<Page<ResultListItem>> {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("ResultsListService requires an active tenant context");
    const client = store.client;

    // RLS makes another workspace's project absent; a soft-deleted one is absent too. The scope check is the service's own as well
    // as the guard's: a scoped member is refused with the scope 403, never shown an empty list that looks like "no captures".
    const project = await client.query("SELECT 1 FROM projects WHERE id = $1 AND deleted_at IS NULL", [projectId]);
    if (project.rows.length === 0) throw new NotFoundError({ message: "no such project" });
    await assertProjectInScope(client, projectId);

    const cutoff = await rawRetentionCutoff(client, store.context.workspaceId);
    const requestedFrom = query.from === undefined ? null : new Date(query.from);
    if (cutoff !== null) {
      // A window that lies wholly or partly before the boundary is the retention failure, never an empty page (AC10): a `from` before it,
      // a `to` at or before it (`to` is exclusive, so nothing at or after the boundary can match), or a `run_id` whose run ended before it.
      const pastRetention =
        (requestedFrom !== null && requestedFrom < cutoff) ||
        (query.to !== undefined && new Date(query.to) <= cutoff) ||
        (query.run_id !== undefined && (await runEndedBefore(client, projectId, query.run_id, cutoff)));
      if (pastRetention) {
        incrementCounter("nominara_tracking_retention_exceeded_total", { surface: "results_list" });
        throw new RetentionExceededError({ message: "the requested window lies before the workspace's raw-capture retention" });
      }
    }
    const from = requestedFrom ?? cutoff;

    const after = query.cursor === undefined ? undefined : decodeTimestampIdCursor(query.cursor, LIST);
    const rows = await client.query<ResultRow>(
      `SELECT c.id, c.run_id, c.prompt_id, c.engine_key, c.sample_index, c.captured_at,
              to_char(c.captured_at AT TIME ZONE 'UTC', ${MICROS_FORMAT}) AS captured_key,
              c.status, c.error_code, c.cache_layer, c.brand_present, c.citation_count, c.scoring_version, c.response_excerpt
         FROM answer_captures c
        WHERE c.project_id = $1
          AND ($2::timestamptz IS NULL OR c.captured_at >= $2::timestamptz)
          AND ($3::timestamptz IS NULL OR c.captured_at <  $3::timestamptz)
          AND ($4::text IS NULL OR c.engine_key = $4)
          AND ($5::uuid IS NULL OR c.prompt_id = $5)
          AND ($6::uuid IS NULL OR c.run_id = $6)
          AND ($7::text IS NULL OR c.status = $7)
          AND ($8::timestamptz IS NULL OR (c.captured_at, c.id) < ($8::timestamptz, $9::uuid))
        ORDER BY c.captured_at DESC, c.id DESC
        LIMIT $10`,
      [
        projectId,
        from,
        query.to ?? null,
        query.engine_key ?? null,
        query.prompt_id ?? null,
        query.run_id ?? null,
        query.status ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        query.limit + 1,
      ],
    );
    incrementCounter("nominara_tracking_results_list_total", {});
    return pageFrom(rows.rows, query.limit, LIST, toItem, (row) => [row.captured_key, row.id]);
  }
}

/**
 * True when the run has captures (or, with none, a run row) and ALL of it is older than the boundary. A run with nothing yet is "no
 * captures", not "expired". Under RLS, scoped to the project the list is for.
 */
async function runEndedBefore(client: ClientBase, projectId: string, runId: string, cutoff: Date): Promise<boolean> {
  const result = await client.query<{ ended_at: Date | null }>(
    `SELECT COALESCE(
              (SELECT max(c.captured_at) FROM answer_captures c WHERE c.run_id = $1 AND c.project_id = $2),
              (SELECT COALESCE(r.finished_at, r.created_at) FROM capture_runs r WHERE r.id = $1 AND r.project_id = $2)
            ) AS ended_at`,
    [runId, projectId],
  );
  const endedAt = result.rows[0]?.ended_at ?? null;
  return endedAt !== null && endedAt < cutoff;
}

function toItem(row: ResultRow): ResultListItem {
  return {
    result_id: row.id,
    run_id: row.run_id,
    prompt_id: row.prompt_id,
    engine_key: row.engine_key,
    sample_index: row.sample_index,
    captured_at: row.captured_at.toISOString(),
    status: row.status,
    error_code: row.error_code,
    cache_layer: row.cache_layer,
    brand_present: row.brand_present,
    citation_count: row.citation_count,
    scoring_version: row.scoring_version,
    response_excerpt: row.response_excerpt,
  };
}
