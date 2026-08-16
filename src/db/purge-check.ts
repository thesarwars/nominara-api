import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { connect, requireDatabaseUrl } from "./client.js";

// STORY-013 — NFR-CMP-05 / edge-cases-and-slos.md: "a purge failure alerts
// and blocks the next release train if unresolved for 7 days". This is the
// deploy-gate half of that requirement — `src/workers/rollup/retention.ts`'s
// `recordPurgeFailure` is the write side. Same shape as `pnpm db:rls-check`:
// a plain CLI, callable today, wired into an actual release pipeline by a
// future CI story (disclosed as part of gap G-5 — "no CI to run it in",
// not a new gap).

export const PURGE_FAILURE_GRACE_DAYS = 7;

export interface UnresolvedPurgeFailure {
  readonly id: string;
  readonly scope: string;
  readonly scopeId: string;
  readonly reason: string;
  readonly failedAt: Date;
}

/** Every `purge_failures` row unresolved past the 7-day grace window. */
export async function findBlockingPurgeFailures(client: Client): Promise<UnresolvedPurgeFailure[]> {
  const result = await client.query<{ id: string; scope: string; scope_id: string; reason: string; failed_at: Date }>(
    `SELECT id, scope, scope_id, reason, failed_at
       FROM purge_failures
      WHERE resolved_at IS NULL
        AND failed_at < now() - ($1 || ' days')::interval
      ORDER BY failed_at ASC`,
    [PURGE_FAILURE_GRACE_DAYS],
  );
  return result.rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id,
    reason: row.reason,
    failedAt: row.failed_at,
  }));
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    const blocking = await findBlockingPurgeFailures(client);
    if (blocking.length > 0) {
      console.error(`db:purge-check failed: ${blocking.length} purge failure(s) unresolved past ${PURGE_FAILURE_GRACE_DAYS} days:`);
      for (const failure of blocking) {
        console.error(`  ${failure.scope}/${failure.scopeId} — ${failure.reason} (failed_at=${failure.failedAt.toISOString()})`);
      }
      process.exit(1);
    }
    console.log("db:purge-check passed: no purge failures unresolved past the grace window");
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
