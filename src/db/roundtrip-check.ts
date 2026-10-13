import { access, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { connect, requireDatabaseUrl } from "./client.js";
import { MIGRATIONS_DIR, listMigrationFiles, migrateUp, rollbackAll, rollbackLast } from "./migrate-runner.js";

// STORY-006 AC 7 — "Every migration is applied forward and rolled back in CI
// on a shadow database. A rollback that has never executed is not a rollback
// plan."
//
// Until this existed each DDL story rolled back ITS OWN migration in its own
// spec, so a down.sql added later, or edited later, ran nowhere. This walks the
// whole committed set in one throwaway database, ONE PAIR AT A TIME:
//
//   for each migration, in order:
//     snapshot the schema            (S before)
//     apply its up
//     snapshot                       (S up)
//     roll back its down
//     snapshot                       (S after)   must equal S before
//     apply its up again
//     snapshot                       (S again)   must equal S up
//
// then roll the whole chain back and assert nothing is left.
//
// ⚠ WHY PER PAIR, NOT "ROLL EVERYTHING BACK AND LOOK". A chain-wide rollback
// ends at an empty database, and an empty database hides a down that does
// nothing: `ALTER TABLE t ADD COLUMN c` with a no-op down still ends empty,
// because an earlier migration's down drops `t` whole. The mutation that
// proved this replaced a real down with `SELECT 1;` and the chain-wide check
// stayed green. Only comparing the schema against the state BEFORE each up
// can see that the down did its own job.
//
// ⚠ NON-VACUOUS BY CONSTRUCTION. Zero migrations found is a FAILURE, not a
// pass: an empty or mis-pointed directory would otherwise report a green round
// trip over nothing. The same goes for a migration with no .down.sql.
//
// Roles are cluster-level objects and are deliberately outside the snapshot:
// no per-database rollback can remove them, and 0005 creates them
// idempotently. Their GRANTS (relation and function ACLs) are inside it.

export interface RoundTripResult {
  migrationCount: number;
  problems: string[];
}

const SYSTEM_SCHEMAS = ["pg_catalog", "information_schema", "pg_toast"];

/** Every relation, function and type that lives outside the system schemas and the migration ledger. */
async function residue(client: Client): Promise<string[]> {
  const found: string[] = [];
  const relations = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || c.relname AS name
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> ALL($1::text[]) AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
        AND n.nspname <> '_migrations' AND c.relkind IN ('r','p','v','m','S','f')
      ORDER BY 1`,
    [SYSTEM_SCHEMAS],
  );
  found.push(...relations.rows.map((row) => `relation ${row.name}`));

  // Extension-owned functions and types are not residue of a migration; they
  // belong to the extension, and 0001's down drops the extension itself.
  const functions = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || p.proname AS name
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname <> ALL($1::text[]) AND n.nspname <> '_migrations'
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`,
    [SYSTEM_SCHEMAS],
  );
  found.push(...functions.rows.map((row) => `function ${row.name}`));

  const types = await client.query<{ name: string }>(
    `SELECT n.nspname || '.' || t.typname AS name
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname <> ALL($1::text[]) AND n.nspname <> '_migrations'
        AND t.typtype IN ('d','e','r','m')
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
      ORDER BY 1`,
    [SYSTEM_SCHEMAS],
  );
  found.push(...types.rows.map((row) => `type ${row.name}`));

  const schemas = await client.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname = 'app'",
  );
  found.push(...schemas.rows.map((row) => `schema ${row.nspname}`));

  const extensions = await client.query<{ extname: string }>("SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1");
  found.push(...extensions.rows.map((row) => `extension ${row.extname}`));
  return found;
}

/**
 * A canonical, order-independent text description of everything a migration
 * can change in this database: schemas, relations (with kind, options, ACL,
 * RLS flags, partition bound), columns, constraints, indexes, triggers,
 * policies, functions, views, sequences, types, extensions and default
 * privileges. Extension-owned objects are excluded (the extension itself is
 * listed). The migration ledger is excluded.
 *
 * Two NORMALISATIONS, each because the two sides are the same schema:
 *  - An ACL equal to the object's default (owner holds everything) is the
 *    same as no ACL. GRANT then REVOKE leaves an explicit owner-only array
 *    where a never-granted object has NULL; 0005's down does exactly that and
 *    removes every privilege it granted.
 *  - `NOT VALID` is dropped from constraint definitions. Validation attests
 *    to existing rows; the constraint is enforced for new writes either way,
 *    and PostgreSQL cannot un-validate one. 0031 and 0035 are validate-only
 *    migrations whose down is a documented no-op for that reason. A down that
 *    fails to DROP or re-add a constraint is still caught: presence and
 *    definition are compared.
 */
export async function snapshotSchema(client: Client): Promise<string[]> {
  const lines: string[] = [];
  const add = async (kind: string, sql: string): Promise<void> => {
    const result = await client.query<{ line: string }>(sql, [SYSTEM_SCHEMAS]);
    for (const row of result.rows) lines.push(`${kind} ${row.line}`);
  };
  const notSystem = "n.nspname <> ALL($1::text[]) AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%' AND n.nspname <> '_migrations'";
  const notExtOwned = (alias: string, catalog: string) =>
    `NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = '${catalog}'::regclass AND d.objid = ${alias}.oid AND d.deptype = 'e')`;

  await add(
    "schema",
    `SELECT n.nspname || ' owner=' || pg_get_userbyid(n.nspowner) || ' acl=' || coalesce(CASE WHEN n.nspacl = acldefault('n', n.nspowner) THEN NULL ELSE n.nspacl::text END, '') AS line
       FROM pg_namespace n WHERE ${notSystem} AND ${notExtOwned("n", "pg_namespace")}`,
  );
  await add(
    "relation",
    `SELECT n.nspname || '.' || c.relname || ' kind=' || c.relkind::text || ' owner=' || pg_get_userbyid(c.relowner)
            || ' acl=' || coalesce(CASE WHEN c.relacl = acldefault(CASE c.relkind WHEN 'S' THEN 's'::"char" ELSE 'r'::"char" END, c.relowner) THEN NULL ELSE c.relacl::text END, '') || ' opts=' || coalesce(c.reloptions::text, '')
            || ' rls=' || c.relrowsecurity || '/' || c.relforcerowsecurity
            || ' bound=' || coalesce(pg_get_expr(c.relpartbound, c.oid), '') AS line
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${notSystem} AND ${notExtOwned("c", "pg_class")} AND c.relkind IN ('r','p','v','m','S','f')`,
  );
  await add(
    "column",
    `SELECT n.nspname || '.' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
            || ' notnull=' || a.attnotnull || ' default=' || coalesce(pg_get_expr(ad.adbin, ad.adrelid), '')
            || ' generated=' || a.attgenerated::text || ' identity=' || a.attidentity::text
            || ' acl=' || coalesce(a.attacl::text, '') AS line
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
      WHERE ${notSystem} AND ${notExtOwned("c", "pg_class")} AND c.relkind IN ('r','p','v','m','f')
        AND a.attnum > 0 AND NOT a.attisdropped`,
  );
  await add(
    "constraint",
    `SELECT n.nspname || '.' || coalesce(c.relname, '(domain)') || ' ' || k.conname || ' ' || regexp_replace(pg_get_constraintdef(k.oid), ' NOT VALID$', '') AS line
       FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
       LEFT JOIN pg_class c ON c.oid = k.conrelid
      WHERE ${notSystem}`,
  );
  await add(
    "index",
    `SELECT n.nspname || ' ' || pg_get_indexdef(i.indexrelid) AS line
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${notSystem} AND ${notExtOwned("c", "pg_class")}`,
  );
  await add(
    "trigger",
    `SELECT n.nspname || '.' || c.relname || ' ' || pg_get_triggerdef(t.oid) AS line
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT t.tgisinternal AND ${notSystem} AND ${notExtOwned("c", "pg_class")}`,
  );
  await add(
    "policy",
    `SELECT schemaname || '.' || tablename || ' ' || policyname || ' permissive=' || permissive || ' roles=' || roles::text
            || ' cmd=' || cmd || ' using=' || coalesce(qual, '') || ' check=' || coalesce(with_check, '') AS line
       FROM pg_policies WHERE schemaname <> ALL($1::text[])`,
  );
  await add(
    "function",
    `SELECT n.nspname || '.' || p.proname || ' owner=' || pg_get_userbyid(p.proowner) || ' acl=' || coalesce(CASE WHEN p.proacl = acldefault('f', p.proowner) THEN NULL ELSE p.proacl::text END, '')
            || ' ' || pg_get_functiondef(p.oid) AS line
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${notSystem} AND p.prokind IN ('f','p') AND ${notExtOwned("p", "pg_proc")}`,
  );
  await add(
    "view",
    `SELECT n.nspname || '.' || c.relname || ' ' || pg_get_viewdef(c.oid) AS line
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${notSystem} AND c.relkind IN ('v','m') AND ${notExtOwned("c", "pg_class")}`,
  );
  await add(
    "sequence",
    `SELECT n.nspname || '.' || c.relname || ' ' || format_type(s.seqtypid, NULL) || ' inc=' || s.seqincrement
            || ' min=' || s.seqmin || ' max=' || s.seqmax || ' cycle=' || s.seqcycle AS line
       FROM pg_sequence s JOIN pg_class c ON c.oid = s.seqrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${notSystem} AND ${notExtOwned("c", "pg_class")}`,
  );
  await add(
    "type",
    `SELECT n.nspname || '.' || t.typname || ' kind=' || t.typtype::text AS line
       FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE ${notSystem} AND t.typtype IN ('d','e','r','m') AND ${notExtOwned("t", "pg_type")}`,
  );
  await add("extension", "SELECT extname AS line FROM pg_extension WHERE extname <> 'plpgsql' AND $1::text[] IS NOT NULL");
  await add(
    "default-privilege",
    "SELECT pg_get_userbyid(defaclrole) || ' ' || defaclobjtype::text || ' ' || defaclacl::text AS line FROM pg_default_acl WHERE $1::text[] IS NOT NULL",
  );
  return lines.sort();
}

function diffSnapshots(before: readonly string[], after: readonly string[]): string {
  const b = new Set(before);
  const a = new Set(after);
  const removed = before.filter((line) => !a.has(line));
  const added = after.filter((line) => !b.has(line));
  const clip = (line: string) => (line.length > 160 ? `${line.slice(0, 160)}…` : line);
  return [...removed.slice(0, 5).map((l) => `- ${clip(l)}`), ...added.slice(0, 5).map((l) => `+ ${clip(l)}`)].join(" | ");
}

// Messages open with the word "migration", never with an interpolation followed
// by a colon: test/isolation's ISO-13 scanner reads a template literal opening
// `${x}:` as a cache-key construction site.
async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the round trip against `client`'s database and returns every problem
 * found. `client` must point at a disposable, EMPTY shadow database — this
 * function neither creates nor drops one.
 */
export async function checkRoundTrip(client: Client, migrationsDir: string = MIGRATIONS_DIR): Promise<RoundTripResult> {
  const files = await listMigrationFiles(migrationsDir);
  const problems: string[] = [];

  if (files.length === 0) {
    return { migrationCount: 0, problems: [`no migrations found in ${migrationsDir} — a round trip over nothing proves nothing`] };
  }

  for (const file of files) {
    if (!(await exists(file.downPath))) {
      problems.push(`migration ${file.name} — no ${file.name}.down.sql — a migration without a rollback is not reversible`);
    }
  }
  if (problems.length > 0) {
    return { migrationCount: files.length, problems };
  }

  // Each pair is applied through the real runner (so the additive-only and
  // matview guards stay in force) from a directory that grows by one
  // migration at a time: migrateUp applies exactly the newest, rollbackLast
  // rolls back exactly the newest.
  const stepDir = await mkdtemp(path.join(tmpdir(), "nominara-roundtrip-"));
  const fail = (message: string): RoundTripResult => ({ migrationCount: files.length, problems: [...problems, message] });
  try {
    for (const file of files) {
      await copyFile(file.upPath, path.join(stepDir, `${file.name}.up.sql`));
      await copyFile(file.downPath, path.join(stepDir, `${file.name}.down.sql`));

      const before = await snapshotSchema(client);
      try {
        const applied = await migrateUp(client, stepDir);
        if (applied.length !== 1 || applied[0] !== file.name) {
          return fail(`migration ${file.name} — forward apply recorded [${applied.join(", ")}], expected exactly [${file.name}]`);
        }
      } catch (error) {
        return fail(`migration ${file.name} — forward apply failed: ${(error as Error).message}`);
      }
      const afterUp = await snapshotSchema(client);

      try {
        const rolledBack = await rollbackLast(client, stepDir);
        if (rolledBack !== file.name) {
          return fail(`migration ${file.name} — rollback recorded ${rolledBack ?? "nothing"}, expected ${file.name}`);
        }
      } catch (error) {
        return fail(`migration ${file.name} — rollback failed: ${(error as Error).message}`);
      }
      const afterDown = await snapshotSchema(client);
      if (afterDown.join("\n") !== before.join("\n")) {
        problems.push(`migration ${file.name} — its down does not restore the schema it found — ${diffSnapshots(before, afterDown)}`);
      }

      try {
        await migrateUp(client, stepDir);
      } catch (error) {
        return fail(`migration ${file.name} — re-apply after rollback failed: ${(error as Error).message}`);
      }
      const afterAgain = await snapshotSchema(client);
      if (afterAgain.join("\n") !== afterUp.join("\n")) {
        problems.push(`migration ${file.name} — re-applying its up after rollback gives a different schema — ${diffSnapshots(afterUp, afterAgain)}`);
      }
    }

    // And the whole chain back to nothing.
    try {
      await rollbackAll(client, stepDir);
    } catch (error) {
      return fail(`rolling the whole chain back failed: ${(error as Error).message}`);
    }
    const left = await residue(client);
    if (left.length > 0) {
      problems.push(`residue after rolling back every migration: ${left.join(", ")}`);
    }
  } finally {
    await rm(stepDir, { recursive: true, force: true });
  }

  return { migrationCount: files.length, problems };
}

async function main(): Promise<void> {
  const maintenanceUrl = requireDatabaseUrl();
  const shadowDbName = `nominara_roundtrip_${Date.now()}`;
  const maintenance = await connect(maintenanceUrl);
  try {
    await maintenance.query(`CREATE DATABASE ${shadowDbName}`);
  } finally {
    await maintenance.end();
  }

  const shadowUrl = new URL(maintenanceUrl);
  shadowUrl.pathname = `/${shadowDbName}`;
  const shadow = await connect(shadowUrl.toString());

  let result: RoundTripResult;
  try {
    result = await checkRoundTrip(shadow);
  } finally {
    await shadow.end();
    const cleanup = await connect(maintenanceUrl);
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${shadowDbName}`);
    } finally {
      await cleanup.end();
    }
  }

  if (result.problems.length > 0) {
    console.error("migration round-trip check failed:");
    for (const problem of result.problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }

  console.log(`migration round-trip check passed: ${result.migrationCount} migration(s) each applied, rolled back to the schema they found, re-applied, then the whole chain rolled back to empty`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
