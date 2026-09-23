import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-152 — ISO-23. Every plain view in `public` carries
// `security_invoker = true`.
//
// ⚠ THE SIBLING OF ISO-16, AND THE SAME HAZARD. ISO-16 forbids MATERIALIZED
// views because one bypasses RLS on its base tables. A plain view created
// without `security_invoker` does the identical thing: PostgreSQL's default is
// to execute a view's query as its OWNER, and the owner here is the migration
// role, which is not subject to the tenant policies.
//
// A plain view is permitted where a matview is not, because it holds no stored
// copy to go stale — but the permission is conditional on this one reloption,
// and `ALTER VIEW ... SET (security_invoker = false)` removes it in one
// statement with no other visible effect.
//
// ⚠ AND THE REST OF THE SUITE CANNOT SEE IT. `test/isolation/support/
// discovery.ts` filters `relkind IN ('r','p')`, as does `CENSUS_TABLES_SQL`
// in src/db/rls/introspect.ts, so every other assertion here is structurally
// blind to views. STORY-152 added the first one (`project_entitled_engines`),
// and its review demonstrated a live cross-tenant read through a view that
// `db:rls-check` reported as clean.
//
// `src/db/rls/rls-check.ts` grew a matching bucket in the same commit. This
// assertion is not redundant with it: rls-check.spec.ts builds its fixture
// from a hand-picked SUBSET of migrations that does not include 0027, so this
// suite — which migrates everything — is the only place the real view is
// checked.
export async function assertIso23ViewsSecurityInvoker(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    // Extension-owned views are excluded BY DEPENDENCY, not by name:
    // pg_stat_statements installs two views into `public` that read shared
    // memory rather than our tables. An allow-list of their names would admit
    // the next extension's views silently.
    // ⚠ EVERY NON-SYSTEM SCHEMA, NOT JUST `public`. The first version scoped
    // to public, and its empty-collection guard could not protect that choice:
    // `project_entitled_engines` guarantees public is never empty, so the
    // guard fires only if the RELKIND filter drifts, never if the SCHEMA does.
    // A view created in `app` — where this codebase already puts functions —
    // would have been invisible while the guard reported everything healthy.
    const views = await client.query<{ nspname: string; relname: string; reloptions: string[] | null }>(
      `SELECT n.nspname, c.relname, c.reloptions
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind = 'v'
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%'
          AND n.nspname NOT LIKE 'pg_temp%'
          AND NOT EXISTS (
            SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
          )`,
    );

    // ⚠ THE EMPTY-COLLECTION TRAP, WHICH THIS SUITE FORBIDS EXPLICITLY. If the
    // query returned nothing the loop below would pass forever — and it would
    // return nothing the moment the relkind filter or the schema name drifted.
    // STORY-152 shipped `project_entitled_engines`, so there is at least one.
    if (views.rowCount === 0) {
      throw new Error(
        "ISO-23: zero views found in any non-system schema — expected at least public.project_entitled_engines. " +
          "A view census that matches nothing cannot fail, so this is a broken assertion, not a clean schema.",
      );
    }
    // And the guard names the view it expects, so a census that drifts to some
    // OTHER schema and happens to find something there still fails.
    if (!views.rows.some((row) => row.nspname === "public" && row.relname === "project_entitled_engines")) {
      throw new Error(
        "ISO-23: public.project_entitled_engines was not in the census — the scope has drifted, " +
          `saw: ${views.rows.map((r) => `${r.nspname}.${r.relname}`).join(", ")}`,
      );
    }

    // Parsed rather than string-matched: `WITH (security_invoker = on)` and
    // `WITH (security_invoker)` are both correct and store `on` and `true`.
    const enabled = (reloptions: string[] | null): boolean => {
      for (const option of reloptions ?? []) {
        const [name, value] = option.split("=", 2);
        if (name?.trim() !== "security_invoker") continue;
        return ["true", "on", "1", "yes"].includes((value ?? "true").trim().toLowerCase());
      }
      return false;
    };

    const offenders = views.rows
      .filter((row) => !enabled(row.reloptions))
      .map((row) => `${row.nspname}.${row.relname} (reloptions=${(row.reloptions ?? []).join(",") || "unset"})`);

    if (offenders.length > 0) {
      throw new Error(
        `ISO-23: view(s) without security_invoker=true, which execute as their OWNER and bypass RLS: ${offenders.join(", ")}`,
      );
    }
  } finally {
    await client.end();
  }
}

export const iso23Breaker: Breaker = {
  id: "ISO-23",
  description: "creates a view over a tenant table without security_invoker, bypassing its RLS",
  apply: async (client) => {
    await client.query("CREATE VIEW iso23_probe_view AS SELECT id, workspace_id FROM competitors");
  },
  revert: NOOP_REVERT,
};
