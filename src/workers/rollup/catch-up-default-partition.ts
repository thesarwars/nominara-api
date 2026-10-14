import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { PARTITIONED_FACT_TABLES, type PartitionedFactTable } from "../../db/conventions.js";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import { MAINTENANCE_LOCK_KEY, catchUpDefaultPartition, withAdvisoryLock } from "./maintenance.js";

// STORY-142 — `catchUpDefaultPartition`, reachable by an operator and by nobody
// else.
//
// ⚠ OPERATOR-ONLY ON PURPOSE, AND NOT SCHEDULED. The remedy for rows stranded
// in a `_default` partition is to DELETE them from default, create the month's
// partition and re-INSERT, in one transaction, under an ACCESS EXCLUSIVE-class
// lock on the default partition. That is a decision about a live table (when,
// which table, whether the stranded rows are expected), not a chore. The daily
// tick (`maintenance-partition.handler.ts`) detects and alerts; a human runs
// this. Nothing under `src/lib/queue` may import it — a unit test asserts that.
//
// It takes the SAME advisory lock as the tick and `runMonthlyMaintenance`, so
// it waits for a running tick rather than racing it for the DDL.
//
// The existing ops scripts have no dry-run mode (`db:maintenance:run`,
// `db:maintenance:sweep`), so this follows them: the detection query
// (`db:maintenance:run` prints `defaultPartitionAlerts`) is the preview, and
// the table must be named explicitly — there is no implicit "everything".
//
//   pnpm db:maintenance:catch-up --table answer_captures
//   pnpm db:maintenance:catch-up --all

const USAGE = "usage: pnpm db:maintenance:catch-up (--table <answer_captures|mention_facts|citation_facts> | --all)";

export function parseCatchUpArgs(argv: readonly string[]): PartitionedFactTable[] {
  if (argv.length === 1 && argv[0] === "--all") {
    return [...PARTITIONED_FACT_TABLES];
  }
  if (argv.length === 2 && argv[0] === "--table") {
    const table = PARTITIONED_FACT_TABLES.find((candidate) => candidate === argv[1]);
    if (!table) {
      throw new Error(`unknown table ${JSON.stringify(argv[1])}; ${USAGE}`);
    }
    return [table];
  }
  throw new Error(USAGE);
}

export interface CatchUpResult {
  readonly table: PartitionedFactTable;
  readonly partitions: readonly string[];
}

export async function runCatchUp(client: Client, tables: readonly PartitionedFactTable[]): Promise<CatchUpResult[]> {
  return withAdvisoryLock(client, MAINTENANCE_LOCK_KEY, async () => {
    const results: CatchUpResult[] = [];
    for (const table of tables) {
      results.push({ table, partitions: await catchUpDefaultPartition(client, table) });
    }
    return results;
  });
}

async function main(): Promise<void> {
  let tables: PartitionedFactTable[];
  try {
    tables = parseCatchUpArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 2;
    return;
  }
  const client = await connect(requireDatabaseUrl());
  try {
    console.log(JSON.stringify(await runCatchUp(client, tables), null, 2));
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
