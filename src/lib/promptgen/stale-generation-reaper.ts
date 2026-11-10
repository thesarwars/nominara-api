import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { failGeneration } from "./generation-job.js";

// STORY-045 / OWNER DECISION 95(a) - the reaper for a prompt generation whose job never settled it.
//
// `prompt.generate` settles its row on success (commit) and on its LAST failed attempt (recover). A job BullMQ drops as stalled - the worker died
// mid-pass and the stalled-job limit was spent - never reaches `recover`, so the row would stay `pending`/`running` for ever and the client would
// poll it for ever. So a generation still unsettled after STALE_GENERATION_AFTER_MINUTES is failed with the EXISTING code `generation_failed` (no
// new failure_code value, so no contract or CHECK change), through the same workspace-scoped, idempotent `failGeneration` the job uses.
//
// THE BOUND: 30 minutes. A pass is bounded by the queue's own numbers: prompt.generate retries with doubling(2) = 2s + 4s, so 3 attempts and 6s of
// backoff; each attempt's external calls are bounded (the naturaliser by PROMPT_NATURALISER_TIMEOUT_MS, at most 30s; the embedder by its client),
// so a healthy generation settles in well under a few minutes. 30 minutes leaves an order of magnitude over 3 attempts plus BullMQ's stalled-job
// detection and a crawl-group backlog (concurrency 3), yet ends a lost job's polling inside one sitting. A job that IS still running when the bound
// passes loses the race to nothing: its commit locks the row, finds it `failed` and writes nothing (commitGeneration), and a redelivery's prepare
// ends the job on a settled row.
//
// RUNS ON THE SWEEP'S OWNER CONNECTION (it must see across tenants to find them). That connection is not bound by RLS, so every write is inside a
// per-generation withTenantContext and failGeneration's UPDATE carries `workspace_id = app.current_workspace()`. The cutoff is the database's clock,
// the clock that stamped `created_at`.

const logger = new Logger("prompts.stale-generation-reaper");

export const STALE_GENERATION_AFTER_MINUTES = 30;

export async function reapStaleGenerations(
  client: ClientBase,
  _now: Date,
  staleAfterMinutes: number = STALE_GENERATION_AFTER_MINUTES,
): Promise<{ readonly reaped: number }> {
  // IDs only: no request body or result is read.
  const stale = await client.query<{ id: string; workspace_id: string; project_id: string }>(
    `SELECT id, workspace_id, project_id FROM prompt_generations
      WHERE status IN ('pending', 'running') AND created_at < now() - make_interval(mins => $1::int)
      ORDER BY created_at ASC LIMIT 500`,
    [staleAfterMinutes],
  );
  let reaped = 0;
  for (const row of stale.rows) {
    try {
      const done = await withTenantContext(client, { workspaceId: row.workspace_id, actorId: SYSTEM_ACTOR_ID }, (tx) =>
        failGeneration(tx, row.id, "generation_failed"),
      );
      if (!done) continue;
      reaped += 1;
      incrementCounter("nominara_prompts_generation_total", { outcome: "stale_reaped" });
      logger.warn({ event: "prompts.generation.reaped_stale", workspace_id: row.workspace_id, project_id: row.project_id, generation_id: row.id });
    } catch (error) {
      // One generation's failure must not stop the others, nor the sweep that called us.
      logger.error({ event: "prompts.generation.reap_failed", workspace_id: row.workspace_id, generation_id: row.id, error: error instanceof Error ? error.name : "unknown" });
    }
  }
  return { reaped };
}
