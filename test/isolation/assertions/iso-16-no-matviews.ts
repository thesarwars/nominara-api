import { readFile } from "node:fs/promises";
import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { listMigrationFiles } from "../../../src/db/migrate-runner.js";
import { assertNoMaterializedViews } from "../../../src/db/additive-guard.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-16 / STORY-012 T10 — no materialized view
// exists in the live schema, AND every committed migration file is lint-clean
// (reusing src/db/additive-guard.ts's assertNoMaterializedViews rather than
// re-implementing the pattern — this suite OBSERVES that module, never edits it).
export async function assertIso16NoMaterializedViews(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const result = await client.query<{ matviewname: string }>("SELECT matviewname FROM pg_matviews");
    if (result.rowCount !== 0) {
      throw new Error(`ISO-16: materialized view(s) found: ${result.rows.map((r) => r.matviewname).join(", ")}`);
    }
  } finally {
    await client.end();
  }

  const files = await listMigrationFiles();
  if (files.length === 0) {
    throw new Error("ISO-16: zero committed migration files found — the empty-collection trap forbids this passing vacuously");
  }
  for (const file of files) {
    const sql = await readFile(file.upPath, "utf8");
    assertNoMaterializedViews(sql); // throws if it finds one
  }
}

export const iso16Breaker: Breaker = {
  id: "ISO-16",
  description: "creates a materialized view over a tenant table, bypassing its RLS",
  apply: async (client) => {
    await client.query("CREATE MATERIALIZED VIEW iso16_probe_matview AS SELECT id, workspace_id FROM competitors");
  },
  revert: NOOP_REVERT,
};
