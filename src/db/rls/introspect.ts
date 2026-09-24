import type { Client } from "pg";
import type { TableDescriptor } from "./generate.js";

// STORY-011. Queries pg_class/information_schema.columns for base tables in
// `public`, matching EXACTLY the census query pattern already used by
// test/integration/rollups-aux-tasks-geo-tools.spec.ts's 69-table census test
// (`relkind IN ('r','p') AND NOT relispartition`) — so the generator's own
// notion of "which tables exist" and that test's notion can never silently
// diverge from one another.
//
// ⚠ `public` HERE IS CORRECT, AND IT IS NOT THE SAME DECISION AS THE ONE
// STORY-152 GOT WRONG TWICE ELSEWHERE.
//
// This census feeds the GENERATOR (`pnpm db:rls-generate`), which emits
// `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY` and `CREATE POLICY ... ON
// <name>` with UNQUALIFIED names. Widening it would make the generator write
// statements that resolve by `search_path` — correct for public and wrong
// for anything else. The generator manages `public`; that is a real boundary,
// not an oversight.
//
// What was missing is the other half of the same sentence: NOTHING said so,
// and nothing reported a table outside `public`. A review planted
// `tenantdata.leaked_captures` and `app.leaked_workspaces` — both carrying
// `workspace_id`, both granted to every runtime role, RLS not even enabled —
// and all eight buckets were empty. `checkRls`'s `unmanagedTables` bucket is
// where that is answered now: this function scopes the generator, and that
// bucket refuses to let anything sit silently outside its scope.
const CENSUS_TABLES_SQL = `
  SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
`;

/**
 * Introspects every base table (not a partition child) in the `public`
 * schema of `client`'s database, along with its column names. Used both by
 * `pnpm db:rls-generate` (against a freshly-migrated shadow database) and by
 * `pnpm db:rls-check`.
 */
export async function introspectTables(client: Client): Promise<TableDescriptor[]> {
  const tablesResult = await client.query<{ table_name: string }>(CENSUS_TABLES_SQL);
  const tableNames = tablesResult.rows.map((row) => row.table_name);

  const columnsResult = await client.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])`,
    [tableNames],
  );

  const columnsByTable = new Map<string, Set<string>>();
  for (const name of tableNames) {
    columnsByTable.set(name, new Set());
  }
  for (const { table_name, column_name } of columnsResult.rows) {
    columnsByTable.get(table_name)?.add(column_name);
  }

  return tableNames.map((name) => ({
    name,
    columns: columnsByTable.get(name) ?? new Set<string>(),
  }));
}
