import type { Logger } from "@nestjs/common";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ClientBase } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { appendComplianceAudit } from "../compliance/compliance-audit.js";
import { incrementCounter, observeValue } from "../telemetry/metrics.js";
import { embedBatchKey, splitIdsIntoJobs, type EmbedTable } from "./embed-batch.js";
import type { EnqueueEmbedBatch } from "./prompt-embedding-request.js";
import { promoteProject } from "./reembed-promote.js";

// STORY-186 - the operator-run re-embed (owner decision 104). It starts ONLY from `pnpm db:reembed`, behind EMBED_REEMBED_ENABLED, never from a
// deploy and never on a schedule. This function takes no provider: it finds work, ENQUEUES `embed.batch` jobs and cuts over the projects whose
// staged set is complete. Every spend happens later, in a worker running those jobs, metered on `embed_tokens` like any embed job.
//
//   1. BACKFILL (AC3)  active prompts with no vector -> direct jobs (they have no old vector to protect).
//   2. STAGE   (AC1)   prompts and semantic nodes holding a vector under another model -> stage jobs: the new vector goes to `embedding_next`,
//                      the served pair is untouched (old vectors are served until the project is promoted).
//   3. CUT OVER        every project with staged vectors is offered to `promoteProject`, which switches it in one step only if complete.
//
// RESUMABLE AND IDEMPOTENT (AC4). The state is the rows themselves: a row already staged (or embedded) under the target model is not found
// again, so a rerun enqueues only the remainder; a job for the same ids has the same key and the queue deduplicates it; a promote that finds
// nothing staged does nothing. The usual cycle is: run, wait for the workers, run again (cut over what completed), repeat until it reports
// nothing pending.
//
// TENANCY. The discovery reads run on the OWNER connection (the reaper pattern) and return ids only, grouped by workspace: a job never mixes
// two workspaces' ids. Every WRITE (the promote) runs in that workspace's own tenant context. NO I/O INSIDE A TRANSACTION: the discovery runs
// outside any transaction, the enqueues are made outside any, and the promote transaction holds only SQL.

const tracer = trace.getTracer("nominara.embed-reembed");

/** The label for a row with no vector at all (an active prompt never embedded). Absent is not a model. */
export const NO_MODEL_LABEL = "(none)";

/** Thrown by the operator command when EMBED_REEMBED_ENABLED is not exactly "true" (owner decision 104(b): off by default). */
export class ReembedDisabledError extends Error {
  constructor() {
    super('the re-embed is disabled: set EMBED_REEMBED_ENABLED=true to run it (it is an operator command and spends embedding tokens in the workers it enqueues for)');
    this.name = "ReembedDisabledError";
  }
}

export function assertReembedEnabled(env: { readonly EMBED_REEMBED_ENABLED?: string | undefined }): void {
  if (env.EMBED_REEMBED_ENABLED !== "true") throw new ReembedDisabledError();
}

/** Rows read per discovery page. A page is ids only; the jobs it fills are cut at 96 (the provider batch size). */
const DISCOVERY_PAGE_SIZE = 5_000;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface ReembedOptions {
  /** The OWNER connection: it must see across workspaces to find work. Used for ids and counts only. */
  readonly client: ClientBase;
  /** The model the configured embedding provider announces: the target of the switch. */
  readonly model: string;
  readonly enqueue: EnqueueEmbedBatch;
  readonly logger: Pick<Logger, "log" | "warn" | "error">;
}

export interface ReembedCutover {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly prompts: number;
  readonly nodes: number;
}

export interface ReembedBlocked {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly reason: "incomplete" | "open_session";
}

export interface ReembedPending {
  readonly table: "tracked_prompts" | "semantic_nodes";
  /** The model the rows are served under now, or NO_MODEL_LABEL. */
  readonly model: string;
  readonly rows: number;
}

export interface ReembedSummary {
  readonly model: string;
  readonly jobs: { readonly backfill: number; readonly stagePrompts: number; readonly stageNodes: number };
  readonly enqueueFailed: number;
  readonly cutovers: readonly ReembedCutover[];
  readonly blocked: readonly ReembedBlocked[];
  readonly promoteFailed: number;
  /** AC5 - rows still not under the target model, per table and served model. Empty when nothing is pending. */
  readonly pending: readonly ReembedPending[];
}

interface Discovery {
  readonly name: "backfill" | "stagePrompts" | "stageNodes";
  readonly table: EmbedTable;
  readonly stage: boolean;
  readonly sql: string;
}

// $1 target model, $2/$3 keyset cursor (workspace, id), $4 page size. Deleted prompts are never enqueued. Only ACTIVE prompts are backfilled (AC3);
// every live prompt is staged, because a paused or archived one comes back later and must not return under the old model.
const DISCOVERIES: readonly Discovery[] = [
  {
    name: "backfill",
    table: "tracked_prompts",
    stage: false,
    sql: `SELECT workspace_id, id FROM tracked_prompts
           WHERE embedding IS NULL AND status = 'active' AND deleted_at IS NULL AND $1::text IS NOT NULL
             AND (workspace_id, id) > ($2::uuid, $3::uuid)
           ORDER BY workspace_id, id LIMIT $4`,
  },
  {
    name: "stagePrompts",
    table: "tracked_prompts",
    stage: true,
    sql: `SELECT workspace_id, id FROM tracked_prompts
           WHERE embedding IS NOT NULL AND deleted_at IS NULL AND embedding_model IS DISTINCT FROM $1
             AND (embedding_next IS NULL OR embedding_next_model IS DISTINCT FROM $1)
             AND (workspace_id, id) > ($2::uuid, $3::uuid)
           ORDER BY workspace_id, id LIMIT $4`,
  },
  {
    name: "stageNodes",
    table: "semantic_nodes",
    stage: true,
    sql: `SELECT workspace_id, id FROM semantic_nodes
           WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $1
             AND (embedding_next IS NULL OR embedding_next_model IS DISTINCT FROM $1)
             AND (workspace_id, id) > ($2::uuid, $3::uuid)
           ORDER BY workspace_id, id LIMIT $4`,
  },
];

export function runReembed(options: ReembedOptions): Promise<ReembedSummary> {
  return tracer.startActiveSpan("embed.reembed.run", async (span) => {
    try {
      const summary = await reembedOnce(options);
      span.setAttributes({
        "nominara.embed.model": summary.model,
        "nominara.embed.jobs_enqueued": summary.jobs.backfill + summary.jobs.stagePrompts + summary.jobs.stageNodes,
        "nominara.embed.enqueue_failed": summary.enqueueFailed,
        "nominara.embed.cutovers": summary.cutovers.length,
        "nominara.embed.cutovers_blocked": summary.blocked.length,
        "nominara.embed.rows_pending": summary.pending.reduce((sum, p) => sum + p.rows, 0),
      });
      return summary;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  });
}

async function reembedOnce(options: ReembedOptions): Promise<ReembedSummary> {
  const { client, model, enqueue, logger } = options;
  const jobs = { backfill: 0, stagePrompts: 0, stageNodes: 0 };
  let enqueueFailed = 0;

  for (const discovery of DISCOVERIES) {
    // One workspace's ids accumulate until 96 or until the workspace changes (rows arrive ordered by workspace), then go out as one job.
    let bufferWorkspace: string | null = null;
    let buffer: string[] = [];
    const flush = async (): Promise<void> => {
      if (bufferWorkspace === null || buffer.length === 0) return;
      const workspaceId = bufferWorkspace;
      for (const ids of splitIdsIntoJobs(buffer)) {
        const key = embedBatchKey(discovery.table, ids, discovery.stage ? model : undefined);
        const payload: Record<string, unknown> = discovery.stage ? { table: discovery.table, ids, stage: true, targetModel: model } : { table: discovery.table, ids };
        try {
          await enqueue("embed.batch", workspaceId, payload, key);
          jobs[discovery.name] += 1;
          incrementCounter("nominara_embed_reembed_jobs_enqueued_total", { table: discovery.table, kind: discovery.name });
        } catch (error) {
          // One failed enqueue must not strand the rest: the rows are still unstaged, so the next run finds them again.
          enqueueFailed += 1;
          incrementCounter("nominara_embed_reembed_enqueue_failed_total", { table: discovery.table, kind: discovery.name });
          logger.error({ event: "embed.reembed.enqueue_failed", workspace_id: workspaceId, table: discovery.table, count: ids.length, error: error instanceof Error ? error.name : "unknown" });
        }
      }
      buffer = [];
    };

    let cursorWorkspace = NIL_UUID;
    let cursorId = NIL_UUID;
    for (;;) {
      const page = await client.query<{ workspace_id: string; id: string }>(discovery.sql, [model, cursorWorkspace, cursorId, DISCOVERY_PAGE_SIZE]);
      for (const row of page.rows) {
        if (bufferWorkspace !== row.workspace_id) {
          await flush();
          bufferWorkspace = row.workspace_id;
        }
        buffer.push(row.id);
        if (buffer.length >= 96) await flush();
      }
      const last = page.rows.at(-1);
      if (last === undefined || page.rows.length < DISCOVERY_PAGE_SIZE) break;
      cursorWorkspace = last.workspace_id;
      cursorId = last.id;
    }
    await flush();
  }

  // CUT OVER every project that has something staged under this model. `promoteProject` decides whether it is complete.
  const staged = await client.query<{ workspace_id: string; project_id: string }>(
    `SELECT workspace_id, project_id FROM tracked_prompts WHERE embedding_next_model = $1
      UNION
     SELECT workspace_id, project_id FROM semantic_nodes WHERE embedding_next_model = $1
      ORDER BY workspace_id, project_id`,
    [model],
  );
  const cutovers: ReembedCutover[] = [];
  const blocked: ReembedBlocked[] = [];
  let promoteFailed = 0;
  for (const row of staged.rows) {
    try {
      // THE AUDIT ROW COMMITS WITH THE CUTOVER (AC5): if it cannot be written the whole promote rolls back and the project stays on the old model.
      const outcome = await withTenantContext(client, { workspaceId: row.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        const promoted = await promoteProject(tx, row.project_id, model);
        if (promoted.status === "promoted") {
          await appendComplianceAudit(tx, {
            workspaceId: row.workspace_id,
            actorType: "system",
            actorId: null,
            action: "embedding.cutover",
            resourceType: "project",
            resourceId: row.project_id,
            afterState: { model, prompts: promoted.prompts, nodes: promoted.nodes },
          });
        }
        return promoted;
      });
      if (outcome.status === "promoted") {
        cutovers.push({ workspaceId: row.workspace_id, projectId: row.project_id, prompts: outcome.prompts, nodes: outcome.nodes });
        incrementCounter("nominara_embed_reembed_cutover_total");
        logger.log({ event: "embed.reembed.cutover", workspace_id: row.workspace_id, project_id: row.project_id, model, prompts: outcome.prompts, nodes: outcome.nodes });
      } else if (outcome.status === "blocked") {
        blocked.push({ workspaceId: row.workspace_id, projectId: row.project_id, reason: outcome.reason });
        incrementCounter("nominara_embed_reembed_cutover_blocked_total", { reason: outcome.reason });
      }
    } catch (error) {
      // One project's failure rolled back that project only; the others still cut over and a rerun retries it.
      promoteFailed += 1;
      logger.error({ event: "embed.reembed.cutover_failed", workspace_id: row.workspace_id, project_id: row.project_id, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const pending = await readPending(client, model);
  return { model, jobs, enqueueFailed, cutovers, blocked, promoteFailed, pending };
}

/**
 * AC5 - the progress reading: live rows not yet under the target model, per table and served model (ids and counts only, owner connection). A
 * never-embedded active prompt counts under NO_MODEL_LABEL. Every table is reported, so a finished re-embed observes 0 (a reading) rather than
 * going silent (no reading).
 */
async function readPending(client: ClientBase, model: string): Promise<ReembedPending[]> {
  const found = await client.query<{ tbl: ReembedPending["table"]; model: string; rows: string }>(
    `SELECT 'tracked_prompts' AS tbl, COALESCE(embedding_model, $2) AS model, count(*) AS rows
       FROM tracked_prompts
      WHERE deleted_at IS NULL AND ((embedding IS NULL AND status = 'active') OR (embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $1))
      GROUP BY 2
     UNION ALL
     SELECT 'semantic_nodes', COALESCE(embedding_model, $2), count(*)
       FROM semantic_nodes
      WHERE embedding IS NOT NULL AND embedding_model IS DISTINCT FROM $1
      GROUP BY 2
      ORDER BY 1, 2`,
    [model, NO_MODEL_LABEL],
  );
  const pending = found.rows.map((row) => ({ table: row.tbl, model: row.model, rows: Number(row.rows) }));
  for (const table of ["tracked_prompts", "semantic_nodes"] as const) {
    const mine = pending.filter((p) => p.table === table);
    if (mine.length === 0) observeValue("nominara_embed_reembed_pending_rows_total", 0, { table, model });
    for (const p of mine) observeValue("nominara_embed_reembed_pending_rows_total", p.rows, { table, model: p.model });
  }
  return pending;
}
