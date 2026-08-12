import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { assertAdditiveOnly } from "./additive-guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.join(__dirname, "migrations", "sql");

export interface MigrationFile {
  name: string;
  upPath: string;
  downPath: string;
}

// Drizzle-kit's own migrator is forward-only (KAD-16 requires expand/contract
// migrations, but drizzle-kit has no concept of a paired rollback file) — so
// this bookkeeping and runner is hand-rolled specifically to make "roll back
// on a shadow database" (STORY-006 acceptance criteria) an executable thing
// rather than an aspiration. drizzle-kit still owns schema-diff generation
// once STORY-007 introduces the first schema.ts tables.
const BOOTSTRAP_SQL = `
  CREATE SCHEMA IF NOT EXISTS _migrations;
  CREATE TABLE IF NOT EXISTS _migrations.applied (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  );
`;

export async function listMigrationFiles(migrationsDir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDir);
  const names = entries
    .filter((entry) => entry.endsWith(".up.sql"))
    .map((entry) => entry.replace(/\.up\.sql$/, ""))
    .sort();

  return names.map((name) => ({
    name,
    upPath: path.join(migrationsDir, `${name}.up.sql`),
    downPath: path.join(migrationsDir, `${name}.down.sql`),
  }));
}

export async function bootstrap(client: Client): Promise<void> {
  await client.query(BOOTSTRAP_SQL);
}

export async function appliedMigrationNames(client: Client): Promise<Set<string>> {
  // Ordered by name, not applied_at: migration names are zero-padded and
  // sortable, so this ordering is exact and tie-free by construction.
  // applied_at is wall-clock and can tie under fast, back-to-back
  // transactions (observed under testcontainers — see rollbackLast below).
  const result = await client.query<{ name: string }>("SELECT name FROM _migrations.applied ORDER BY name ASC");
  return new Set(result.rows.map((row) => row.name));
}

/** Applies every migration not yet recorded, in filename order. */
export async function migrateUp(client: Client, migrationsDir: string = MIGRATIONS_DIR): Promise<string[]> {
  await bootstrap(client);
  const files = await listMigrationFiles(migrationsDir);
  const applied = await appliedMigrationNames(client);
  const newlyApplied: string[] = [];

  for (const file of files) {
    if (applied.has(file.name)) {
      continue;
    }

    const sql = await readFile(file.upPath, "utf8");
    await assertAdditiveOnly(sql, client);

    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO _migrations.applied (name) VALUES ($1)", [file.name]);
      await client.query("COMMIT");
      newlyApplied.push(file.name);
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`migration ${file.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }

  return newlyApplied;
}

/** Rolls back the most recently applied migration. Returns its name, or null if none are applied. */
export async function rollbackLast(client: Client, migrationsDir: string = MIGRATIONS_DIR): Promise<string | null> {
  await bootstrap(client);
  // ORDER BY name, not applied_at: two migrations applied in quick
  // succession (routine under testcontainers, where a full chain applies in
  // milliseconds) can receive the same transaction-start timestamp,
  // making "most recent" ambiguous under timestamp ordering. Migration
  // names are zero-padded and sort exactly in application order, with no
  // possibility of a tie.
  const result = await client.query<{ name: string }>("SELECT name FROM _migrations.applied ORDER BY name DESC LIMIT 1");
  const last = result.rows[0]?.name;
  if (!last) {
    return null;
  }

  const files = await listMigrationFiles(migrationsDir);
  const file = files.find((f) => f.name === last);
  if (!file) {
    throw new Error(`migration ${last} is recorded as applied but its files are missing`);
  }

  const sql = await readFile(file.downPath, "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("DELETE FROM _migrations.applied WHERE name = $1", [last]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`rollback of ${last} failed: ${(error as Error).message}`, { cause: error });
  }

  return last;
}

/** Rolls back every applied migration, in reverse order, back to empty. */
export async function rollbackAll(client: Client, migrationsDir: string = MIGRATIONS_DIR): Promise<string[]> {
  const rolledBack: string[] = [];
  for (;;) {
    const name = await rollbackLast(client, migrationsDir);
    if (!name) {
      break;
    }
    rolledBack.push(name);
  }
  return rolledBack;
}
