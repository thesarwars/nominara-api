import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ClientBase, PoolClient } from "pg";
import { loadEnv } from "../../config/env.js";
import { createPgPool } from "../../db/pg-pool.js";
import { isRealIsoDate } from "../../lib/rollup/iso-date.js";
import { createQueueReaderConnection, queueKeyPrefix } from "../../lib/queue/connection.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { signingKeysFromEnv } from "../../lib/queue/worker-factory.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

// STORY-042 AC10 — the rebuild entry point: regenerate any (project, date range) of `metric_daily` from facts, required
// for a scoring cut-over and for correcting a bad parse (scoring-models.md §14, schemas/sources-and-rollups.md).
//
// IT IS AN AUDITED OPERATOR CLI, NOT `POST /admin/rollups/rebuild`. No admin HTTP surface exists: AdminController is an
// empty scaffold, and the strict IP allow-list plus step-up auth system-architecture.md requires for AdminModule is built
// by no story. A route here would be a new architectural pattern needing staff auth that does not exist. Planner
// recommendation (b), the same shape as plan:set / support:grant / credits:reconcile; the HTTP route is deferred to
// whichever story builds the admin surface.
//
// ⚠ IF THIS FILE EVER BECOMES A NEST PROVIDER IT IS REACHABLE FROM A REQUEST. Keep it a script: no decorator, nothing
// imports it but its own tests.
//
// WHAT IT DOES: inside the named workspace's tenant context it confirms the project is that workspace's (and not
// deleted), appends a hash-chained audit row naming operator and ticket, and COMMITS; only then does it enqueue ONE signed
// range job on `rollup.metric_daily`, whose handler (Scenario 11) rebuilds every date with facts in the range. The audit
// row therefore exists even if the enqueue fails (exit 1): the attempt is on the record. No transaction is held across
// the queue call. The handler is idempotent (upserts), so re-running the same command is safe — and it IS a second job
// (the key carries a per-invocation nonce), because a re-run exists to pick up facts the first one predates.
//
// Usage:
//   pnpm rollup:rebuild --workspace <uuid> --project <uuid> --from YYYY-MM-DD --to YYYY-MM-DD \
//                       --operator <who> --ticket <ref>

export interface RollupRebuildArgs {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly fromDate: string;
  readonly toDate: string;
  readonly operator: string;
  readonly ticket: string;
}

export class RollupRebuildUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RollupRebuildUsageError";
  }
}

export class RollupRebuildProjectNotFoundError extends Error {
  constructor(workspaceId: string, projectId: string) {
    super(`project ${projectId} is not a live project of workspace ${workspaceId}; nothing audited, nothing enqueued`);
    this.name = "RollupRebuildProjectNotFoundError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Exported so every refusal is testable without a database. EVERY flag is mandatory: a rebuild nobody can attribute is the thing the audit row exists to prevent. */
export function parseRollupRebuildArgs(argv: readonly string[]): RollupRebuildArgs {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new RollupRebuildUsageError(`${token} needs a value`);
    flags.set(token.slice(2), value);
    i += 1;
  }
  const required = ["workspace", "project", "from", "to", "operator", "ticket"] as const;
  const missing = required.filter((name) => (flags.get(name) ?? "").trim() === "");
  if (missing.length > 0) throw new RollupRebuildUsageError(`missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`);

  const workspaceId = flags.get("workspace")!;
  const projectId = flags.get("project")!;
  const fromDate = flags.get("from")!;
  const toDate = flags.get("to")!;
  if (!UUID.test(workspaceId)) throw new RollupRebuildUsageError(`--workspace must be a uuid, got ${workspaceId}`);
  if (!UUID.test(projectId)) throw new RollupRebuildUsageError(`--project must be a uuid, got ${projectId}`);
  if (!isRealIsoDate(fromDate)) throw new RollupRebuildUsageError(`--from must be a real YYYY-MM-DD date, got ${fromDate}`);
  if (!isRealIsoDate(toDate)) throw new RollupRebuildUsageError(`--to must be a real YYYY-MM-DD date, got ${toDate}`);
  if (fromDate > toDate) throw new RollupRebuildUsageError(`--from ${fromDate} is after --to ${toDate}`);
  return { workspaceId, projectId, fromDate, toDate, operator: flags.get("operator")!, ticket: flags.get("ticket")! };
}

/**
 * One key per INVOCATION (project, range, ticket and a nonce). A re-run is deliberately not deduplicated: BullMQ keeps a
 * deduplication key for the completed-job retention window, so a re-run after a re-parse finished would otherwise print
 * "requested" and rebuild nothing. The handler upserts, so a second rebuild is safe.
 */
export function rebuildJobKey(projectId: string, fromDate: string, toDate: string, ticket: string, nonce: string): string {
  return `rollup:${projectId}:rebuild:${fromDate}:${toDate}:${ticket}:${nonce}`;
}

export type RebuildEnqueue = (queue: "rollup.metric_daily", workspaceId: string, payload: Record<string, unknown>, idempotencyKey: string) => Promise<unknown>;

export interface RollupRebuildDeps {
  /** A connection to run the tenant-context transaction on (a pooled client in production). */
  readonly client: PoolClient | ClientBase;
  readonly enqueue: RebuildEnqueue;
  /** One per invocation; injectable so a test can name the key. */
  readonly nonce?: () => string;
}

export async function runRollupRebuild(args: RollupRebuildArgs, deps: RollupRebuildDeps, log: (line: string) => void = console.log): Promise<void> {
  await withTenantContext(deps.client as PoolClient, { workspaceId: args.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    // RLS is the guarantee; the explicit workspace predicate is why a project of ANOTHER workspace is refused by name
    // rather than by an empty result an operator might mistake for "no facts".
    const found = await tx.query("SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL", [args.projectId, args.workspaceId]);
    if (found.rowCount === 0) throw new RollupRebuildProjectNotFoundError(args.workspaceId, args.projectId);
    await new AuditChainService().append(tx, {
      workspaceId: args.workspaceId,
      actorType: "system",
      actorId: SYSTEM_ACTOR_ID,
      actorIp: null,
      actorUa: `operator:${args.operator}`,
      action: "rollup.rebuild_requested",
      resourceType: "project",
      resourceId: args.projectId,
      beforeState: null,
      afterState: { from_date: args.fromDate, to_date: args.toDate, ticket: args.ticket, operator: args.operator },
      requestId: args.ticket,
      supportGrantId: null,
      severity: "warning",
    });
  });

  // Committed: only now does the job go out.
  await deps.enqueue(
    "rollup.metric_daily",
    args.workspaceId,
    { projectId: args.projectId, fromDate: args.fromDate, toDate: args.toDate, reason: "rebuild" },
    rebuildJobKey(args.projectId, args.fromDate, args.toDate, args.ticket, (deps.nonce ?? randomUUID)()),
  );
  incrementCounter("nominara_rollup_rebuild_requested_total");
  log(`rebuild of project ${args.projectId} ${args.fromDate}..${args.toDate} requested (ticket ${args.ticket}); workspace ${args.workspaceId}`);
}

async function main(): Promise<void> {
  const args = parseRollupRebuildArgs(process.argv.slice(2));
  const env = loadEnv();
  const pool = createPgPool(env.DATABASE_URL_POOLED);
  const connection = createQueueReaderConnection(env.QUEUE_REDIS_URL);
  const producer = new QueueProducer(connection, queueKeyPrefix(env.NODE_ENV), signingKeysFromEnv(env));
  try {
    const client = await pool.connect();
    try {
      await runRollupRebuild(args, {
        client,
        enqueue: (queue, workspaceId, payload, idempotencyKey) => producer.enqueueTenantJob(queue, workspaceId, payload, { idempotencyKey }),
      });
    } finally {
      client.release();
    }
  } finally {
    await producer.onModuleDestroy();
    await connection.quit().catch(() => connection.disconnect());
    await pool.end();
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
