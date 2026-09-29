import { fileURLToPath } from "node:url";
import type { Client as PgClient, ClientBase } from "pg";
import { connect, requireDatabaseUrl } from "./client.js";
import { createPgPool } from "./pg-pool.js";
import { PARTITIONED_FACT_TABLES } from "./conventions.js";
import { describeTarget } from "./local-target.js";
import { ensurePartitionsForTable } from "../workers/rollup/maintenance.js";
import { DemoSeedRefusedError, assertDemoSeedAllowed } from "./seed/demo/guard.js";
import { ensureDemoProjects, listActiveProjects } from "./seed/demo/projects.js";
import { seedOneProject } from "./seed/demo/seed-project.js";
import { listSeededProjects, purgeOneProject } from "./seed/demo/purge.js";
import { ensureDemoWallet } from "./seed/demo/wallet.js";
import { SYSTEM_ACTOR_ID } from "../tenancy/constants.js";
import { withTenantContext } from "../tenancy/tenant-context.js";

// STORY-169 — `pnpm db:seed-demo`. Dev-only. See `assertDemoSeedAllowed`
// (src/db/seed/demo/guard.ts) for the refusal this runs behind, and
// `api/docs/demo-seed.md` for usage.
//
// Usage:
//   NOMINARA_DEMO_SEED=1 pnpm db:seed-demo --workspace <uuid>
//   NOMINARA_DEMO_SEED=1 pnpm db:seed-demo --workspace <uuid> --purge
//
// `--workspace` is required unless the database has EXACTLY one workspace.
//
// Two connections, never crossed (map.txt's own recommendation, matching
// this codebase's existing operator scripts):
//   DATABASE_URL         — the OWNER connection. Used ONLY to list projects
//                           for workspace resolution and to create fact-table
//                           partitions (`ensurePartitionsForTable`, never a
//                           raw `CREATE TABLE ... PARTITION OF`).
//   DATABASE_URL_POOLED  — `nominara_app`, through pgBouncer. EVERY tenant
//                           write and the rollup itself go through here,
//                           inside `withTenantContext`, so RLS is the real
//                           boundary rather than a convention on the owner
//                           connection.

export class SeedDemoUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedDemoUsageError";
  }
}

export interface SeedDemoArgs {
  readonly workspaceId: string | undefined;
  readonly purge: boolean;
}

export function parseSeedDemoArgs(argv: readonly string[]): SeedDemoArgs {
  let workspaceId: string | undefined;
  let purge = false;
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--purge") {
      purge = true;
      continue;
    }
    if (token === "--workspace") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new SeedDemoUsageError("--workspace needs a value");
      }
      workspaceId = value;
      i += 1;
      continue;
    }
    throw new SeedDemoUsageError(`unknown argument: ${token}`);
  }
  return { workspaceId, purge };
}

async function resolveWorkspaceId(ownerClient: PgClient, argWorkspaceId: string | undefined): Promise<string> {
  if (argWorkspaceId !== undefined) return argWorkspaceId;
  const result = await ownerClient.query<{ id: string }>(`SELECT id FROM workspaces WHERE deleted_at IS NULL ORDER BY created_at`);
  if (result.rows.length === 1) return result.rows[0]!.id;
  throw new SeedDemoUsageError(
    `--workspace is required unless exactly one workspace exists (found ${String(result.rows.length)})`,
  );
}

/** `YYYY-MM-DD` arithmetic in UTC, matching `denormalizeProject`'s own `shiftDate` (never an interpolated ISO string — ISO-13). */
function shiftDate(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

function monthsBetween(earlier: string, later: string): number {
  const [ey, em] = earlier.split("-").map(Number) as [number, number];
  const [ly, lm] = later.split("-").map(Number) as [number, number];
  return (ly * 12 + lm) - (ey * 12 + em);
}

const WINDOW_DAYS = 60;

/**
 * The minimal shape `runSeedDemo` needs from a pool — `pg.Pool` satisfies
 * this structurally, and so does a test's own fixture connection wrapper,
 * without either needing to implement the rest of `pg.Pool`'s surface.
 */
export interface SeedDemoPoolClient extends ClientBase {
  release(): void;
}
export interface SeedDemoPool {
  connect(): Promise<SeedDemoPoolClient>;
  end(): Promise<void>;
}

export interface SeedDemoDeps {
  readonly ownerClient: PgClient;
  readonly pool: SeedDemoPool;
  readonly log: (line: string) => void;
}

/**
 * ⚠ REVIEW FIX — `assertDemoSeedAllowed` checks only hostnames and the
 * opt-in; it has no idea which Postgres ROLE `DATABASE_URL_POOLED`
 * actually authenticates as. If it happens to name the migration owner or
 * the superuser (easy when a developer exports connection strings by
 * hand), every write this seed makes runs with RLS BYPASSED — "RLS is the
 * real boundary, not a convention on the owner connection" (this file's
 * own header) stops being true for every tenant write the seed makes, and
 * nothing would report it. `test/isolation/assertions/iso-00-anti-
 * vacuity.ts` refuses a superuser/bypassrls connection for the identical
 * reason before trusting anything else it asserts; this is the same check,
 * run as the FIRST statement inside the ambient tenant transaction, before
 * any tenant write.
 */
async function assertPooledConnectionIsRuntimeApp(tx: ClientBase): Promise<void> {
  const result = await tx.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
    `SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DemoSeedRefusedError(
      "refusing to seed demo data: could not resolve a pg_roles row for DATABASE_URL_POOLED's connected role.",
    );
  }
  if (row.rolname !== "nominara_app" || row.rolsuper || row.rolbypassrls) {
    // Each ternary's OWN colon is kept OUT of a template literal that opens
    // with an interpolation — ISO-13's cache-key scanner (test/isolation/
    // assertions/iso-13-cache-namespace.ts) flags a literal opening with an
    // interpolation and carrying two colons as an un-namespaced cache key
    // construction site, and it cannot tell a ternary's colon from a
    // key-segment separator by regex alone; the scanner reads raw source,
    // so even a code example in a COMMENT can trip it. Two plain variables,
    // assigned outside any template literal, keep the message unchanged
    // while staying off that pattern — the same avoidance
    // `denormalizeProject`'s `shiftDate` documents.
    const superuserNote = row.rolsuper ? " (SUPERUSER)" : "";
    const bypassrlsNote = row.rolbypassrls ? " (BYPASSRLS)" : "";
    throw new DemoSeedRefusedError(
      `refusing to seed demo data: DATABASE_URL_POOLED is authenticated as "${row.rolname}"` +
        `${superuserNote}${bypassrlsNote}, not nominara_app with RLS in ` +
        "force. Every tenant write this seed makes must run through the real runtime role, or RLS is not actually " +
        "the boundary protecting other workspaces from it.",
    );
  }
}

/**
 * Test-only tuning of the fact-generation volume. Omitted (as the real CLI
 * always omits it), the spec defaults apply — `windowDays: 60`,
 * `promptsPerProject: 8`. A test exercising the full end-to-end flow
 * (project creation, partitions, wallet, every producer) needs a much
 * smaller volume to stay fast without changing WHAT is being proven.
 */
export interface SeedDemoOptions {
  readonly windowDays?: number;
  readonly promptsPerProject?: number;
}

export async function runSeedDemo(args: SeedDemoArgs, deps: SeedDemoDeps, options: SeedDemoOptions = {}): Promise<void> {
  const { ownerClient, pool, log } = deps;
  const windowDays = options.windowDays ?? WINDOW_DAYS;
  const workspaceId = await resolveWorkspaceId(ownerClient, args.workspaceId);

  const workspaceRow = await ownerClient.query<{ timezone: string }>(
    `SELECT timezone FROM workspaces WHERE id = $1 AND deleted_at IS NULL`,
    [workspaceId],
  );
  const timezone = workspaceRow.rows[0]?.timezone;
  if (timezone === undefined) {
    throw new SeedDemoUsageError(`workspace ${workspaceId} does not exist`);
  }

  if (args.purge) {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await assertPooledConnectionIsRuntimeApp(tx);
        const seeded = await listSeededProjects(tx, workspaceId);
        for (const project of seeded) {
          await purgeOneProject(tx, project, timezone);
          log(`purged demo data for project ${project.id}${project.seedCreated ? " (project deleted — it was seed-created)" : ""}`);
        }
        log(`--purge complete: ${String(seeded.length)} project(s) restored to their pre-seed state.`);
        log("The wallet and credit_ledger were NOT touched — credit_ledger is append-only and this seed never reverses a grant.");
      });
    } finally {
      client.release();
    }
    return;
  }

  // Partitions — the OWNER connection, outside any tenant transaction, before
  // any tenant write. `ensureAllPartitions`'s forward-looking default only
  // covers the current month plus PARTITION_LEAD_MONTHS ahead; a 60-day
  // BACKFILL needs the months behind today too, so this computes its own
  // reference date and month count rather than reusing that default.
  const todayRow = await ownerClient.query<{ today: string }>(
    `SELECT to_char((now() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`,
    [timezone],
  );
  const today = todayRow.rows[0]!.today;
  const earliestDay = shiftDate(today, -(windowDays - 1));
  const monthsAhead = monthsBetween(earliestDay, today);
  const [earliestYear, earliestMonth] = earliestDay.split("-").map(Number) as [number, number];
  const referenceDate = new Date(Date.UTC(earliestYear, earliestMonth - 1, 1));

  for (const table of PARTITIONED_FACT_TABLES) {
    const created = await ensurePartitionsForTable(ownerClient, table, referenceDate, monthsAhead);
    if (created.length > 0) {
      log(`created partition(s) for ${table}: ${created.join(", ")}`);
    }
  }

  const client = await pool.connect();
  try {
    const summary = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      await assertPooledConnectionIsRuntimeApp(tx);
      const createdProjects = await ensureDemoProjects(tx, workspaceId);
      for (const created of createdProjects) {
        log(`created demo project "${created.name}" (${created.rootDomain})`);
      }

      const targets = await listActiveProjects(tx, workspaceId);
      const results = [];
      for (const project of targets) {
        const result = await seedOneProject(tx, project, timezone, {
          windowDays,
          ...(options.promptsPerProject === undefined ? {} : { promptsPerProject: options.promptsPerProject }),
        });
        results.push(result);
        log(
          `seeded ${project.name}: ${String(result.days)} days, ${String(result.engines)} engine(s), ` +
            `${String(result.findings)} AUX finding(s), ${String(result.criticalOrHighSources)} critical/high source gap(s)`,
        );
      }

      const wallet = await ensureDemoWallet(tx, workspaceId);
      if (!wallet.provisioned) {
        log("workspace already has a wallet — left untouched.");
      } else if (wallet.grant > 0) {
        log(
          `provisioned a wallet with a ${String(wallet.grant)}-credit grant — THIS IS NOT REVERSIBLE, ` +
            "credit_ledger is append-only and --purge never touches it.",
        );
      } else {
        // STORY-169 review — a grant of 0 writes NO credit_ledger entry
        // (provisionWalletWithGrant's own early return), so "not
        // reversible" would be false here: nothing append-only was written.
        // The wallet ROW itself was still just created, though, which
        // `ensureDemoWallet`'s own header says this log line must not
        // claim is "left untouched".
        log(`provisioned a wallet with a 0-credit grant (this plan publishes none) — a bare wallet row, no ledger entry.`);
      }

      return results;
    });

    log(`done: ${String(summary.length)} project(s) seeded for workspace ${workspaceId}.`);
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  const args = parseSeedDemoArgs(process.argv.slice(2));

  assertDemoSeedAllowed({
    nodeEnv: process.env.NODE_ENV,
    databaseUrl: process.env.DATABASE_URL,
    databaseUrlPooled: process.env.DATABASE_URL_POOLED,
    optIn: process.env.NOMINARA_DEMO_SEED,
  });

  // `assertDemoSeedAllowed`'s local-host check is BY NAME ONLY
  // (`local-target.ts`'s own header) — it cannot tell a real local Postgres
  // apart from a `localhost` port-forward to a remote one (a Cloud SQL Auth
  // Proxy, `kubectl port-forward`, `ssh -L`). Printing the RESOLVED
  // host/port/database before writing a single row is the mitigation: an
  // operator not expecting the database on the other end of a tunnel sees
  // it named here, before any write.
  process.stdout.write(`DATABASE_URL resolves to ${describeTarget(process.env.DATABASE_URL ?? "")}\n`);
  process.stdout.write(`DATABASE_URL_POOLED resolves to ${describeTarget(process.env.DATABASE_URL_POOLED ?? "")}\n`);

  const ownerClient = await connect(requireDatabaseUrl());
  const pool = createPgPool(process.env.DATABASE_URL_POOLED!);
  try {
    await runSeedDemo(args, { ownerClient, pool, log: (line) => process.stdout.write(`${line}\n`) });
  } finally {
    await ownerClient.end();
    await pool.end();
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
