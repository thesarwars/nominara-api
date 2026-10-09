import type { ClientBase } from "pg";

// STORY-169 — a small multi-row INSERT builder, shared by the demo seed's
// fact writers.
//
// ⚠ BOUNDED BATCH SIZE, deliberately. `catchUpDefaultPartition`
// (src/workers/rollup/maintenance.ts) already documents the trap: Postgres's
// bind-parameter limit is 65535, and one multi-row INSERT built from
// thousands of wide rows can exceed it. `insertRows` below chunks the ROWS,
// never assembles one unbounded statement, and each chunk's parameter count
// is `columns.length * chunkSize`, well under the limit for every caller in
// this seed.
const MAX_PARAMS_PER_STATEMENT = 8000;

/**
 * Insert `rows` into `table` (a literal from this module's own small,
 * hardcoded call sites — never a caller-supplied string) across `columns`,
 * batching into chunks that stay under the bind-parameter limit.
 *
 * `casts` names an explicit `::type` for any column whose bound value is
 * otherwise ambiguous to Postgres — a jsonb column bound to a plain string
 * parameter, for instance. Every other column position is a bare `$n`,
 * resolved against its target column's type the same way the rest of this
 * codebase's parameterized INSERTs already rely on.
 */
export async function insertRows(
  tx: ClientBase,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[],
  casts: Readonly<Record<string, string>> = {},
): Promise<void> {
  if (rows.length === 0) return;

  const rowsPerChunk = Math.max(1, Math.floor(MAX_PARAMS_PER_STATEMENT / columns.length));
  const columnList = columns.join(", ");

  for (let start = 0; start < rows.length; start += rowsPerChunk) {
    const chunk = rows.slice(start, start + rowsPerChunk);
    const params: unknown[] = [];
    const valueGroups = chunk.map((row) => {
      const placeholders = row.map((value, columnIndex) => {
        params.push(value);
        const cast = casts[columns[columnIndex]!];
        return cast === undefined ? `$${String(params.length)}` : `$${String(params.length)}::${cast}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    await tx.query(`INSERT INTO ${table} (${columnList}) VALUES ${valueGroups.join(", ")}`, params);
  }
}
