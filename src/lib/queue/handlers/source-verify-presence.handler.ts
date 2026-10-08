import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";
import type { ClientBase } from "pg";
import { z } from "zod";
import { guardedFetch } from "../../net/guarded-fetch.js";
import { verifyProjectSourcePresence, type PresenceFetcher } from "../../sources/verify-presence.js";
import type { QueueHandlerContext } from "../handlers.js";
import type { JobProcessor } from "../worker-factory.js";

// NEW-C-15 / STORY-054 AC4 + AC11 — `source.verify_presence`: for one project,
// fetch the top cited URL per domain (through the guarded fetcher) and record
// whether the brand is on it. The logic is `verifyProjectSourcePresence`; this
// is the queue shell.
//
// `tx` is already inside the job's tenant context (worker-factory verified the
// signature first), so no workspace predicate appears here. Idempotent under
// at-least-once delivery: a redelivery finds every domain inside the 30-day
// cache and fetches nothing.
//
// The run is bounded (MAX_DOMAINS_PER_RUN domains, each fetch bounded by the
// guarded fetcher's own 20 s total timeout) because this handler holds its
// transaction while it fetches — the same shape `crawl.audit` and
// `crawl.discover` already have.

const payloadSchema = z
  .object({
    workspaceId: z.string().uuid(),
    kid: z.string(),
    projectId: z.string().uuid(),
  })
  .strict();

export interface SourceVerifyPresenceDeps {
  readonly fetch?: PresenceFetcher;
  readonly now?: () => Date;
}

export function createSourceVerifyPresenceHandler(_context: QueueHandlerContext, deps: SourceVerifyPresenceDeps = {}): JobProcessor {
  const logger = new Logger("source.verify_presence");
  const fetch = deps.fetch ?? ((url: string) => guardedFetch(url));

  return async (tx: ClientBase, job: Job): Promise<void> => {
    const payload = payloadSchema.parse((job.data as { payload: unknown }).payload);
    // The workspace-local day the index is recomputed as of, from the row — as rollup.metric_daily does.
    const zone = await tx.query<{ today: string }>(
      `SELECT to_char((now() AT TIME ZONE w.timezone)::date, 'YYYY-MM-DD') AS today
         FROM projects p JOIN workspaces w ON w.id = p.workspace_id
        WHERE p.id = $1 AND p.deleted_at IS NULL`,
      [payload.projectId],
    );
    const today = zone.rows[0]?.today;
    if (today === undefined) {
      logger.log({ event: "source_presence_project_gone", workspaceId: payload.workspaceId, projectId: payload.projectId });
      return; // deleted, or another tenant's and invisible to RLS: nothing to verify, nothing wrong
    }
    await verifyProjectSourcePresence(tx, payload.projectId, { fetch, now: (deps.now ?? (() => new Date()))(), today });
  };
}
