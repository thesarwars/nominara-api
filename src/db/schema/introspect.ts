import type { Client } from "pg";

// STORY-122 — what the migrated database actually contains, read from the
// database rather than from the migration SQL. src/db/rls/introspect.ts asks
// the same census question ("base tables in public, never a partition
// child") and deliberately uses the same predicate, so the two can never
// disagree about which tables exist; this one additionally needs types,
// nullability, defaults and primary keys, which the RLS generator does not.

export interface IntrospectedColumn {
  readonly name: string;
  /** `format_type` output — "text", "text[]", "numeric(6,3)", "halfvec(1536)", "character(2)". */
  readonly sqlType: string;
  readonly notNull: boolean;
  /** The raw default expression, or null. Carried verbatim so the generated column is optional on insert exactly when the database says it is. */
  readonly defaultExpr: string | null;
}

export interface IntrospectedTable {
  readonly name: string;
  readonly columns: readonly IntrospectedColumn[];
  /** In constraint order, which is not necessarily column order. */
  readonly primaryKey: readonly string[];
}

const COLUMNS_SQL = `
  SELECT c.relname                                AS table_name,
         a.attname                                AS column_name,
         format_type(a.atttypid, a.atttypmod)     AS sql_type,
         a.attnotnull                             AS not_null,
         pg_get_expr(d.adbin, d.adrelid)          AS default_expr
    FROM pg_attribute a
    JOIN pg_class     c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE n.nspname = 'public'
     AND c.relkind IN ('r', 'p')
     AND NOT c.relispartition
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY c.relname, a.attnum
`;

const PRIMARY_KEYS_SQL = `
  SELECT c.relname AS table_name,
         a.attname AS column_name,
         k.ord     AS position
    FROM pg_constraint con
    JOIN pg_class     c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
   WHERE con.contype = 'p'
     AND n.nspname = 'public'
     AND NOT c.relispartition
   ORDER BY c.relname, k.ord
`;

export async function introspectSchema(client: Client): Promise<IntrospectedTable[]> {
  const columns = await client.query<{
    table_name: string;
    column_name: string;
    sql_type: string;
    not_null: boolean;
    default_expr: string | null;
  }>(COLUMNS_SQL);

  const primaryKeys = await client.query<{ table_name: string; column_name: string }>(PRIMARY_KEYS_SQL);

  const byTable = new Map<string, { columns: IntrospectedColumn[]; primaryKey: string[] }>();
  for (const row of columns.rows) {
    let entry = byTable.get(row.table_name);
    if (!entry) {
      entry = { columns: [], primaryKey: [] };
      byTable.set(row.table_name, entry);
    }
    entry.columns.push({
      name: row.column_name,
      sqlType: row.sql_type,
      notNull: row.not_null,
      defaultExpr: row.default_expr,
    });
  }
  for (const row of primaryKeys.rows) {
    byTable.get(row.table_name)?.primaryKey.push(row.column_name);
  }

  return [...byTable.entries()]
    .map(([name, entry]) => ({ name, columns: entry.columns, primaryKey: entry.primaryKey }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
