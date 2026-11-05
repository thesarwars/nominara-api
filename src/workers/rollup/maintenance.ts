import { fileURLToPath } from "node:url";
import type { Client, ClientBase } from "pg";
import {
  HNSW_INDEXED_TABLES,
  HNSW_REBUILD_EF_CONSTRUCTION,
  HOT_WINDOW_DAYS,
  PARTITIONED_FACT_TABLES,
  PARTITION_LEAD_MONTHS,
  VACUUM_TUNED_TABLES,
  VECTOR_RECALL_THRESHOLD,
  type PartitionedFactTable,
} from "../../db/conventions.js";
import { connect, requireDatabaseUrl } from "../../db/client.js";

// STORY-013 — data-model.md §5 "Partitioning" / §8 "Vacuum and maintenance".
// The monthly maintenance job. Per this story's Technical Notes ("no
// src/workers/ runtime exists yet" — STORY-022/STORY-030 are both still
// Backlog): plain, exported, dependency-free TS functions taking a `Client`/
// `ClientBase` directly, no BullMQ, no Nest. `pnpm db:maintenance:run` (this
// file's own `main()`) is the only caller today; STORY-030's BullMQ
// processor imports `runMonthlyMaintenance` unchanged when it lands —
// README.md gap G-10 discloses cron registration not existing until then.

export const MAINTENANCE_LOCK_KEY = "maintenance.partition";

// ---------------------------------------------------------------------------
// small SQL-safety helpers — every identifier this module interpolates is
// either a PARTITIONED_FACT_TABLES literal or a name THIS module generated
// itself (never user input), but every string is still quoted defensively.
// ---------------------------------------------------------------------------

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function tableExists(client: ClientBase, relname: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>("SELECT EXISTS (SELECT 1 FROM pg_class WHERE relname = $1) AS exists", [
    relname,
  ]);
  return result.rows[0]!.exists;
}

function renderStorageParams(tuning: (typeof VACUUM_TUNED_TABLES)[string]): string {
  const parts = [
    `autovacuum_vacuum_scale_factor = ${tuning.vacuumScaleFactor}`,
    `autovacuum_analyze_scale_factor = ${tuning.analyzeScaleFactor}`,
  ];
  if (tuning.fillfactor !== undefined) parts.push(`fillfactor = ${tuning.fillfactor}`);
  if (tuning.vacuumThreshold !== undefined) parts.push(`autovacuum_vacuum_threshold = ${tuning.vacuumThreshold}`);
  if (tuning.analyzeThreshold !== undefined) parts.push(`autovacuum_analyze_threshold = ${tuning.analyzeThreshold}`);
  return parts.join(", ");
}

// ---------------------------------------------------------------------------
// Advisory lock — AC "advisory-locked and idempotent". Blocking form: a
// second concurrent invocation genuinely WAITS (Test Scenario 2), it does not
// abort or silently no-op.
// ---------------------------------------------------------------------------

export async function acquireAdvisoryLock(client: ClientBase, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [key]);
}

export async function releaseAdvisoryLock(client: ClientBase, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [key]);
}

export async function withAdvisoryLock<T>(client: ClientBase, key: string, fn: () => Promise<T>): Promise<T> {
  await acquireAdvisoryLock(client, key);
  try {
    return await fn();
  } finally {
    await releaseAdvisoryLock(client, key);
  }
}

// ---------------------------------------------------------------------------
// Partition creation — data-model.md §5's `app.ensure_partitions` sample,
// implemented at the TS-orchestration layer per this story's Technical
// Notes, with an injectable `referenceDate` so tests never depend on the
// wall clock. Every partition created calls `app.apply_tenant_rls` BEFORE
// this function returns — STORY-011's headline finding, closed here.
// ---------------------------------------------------------------------------

export interface PartitionMonth {
  readonly start: Date;
  readonly end: Date;
  readonly suffix: string;
}

function monthSuffix(date: Date): string {
  return `${date.getUTCFullYear()}_${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function computePartitionMonths(referenceDate: Date, monthsAhead: number = PARTITION_LEAD_MONTHS): PartitionMonth[] {
  const months: PartitionMonth[] = [];
  for (let i = 0; i <= monthsAhead; i += 1) {
    const start = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + i, 1));
    const end = new Date(Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth() + i + 1, 1));
    months.push({ start, end, suffix: monthSuffix(start) });
  }
  return months;
}

/**
 * Issues the three DDL statements that bring a new partition into existence
 * WITHOUT opening or closing a transaction itself — a caller that already
 * holds one open (catchUpDefaultPartition) calls this directly so the whole
 * extract-create-reinsert sequence commits or rolls back as one unit; every
 * other caller goes through `createPartition` below, which wraps these same
 * three statements in their own transaction.
 */
async function createPartitionStatements(
  client: ClientBase,
  table: string,
  name: string,
  start: Date,
  end: Date,
): Promise<void> {
  await client.query(
    `CREATE TABLE ${quoteIdent(name)} PARTITION OF ${quoteIdent(table)} ` +
      `FOR VALUES FROM (${quoteLiteral(start.toISOString())}) TO (${quoteLiteral(end.toISOString())})`,
  );
  // STORY-011's headline finding: ENABLE/FORCE ROW LEVEL SECURITY on a
  // partitioned PARENT does not cascade to a new child. This call is the
  // fix, made unconditionally, immediately, before the partition can take
  // any other write — proven by ISO-17 (test/isolation/assertions/
  // iso-17-partition-rls-applied.ts).
  await client.query("SELECT app.apply_tenant_rls($1::regclass)", [name]);

  const tuning = VACUUM_TUNED_TABLES[table];
  if (tuning) {
    // Storage parameters set on a partitioned PARENT are not assumed to
    // propagate to a child created later (verified, not assumed — see
    // test/integration/partition-maintenance.spec.ts) — re-applied here
    // explicitly, every time, on every new partition.
    await client.query(`ALTER TABLE ${quoteIdent(name)} SET (${renderStorageParams(tuning)})`);
  }
}

export const PARTITION_DDL_LOCK_TIMEOUT_MS = 5_000;

/**
 * Creates one partition, atomically. `CREATE TABLE ... PARTITION OF` and
 * `apply_tenant_rls` used to run as two separate autocommitted statements —
 * the instant the CREATE TABLE committed, the partition was live and
 * routable by concurrent writers with zero RLS enforcement until the very
 * next statement committed moments later: STORY-011's exact bypass,
 * narrowed to a race window instead of closed. Wrapping all three
 * statements in one BEGIN...COMMIT means the DDL's ACCESS EXCLUSIVE lock is
 * held continuously until RLS is active — any concurrent writer targeting
 * this partition must block until it is already protected.
 */
async function createPartition(client: ClientBase, table: string, name: string, start: Date, end: Date): Promise<void> {
  await client.query("BEGIN");
  try {
    // Bounded wait for the ACCESS EXCLUSIVE lock on the parent: a long reader (the nightly integrity scan) must make this DDL fail and
    // retry tomorrow, never queue every capture INSERT behind a pending exclusive lock. Transaction-local.
    await client.query(`SET LOCAL lock_timeout = '${String(PARTITION_DDL_LOCK_TIMEOUT_MS)}ms'`);
    await createPartitionStatements(client, table, name, start, end);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function ensurePartitionsForTable(
  client: ClientBase,
  table: PartitionedFactTable,
  referenceDate: Date,
  monthsAhead: number = PARTITION_LEAD_MONTHS,
): Promise<string[]> {
  const created: string[] = [];
  for (const { start, end, suffix } of computePartitionMonths(referenceDate, monthsAhead)) {
    const name = `${table}_${suffix}`;
    if (await tableExists(client, name)) {
      continue;
    }
    await createPartition(client, table, name, start, end);
    created.push(name);
  }
  return created;
}

/**
 * ⚠ ONE UNCREATABLE MONTH MUST NOT SILENCE THE WHOLE ESTATE, which is what
 * this used to do. STORY-142's review reproduced it: a single row sitting in
 * a DEFAULT partition whose month falls INSIDE the lead window makes
 * `CREATE ... ATTACH` fail with "updated partition constraint for default
 * partition would be violated by some row" — and because the loop simply
 * propagated, nothing at all was created. Not that month, not the months
 * after it, and not the other two fact tables, which were never reached.
 *
 * Under the hand-run script that was an operator reading an error. On a daily
 * tick it is the job that guards the runway refusing to run, identically,
 * every day, while the runway expires — the exact outcome the schedule was
 * added to prevent, now self-inflicted.
 *
 * So a failure is RECORDED AND STEPPED OVER. Every other month and every
 * other table still gets its partition, and the months that could not be
 * created come back as `failures` for the caller to surface. The remedy for
 * them is `catchUpDefaultPartition`, which moves the stranded rows out.
 */
export interface EnsurePartitionsOutcome {
  readonly created: readonly string[];
  readonly failures: readonly { partition: string; reason: string }[];
}

export async function ensureAllPartitions(
  client: ClientBase,
  referenceDate: Date = new Date(),
  monthsAhead: number = PARTITION_LEAD_MONTHS,
): Promise<EnsurePartitionsOutcome> {
  const created: string[] = [];
  const failures: { partition: string; reason: string }[] = [];
  for (const table of PARTITIONED_FACT_TABLES) {
    for (const { start, end, suffix } of computePartitionMonths(referenceDate, monthsAhead)) {
      const name = `${table}_${suffix}`;
      if (await tableExists(client, name)) continue;
      try {
        await createPartition(client, table, name, start, end);
        created.push(name);
      } catch (error) {
        failures.push({ partition: name, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { created, failures };
}

/**
 * The half of maintenance that is safe to run often: find out what is
 * stranded, then extend the runway.
 *
 * ⚠ DETECTION RUNS FIRST, AND IT IS NOT THE LOAD-BEARING HALF OF THAT FIX —
 * say so here rather than let the next reader assume it. `runMonthlyMaintenance`
 * detects AFTER creating, so a creation failure used to take the alert down
 * with it: the one signal that would have explained the failure never reached
 * anyone. What actually fixes that is `ensureAllPartitions` recording failures
 * instead of throwing, and with that in place detection would still run in
 * either order. A mutation swapping these two lines back passes all seven
 * tests; the mutation that removes record-and-continue fails two.
 *
 * The order stays because it is free and because it is the right shape — find
 * out what is stranded before acting on it, not after — and it is insurance
 * against any statement added between the two later that CAN throw. It is not
 * pinned by a test, and nothing here pretends otherwise.
 *
 * Deliberately does NOT detach, drop, reindex or
 * analyse. See `runMonthlyMaintenance` and STORY-142's cadence note.
 */
export interface RunwayMaintenanceResult {
  readonly defaultPartitionAlerts: readonly DefaultPartitionAlert[];
  readonly partitionsCreated: readonly string[];
  readonly partitionFailures: readonly { partition: string; reason: string }[];
}

export async function runPartitionRunwayMaintenance(
  client: Client,
  options: { readonly referenceDate?: Date } = {},
): Promise<RunwayMaintenanceResult> {
  return withAdvisoryLock(client, MAINTENANCE_LOCK_KEY, async () => {
    const referenceDate = options.referenceDate ?? new Date();
    const defaultPartitionAlerts = await detectDefaultPartitionRows(client);
    const { created, failures } = await ensureAllPartitions(client, referenceDate);
    return { defaultPartitionAlerts, partitionsCreated: created, partitionFailures: failures };
  });
}

// ---------------------------------------------------------------------------
// Default-partition alert + catch-up — AC "a non-zero row count in any
// default partition raises an alert ... and a catch-up path moves those rows
// into the correct partition".
// ---------------------------------------------------------------------------

export interface DefaultPartitionAlert {
  readonly table: PartitionedFactTable;
  readonly defaultPartition: string;
  readonly rowCount: number;
}

/**
 * ⚠ FAIL CLOSED: every tenant table carries FORCE ROW LEVEL SECURITY, so a role that is neither a superuser nor BYPASSRLS reads ZERO rows
 * with no error. A cross-tenant READ made on such a connection (orphan scan, recall check, default-partition count) would report a clean
 * estate. The check is on the privilege, never on a row count (a blind role also sees an empty `workspaces`) — same query and reasoning
 * as `assertVerifierCanSee` in audit-verify.ts. The lasting fix (a count-only SECURITY DEFINER function behind a role-targeted policy)
 * needs an ADR and an owner decision; see docs/plans/evidence/STORY-013.md.
 */
export const TENANT_BLIND_MESSAGE = "cannot see tenant rows";

export async function assertCanSeeTenantRows(client: ClientBase): Promise<void> {
  const result = await client.query<{ can_see: boolean }>(
    "SELECT (rolsuper OR rolbypassrls) AS can_see FROM pg_roles WHERE rolname = current_user",
  );
  if (result.rows[0]?.can_see === true) return;
  throw new Error(
    `this connection ${TENANT_BLIND_MESSAGE}: its role neither is a superuser nor bypasses row-level security (privilege), so a count would read 0 whatever the data holds`,
  );
}

export async function detectDefaultPartitionRows(client: ClientBase): Promise<DefaultPartitionAlert[]> {
  const alerts: DefaultPartitionAlert[] = [];
  for (const table of PARTITIONED_FACT_TABLES) {
    const defaultPartition = `${table}_default`;
    const result = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quoteIdent(defaultPartition)}`);
    const rowCount = Number(result.rows[0]!.count);
    if (rowCount > 0) {
      alerts.push({ table, defaultPartition, rowCount });
    }
  }
  return alerts;
}

/**
 * Moves every row currently misfiled in `<table>_default` into the correct
 * monthly partition (creating it first if it does not exist yet), by
 * re-inserting through the PARENT so Postgres itself routes each row —
 * never by naming a specific child partition for the INSERT.
 *
 * Order matters: Postgres validates, AT `CREATE TABLE ... PARTITION OF`
 * time, that the DEFAULT partition holds no row already inside the new
 * partition's range — "updated partition constraint for default partition
 * ... would be violated by some row" — so the misfiled rows must be
 * extracted from the default partition BEFORE the new partition is created,
 * never after.
 *
 * The whole function runs inside ONE transaction (should-fix, code review):
 * extraction, partition creation, and re-insertion used to be three separate
 * autocommitted statements — a concurrent insert into the same default-
 * partition range landing between the DELETE and the CREATE TABLE would fail
 * Postgres's own constraint check on the CREATE TABLE, but the DELETE would
 * already have committed, permanently losing the extracted rows. One
 * transaction means that failure rolls the DELETE back too. Calls
 * `createPartitionStatements` directly (not `createPartition`, which opens
 * its own nested BEGIN/COMMIT) so this stays a single atomic unit.
 */
export async function catchUpDefaultPartition(client: ClientBase, table: PartitionedFactTable): Promise<string[]> {
  const defaultPartition = `${table}_default`;
  await client.query("BEGIN");
  try {
    const monthsResult = await client.query<{ month: Date }>(
      `SELECT DISTINCT date_trunc('month', captured_at) AS month FROM ${quoteIdent(defaultPartition)} ORDER BY 1`,
    );

    const movedInto: string[] = [];
    for (const row of monthsResult.rows) {
      const monthStart = new Date(row.month);
      const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));
      const name = `${table}_${monthSuffix(monthStart)}`;

      const extracted = await client.query<Record<string, unknown>>(
        `DELETE FROM ${quoteIdent(defaultPartition)} WHERE captured_at >= $1 AND captured_at < $2 RETURNING *`,
        [monthStart.toISOString(), monthEnd.toISOString()],
      );

      if (!(await tableExists(client, name))) {
        await createPartitionStatements(client, table, name, monthStart, monthEnd);
      }

      if (extracted.rows.length > 0) {
        const columns = Object.keys(extracted.rows[0]!);
        const columnList = columns.map(quoteIdent).join(", ");
        const valueGroups: string[] = [];
        const params: unknown[] = [];
        for (const extractedRow of extracted.rows) {
          const placeholders = columns.map((column) => {
            params.push(extractedRow[column]);
            return `$${params.length}`;
          });
          valueGroups.push(`(${placeholders.join(", ")})`);
        }
        await client.query(`INSERT INTO ${quoteIdent(table)} (${columnList}) VALUES ${valueGroups.join(", ")}`, params);
      }
      movedInto.push(name);
    }
    await client.query("COMMIT");
    return movedInto;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Partition bound discovery — shared by detach/drop, ANALYZE,
// and retention.ts's orphan scan (imported from there, not reimplemented).
// ---------------------------------------------------------------------------

export interface PartitionBound {
  readonly name: string;
  readonly parent: string;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly isDefault: boolean;
}

export function parsePartitionBound(name: string, parent: string, bound: string): PartitionBound {
  const trimmed = bound.trim();
  if (/^default$/i.test(trimmed)) {
    return { name, parent, from: null, to: null, isDefault: true };
  }
  const match = trimmed.match(/FOR VALUES FROM \('([^']+)'\) TO \('([^']+)'\)/i);
  if (!match) {
    throw new Error(`maintenance.ts: unrecognized partition bound for ${name}: ${bound}`);
  }
  return { name, parent, from: new Date(match[1]!), to: new Date(match[2]!), isDefault: false };
}

export async function listPartitions(client: ClientBase, table: string): Promise<PartitionBound[]> {
  const result = await client.query<{ relname: string; bound: string }>(
    `SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
      WHERE p.relname = $1 AND c.relkind = 'r'`,
    [table],
  );
  return result.rows.map((row) => parsePartitionBound(row.relname, table, row.bound));
}

// ---------------------------------------------------------------------------
// Detach + drop, synchronized across all three tables for the same month —
// data-model.md §5's "documented trade-off" #4 and §8 step 3.
// ---------------------------------------------------------------------------

export interface DroppedPartitionGroup {
  readonly monthSuffix: string;
  readonly tables: readonly PartitionedFactTable[];
}

/**
 * The platform-wide number of days after which a fact-table partition is
 * safe to physically drop — the MAXIMUM `retention.raw_captures_days`
 * entitlement across every active workspace, or `null` if any active
 * workspace's entitlement is `null`/`"unlimited"` (both mean "never purge"),
 * in which case NO partition is ever safe to drop and this function returns
 * `null`. Deliberately does not merge `workspaces.entitlement_overrides` —
 * scoped simplification, see this story's Implementation Decisions.
 */
/**
 * Pure reduction over a set of `retention.raw_captures_days` entitlement
 * values (one per active workspace): the platform-wide MAX, or `null` if ANY
 * value is null/"unlimited" (both mean "never purge"). A literal `0`-day
 * entitlement is a valid, distinct numeric case — NOT collapsed into `null`
 * (should-fix, code review: `max > 0 ? max : null` used to silently map
 * `0 → null`, indistinguishable from an actual unlimited entitlement).
 * Mirrors resolveRetentionCutoff's own null/unlimited/numeric branching
 * below. Extracted as a pure function so this branching is unit-testable
 * without a database — see test/unit/partition-maintenance.spec.ts.
 */
export function resolveMaxRetentionDays(values: readonly unknown[]): number | null {
  let max: number | null = null;
  for (const value of values) {
    if (value === null || value === "unlimited") {
      return null;
    }
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    if (max === null || numeric > max) max = numeric;
  }
  return max;
}

export async function resolveDetachDropCutoffDays(client: ClientBase, referenceDate: Date = new Date()): Promise<number | null> {
  const result = await client.query<{ value: unknown; until: Date | null; deferred_raw: number | null }>(
    // ->'value': entitlements are {value, live} since STORY-069.
    `SELECT DISTINCT p.entitlements->'retention.raw_captures_days'->'value' AS value,
                     w.retention_purge_not_before                          AS until,
                     w.retention_deferred_raw_days                         AS deferred_raw
       FROM workspaces w
       JOIN plans p ON p.key = w.plan_key
      WHERE w.deleted_at IS NULL`,
  );
  // STORY-077 slice B (EC-41): a workspace whose retention shortening is still deferred keeps the window it was moved off
  // until its purge date, so that window counts in the maximum too. A NULL kept window is "never purged": null in the
  // reduction means no partition is dropped. Nothing here shortens a window; the deferral can only keep a partition longer.
  const values: unknown[] = [];
  for (const row of result.rows) {
    values.push(row.value);
    if (row.until !== null && row.until.getTime() >= referenceDate.getTime()) values.push(row.deferred_raw);
  }
  return resolveMaxRetentionDays(values);
}

export async function detachAndDropPartitions(
  client: ClientBase,
  referenceDate: Date = new Date(),
): Promise<DroppedPartitionGroup[]> {
  const cutoffDays = await resolveDetachDropCutoffDays(client, referenceDate);
  if (cutoffDays === null) {
    return [];
  }
  const cutoff = new Date(referenceDate.getTime() - cutoffDays * 86_400_000);

  const eligibleByTable = new Map<PartitionedFactTable, Map<string, string>>();
  for (const table of PARTITIONED_FACT_TABLES) {
    const bySuffix = new Map<string, string>();
    for (const partition of await listPartitions(client, table)) {
      if (partition.isDefault || !partition.to || partition.to > cutoff) {
        continue;
      }
      // `to` is the partition's EXCLUSIVE upper bound (the first instant of
      // the NEXT month) — step back one day to land inside the covered
      // month before deriving its YYYY_MM suffix.
      bySuffix.set(monthSuffix(new Date(partition.to.getTime() - 86_400_000)), partition.name);
    }
    eligibleByTable.set(table, bySuffix);
  }

  const [first, ...rest] = PARTITIONED_FACT_TABLES;
  const commonSuffixes = [...eligibleByTable.get(first)!.keys()]
    .filter((suffix) => rest.every((table) => eligibleByTable.get(table)!.has(suffix)))
    .sort();

  const dropped: DroppedPartitionGroup[] = [];
  for (const suffix of commonSuffixes) {
    await client.query("BEGIN");
    try {
      for (const table of PARTITIONED_FACT_TABLES) {
        const partitionName = eligibleByTable.get(table)!.get(suffix)!;
        await client.query(`ALTER TABLE ${quoteIdent(table)} DETACH PARTITION ${quoteIdent(partitionName)}`);
        await client.query(`DROP TABLE ${quoteIdent(partitionName)}`);
      }
      await client.query("COMMIT");
      dropped.push({ monthSuffix: suffix, tables: PARTITIONED_FACT_TABLES });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
  return dropped;
}

// ---------------------------------------------------------------------------
// Vector index recall check + concurrent rebuild — data-model.md §8 step 4.
// "Fixed in-repo query set": deterministic (seeded) unit vectors, committed
// as code rather than a binary fixture, so the query set is reproducible
// without checking in a large file.
// ---------------------------------------------------------------------------

function deterministicUnitVector(dims: number, seed: number): number[] {
  let state = (seed >>> 0) || 1;
  const next = (): number => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xffffffff;
  };
  const raw = Array.from({ length: dims }, () => next() * 2 - 1);
  const norm = Math.sqrt(raw.reduce((sum, v) => sum + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

// The fixed golden query set — three deterministic seeds, dims = 1536
// (halfvec(1536), every HNSW_INDEXED_TABLES column).
export const GOLDEN_QUERY_VECTORS: readonly number[][] = [11, 47, 103].map((seed) => deterministicUnitVector(1536, seed));

export async function computeRecallAtK(
  client: ClientBase,
  table: string,
  column: string,
  k = 10,
  queries: readonly number[][] = GOLDEN_QUERY_VECTORS,
): Promise<number | null> {
  const countResult = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL`,
  );
  if (Number(countResult.rows[0]!.count) < k) {
    return null;
  }

  let totalRecall = 0;
  await client.query("BEGIN");
  try {
    for (const vector of queries) {
      const literal = `[${vector.join(",")}]`;
      // `<=>` (cosine distance), NOT `<->` (L2) — every HNSW index this
      // module checks (migrations 0003/0004) is built with `..._cosine_ops`.
      // The distance operator in an ORDER BY must match the index's opclass
      // for Postgres to consider the index at all; `<->` against a cosine
      // opclass index is never a candidate plan, so the "ANN" query below
      // silently fell back to a full sort every time, in production too —
      // discovered live via EXPLAIN while fixing qa-reviewer finding #5 (a
      // real-threshold recall test could never observe genuine degradation
      // because the index was never actually being queried).
      const ann = await client.query<{ id: string }>(
        `SELECT id FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL ORDER BY ${quoteIdent(column)} <=> $1 LIMIT $2`,
        [literal, k],
      );

      await client.query("SET LOCAL enable_indexscan = off");
      await client.query("SET LOCAL enable_bitmapscan = off");
      const exact = await client.query<{ id: string }>(
        `SELECT id FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL ORDER BY ${quoteIdent(column)} <=> $1 LIMIT $2`,
        [literal, k],
      );
      await client.query("RESET enable_indexscan");
      await client.query("RESET enable_bitmapscan");

      const annIds = new Set(ann.rows.map((r) => r.id));
      const exactIds = new Set(exact.rows.map((r) => r.id));
      let hits = 0;
      for (const id of annIds) if (exactIds.has(id)) hits += 1;
      totalRecall += hits / k;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return totalRecall / queries.length;
}

export interface RecallCheckResult {
  readonly table: string;
  readonly column: string;
  readonly indexName: string;
  readonly recallAt10: number | null;
  readonly rebuildTriggered: boolean;
}

async function rebuildHnswIndex(client: ClientBase, indexName: string, efConstruction: number): Promise<void> {
  if (!Number.isInteger(efConstruction) || efConstruction <= 0) {
    throw new Error(`maintenance.ts: invalid ef_construction ${efConstruction}`);
  }
  // pgvector: ef_construction only affects a FUTURE build of the index — the
  // REINDEX is what actually applies it (data-model.md §8 step 4, literally
  // "REINDEX CONCURRENTLY ... rebuilding with ef_construction = 128").
  await client.query(`ALTER INDEX ${quoteIdent(indexName)} SET (ef_construction = ${efConstruction})`);
  await client.query(`REINDEX INDEX CONCURRENTLY ${quoteIdent(indexName)}`);
}

export async function checkAndRebuildVectorIndexes(
  client: ClientBase,
  options: { threshold?: number; efConstruction?: number } = {},
): Promise<RecallCheckResult[]> {
  const threshold = options.threshold ?? VECTOR_RECALL_THRESHOLD;
  const efConstruction = options.efConstruction ?? HNSW_REBUILD_EF_CONSTRUCTION;

  const results: RecallCheckResult[] = [];
  for (const { table, column, indexName } of HNSW_INDEXED_TABLES) {
    const recallAt10 = await computeRecallAtK(client, table, column);
    let rebuildTriggered = false;
    if (recallAt10 !== null && recallAt10 < threshold) {
      await rebuildHnswIndex(client, indexName, efConstruction);
      rebuildTriggered = true;
    }
    results.push({ table, column, indexName, recallAt10, rebuildTriggered });
  }
  return results;
}

// ---------------------------------------------------------------------------
// ANALYZE active partitions — data-model.md §8 step 5.
// ---------------------------------------------------------------------------

export async function analyzeActivePartitions(
  client: ClientBase,
  referenceDate: Date = new Date(),
  hotWindowDays: number = HOT_WINDOW_DAYS,
): Promise<string[]> {
  const cutoff = referenceDate.getTime() - hotWindowDays * 86_400_000;
  const analyzed: string[] = [];
  for (const table of PARTITIONED_FACT_TABLES) {
    for (const partition of await listPartitions(client, table)) {
      if (partition.isDefault) continue;
      if (partition.to && partition.to.getTime() < cutoff) continue;
      await client.query(`ANALYZE ${quoteIdent(partition.name)}`);
      analyzed.push(partition.name);
    }
  }
  return analyzed;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export interface MaintenanceOptions {
  readonly referenceDate?: Date;
}

export interface MaintenanceResult {
  readonly partitionsCreated: readonly string[];
  readonly defaultPartitionAlerts: readonly DefaultPartitionAlert[];
  readonly dropped: readonly DroppedPartitionGroup[];
  readonly recallChecks: readonly RecallCheckResult[];
  readonly analyzed: readonly string[];
  /** Months that could not be created, with the reason — see `ensureAllPartitions`. */
  readonly partitionFailures: readonly { partition: string; reason: string }[];
}

export async function runMonthlyMaintenance(client: Client, options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
  return withAdvisoryLock(client, MAINTENANCE_LOCK_KEY, async () => {
    const referenceDate = options.referenceDate ?? new Date();
    const { created: partitionsCreated, failures: partitionFailures } = await ensureAllPartitions(client, referenceDate);
    const defaultPartitionAlerts = await detectDefaultPartitionRows(client);
    const dropped = await detachAndDropPartitions(client, referenceDate);
    const recallChecks = await checkAndRebuildVectorIndexes(client);
    const analyzed = await analyzeActivePartitions(client, referenceDate);
    return { partitionsCreated, partitionFailures, defaultPartitionAlerts, dropped, recallChecks, analyzed };
  });
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    const result = await runMonthlyMaintenance(client);
    console.log(JSON.stringify(result, null, 2));
    if (result.defaultPartitionAlerts.length > 0) {
      console.error(
        `db:maintenance:run: non-zero default-partition rows detected: ${JSON.stringify(result.defaultPartitionAlerts)}`,
      );
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
