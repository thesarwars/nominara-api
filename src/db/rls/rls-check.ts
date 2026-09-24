import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { GLOBAL_TABLES } from "../conventions.js";
import { connect, requireDatabaseUrl } from "../client.js";
import { MIGRATIONS_DIR, migrateUp } from "../migrate-runner.js";
import {
  computeActorSelfScopedPolicies,
  computeExpectedPolicies,
  generateRlsSql,
  type ExpectedPolicy,
  type TableDescriptor,
} from "./generate.js";
import { introspectTables } from "./introspect.js";

// STORY-011 — `pnpm db:rls-check`, modeled on src/db/drift-check.ts's own
// shadow-DB / main() pattern. AC 32 ("the generator runs in the migration
// pipeline AND in CI") — this is the CI half: it reports FIVE independent
// failure buckets rather than a single pass/fail, so a reviewer immediately
// sees WHICH invariant broke.

export interface RlsCheckResult {
  /** A table in the live schema that generateRlsSql throws on — "a later story added a table and forgot to regenerate". */
  unclassifiedTables: string[];
  /** "<table>: relrowsecurity=<bool> relforcerowsecurity=<bool>" for any tenant table OR partition child missing either flag. */
  missingRls: string[];
  /** "<table>.<policy> [...]" — an expected policy (matching generateRlsSql's own output) not found, normalized, in pg_policies. */
  missingPolicies: string[];
  /** "<table>.<policy> [...]" — a pg_policies row not matching any expected policy, normalized. */
  unexpectedPolicies: string[];
  /** "<table>.<policy>" — a FOR ALL policy anywhere in `public` with a NULL with_check. This story's #1 technical note gets its own bucket. */
  policiesWithoutWithCheck: string[];
  /** "<table>.<policy>" — a policy found on a GLOBAL_TABLES entry (the inverse mistake — GLOBAL_TABLES are GRANT-secured, never RLS). */
  globalTablesWithPolicies: string[];
  /**
   * "<view>: security_invoker=<value>" — a view in `public` that does not
   * carry `security_invoker=true`.
   *
   * ⚠ EVERY OTHER BUCKET IS BLIND TO VIEWS, WHICH IS WHY THIS ONE EXISTS.
   * `CENSUS_TABLES_SQL` selects `relkind IN ('r','p')`, so a view is examined
   * by none of the six above — and a view without `security_invoker` runs as
   * its OWNER, which is the migration role, which bypasses RLS on every base
   * table it reads. Demonstrated rather than assumed: a review of STORY-152
   * created `CREATE VIEW leaky AS SELECT * FROM projects`, granted it to all
   * four runtime roles, and this function returned `isClean: true` while the
   * view returned every tenant's rows to a caller pinned to one workspace.
   *
   * The sibling rule for MATERIALIZED views is ISO-16, which forbids them
   * outright for exactly this reason. A plain view is permitted because it
   * has no stored copy to go stale — but only with `security_invoker`, which
   * one `ALTER VIEW ... SET (security_invoker = false)` removes silently.
   *
   * STORY-152 introduced the first plain view (`project_entitled_engines`).
   */
  viewsWithoutSecurityInvoker: string[];
  /**
   * "<relation> (relkind=<k>)" — a relation in `public` of a kind NO bucket
   * examines.
   *
   * ⚠ THIS CLOSES THE CLASS, NOT ONE MORE INSTANCE OF IT. The view blind spot
   * existed because this module enumerates an allow-list of relkinds and
   * everything outside it is invisible. Adding views to that list fixed one
   * entry and left the shape intact — a review then walked one relkind over
   * and did it again with a FOREIGN TABLE:
   *
   *   CREATE FOREIGN TABLE projects_shadow (...) SERVER probe_srv;
   *   GRANT SELECT ON projects_shadow TO nominara_app, ...;
   *
   * RLS does not apply to foreign tables AT ALL, so there is no policy to be
   * missing and no flag to be unset. It is invisible by construction to all
   * seven buckets above, and `isClean` returned true with it present.
   *
   * So the rule is inverted here: every relkind is either handled by a bucket
   * or reported by this one. `f` (foreign table) and `m` (materialized view,
   * which ISO-16 forbids outright) are the two that can expose rows;
   * indexes, sequences, composite types and TOAST tables cannot and are
   * listed as handled. An unfamiliar EIGHTH relkind fails loudly instead of
   * silently, which is the property the previous two rounds did not have.
   */
  unclassifiedRelations: string[];
  /**
   * "<schema>.<table>" — a BASE TABLE outside `public`, which nothing in this
   * system manages.
   *
   * ⚠ THE FOURTH INSTANCE OF THE CLASS THIS STORY KEPT GETTING WRONG, AND THE
   * WORST OF THEM, BECAUSE THE RELATION IS THE MOST ORDINARY ONE THERE IS.
   *
   * STORY-152 widened two queries to every schema — the two a review had
   * planted objects in — and left the census that feeds the other six
   * buckets scoped to `public`. A review then planted this:
   *
   *   CREATE TABLE tenantdata.leaked_captures (id uuid, workspace_id uuid, secret text);
   *   GRANT SELECT ON tenantdata.leaked_captures TO nominara_app, ...;
   *
   * A tenant-bearing table, granted to every runtime role, with RLS not even
   * enabled — and all eight buckets empty. `unclassifiedRelations` cannot
   * catch it and should not: `r` is correctly in its handled list.
   *
   * The generator's census is rightly `public`-only (see introspect.ts: it
   * emits unqualified DDL). So the answer is not to widen that — it is to
   * refuse to let anything sit outside its scope unnoticed. THE DEFAULT HERE
   * IS TO REPORT. That is the difference between this list and the three
   * allow-lists that failed earlier in this story: an entry has to be
   * declared, and anything undeclared fails.
   */
  unmanagedTables: string[];
}

/**
 * The only base table outside `public` that is expected to exist.
 *
 * `_migrations.applied` is the migration runner's own ledger. It is created
 * by `migrate-runner.ts` BEFORE any migration has run — so before the schema,
 * the roles or the policy machinery exist — and it holds file names, not
 * tenant data. It cannot live in `public` under the generator's management
 * because it is what records that the generator's migrations ran.
 *
 * Schema-qualified and exact. A second table appearing in `_migrations`, or
 * anything at all in another schema, is reported.
 */
const EXPECTED_NON_PUBLIC_TABLES: readonly string[] = ["_migrations.applied"];

/**
 * Whether a view's reloptions enable `security_invoker`, decided BY POSTGRES.
 *
 * ⚠ AN ENUMERATION OF SPELLINGS IS THE WRONG SHAPE HERE, AND IT WAS WRONG
 * TWICE. The first version matched the string `security_invoker=true` and
 * reported `WITH (security_invoker = on)` — which is correct — as a
 * violation. The second version enumerated `true|on|1|yes` and still reported
 * `t`, because Postgres's boolean input also accepts `t`, `tr`, `tru`, `y`,
 * `ye` and every case variant of each. A gate that cries wolf on a correct
 * view gets distrusted, and a distrusted gate is the one nobody reads on the
 * day it matters.
 *
 * `pg_options_to_table` plus `::boolean` hands the question to the component
 * that owns the answer, so there is no list to keep in step with anything.
 * `COALESCE(..., 'false')` makes an ABSENT option false — the dangerous
 * default, which must fail rather than pass.
 *
 * EXPORTED because ISO-23 asks the same question of the same catalog, and two
 * copies of this predicate is exactly the defect this story's own comments
 * warn about three times over (the cadence expression, the window boundary,
 * the status set). It is a SQL fragment rather than a TS function so that
 * both callers put the work in the same place: the database.
 */
export const SECURITY_INVOKER_ENABLED_SQL = `
  COALESCE(
    (SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'security_invoker'),
    'false'
  )::boolean`;

/**
 * The schemas a tenant-bearing relation could hide in.
 *
 * ⚠ NOT `= 'public'`. This codebase already puts functions in `app`, and a
 * review planted a foreign table there that every control missed — the
 * relkind census was public-only while ISO-23 had already been widened, so
 * the reasoning existed and had simply not been carried across.
 */
export const NON_SYSTEM_SCHEMA_SQL = `
  n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'`;

export function isClean(result: RlsCheckResult): boolean {
  return (
    result.unclassifiedTables.length === 0 &&
    result.missingRls.length === 0 &&
    result.missingPolicies.length === 0 &&
    result.unexpectedPolicies.length === 0 &&
    result.policiesWithoutWithCheck.length === 0 &&
    result.globalTablesWithPolicies.length === 0 &&
    result.viewsWithoutSecurityInvoker.length === 0 &&
    result.unclassifiedRelations.length === 0 &&
    result.unmanagedTables.length === 0
  );
}

// Whitespace-collapsed and lowercased, per this story's own spec — PLUS
// parentheses stripped entirely. The extra step is necessary, not a gate
// relaxation: Postgres re-serializes a policy's qual/with_check expression
// tree with its OWN canonical parenthesization on round-trip (verified live
// — e.g. a hand-authored `a = b AND c = d` comes back as `((a = b) AND (c =
// d))`), so a comparison that only collapses whitespace/case would false-
// positive on every single policy. Stripping parens preserves the exact
// token sequence and order (grouping parens don't reorder anything), which
// is what actually distinguishes a correct predicate from a wrong one for
// the flat, non-nested boolean expressions every generated policy uses.
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprint(
  table: string,
  policyName: string,
  cmd: string,
  roles: readonly string[],
  using: string,
  withCheck: string | null,
): string {
  const sortedRoles = [...roles].map((r) => r.toLowerCase()).sort().join(",");
  return [
    table.toLowerCase(),
    policyName.toLowerCase(),
    cmd.toLowerCase(),
    sortedRoles,
    normalize(using),
    withCheck === null ? " null " : normalize(withCheck),
  ].join("|");
}

function describe(table: string, policyName: string): string {
  return `${table}.${policyName}`;
}

// pg_policies.roles is `name[]`, a type node-postgres has no default array
// parser registered for (unlike text[]/int4[]), so the driver hands back
// the raw Postgres array-literal text (e.g. "{nominara_app,nominara_worker}")
// instead of a JS array. Verified live: without this, fingerprint()'s
// `[...roles]` spread a STRING into individual CHARACTERS, so every single
// policy compared as a mismatch regardless of correctness.
function parsePgTextArray(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed === "{}") {
    return [];
  }
  return trimmed.replace(/^\{/, "").replace(/\}$/, "").split(",");
}

interface PartitionChild {
  readonly name: string;
  readonly parent: string;
}

// Namespace-qualified on the PARENT's schema (matching 0006's own DO block
// pattern, and src/db/rls/generate.ts's APPLY_TENANT_RLS_SQL comment) — fix
// pass item 18. Without this, a same-named relation in a different schema
// would collapse into this query's result (pg_class.relname is not unique
// across schemas), silently masking a genuinely missing flag or policy.
async function findPartitionChildren(client: Client): Promise<PartitionChild[]> {
  const result = await client.query<{ relname: string; parent_name: string }>(
    `SELECT c.relname, p.relname AS parent_name
       FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid
       JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND p.relkind = 'p'`,
  );
  return result.rows.map((row) => ({ name: row.relname, parent: row.parent_name }));
}

/**
 * The structured equivalent of what `app.apply_tenant_rls` actually does at
 * runtime: copies the PARENT's `ws_isolation_<parent>` USING/WITH CHECK
 * predicate onto the child verbatim, under a `ws_isolation_<child>` name, for
 * the SAME roles. Fix pass item 1 — this is the fingerprint every partition
 * child is expected to match; before this, `checkRls` inspected ONLY the
 * ENABLE/FORCE flags on a child and never looked at policy CONTENT at all,
 * so a permissive `USING (true)` planted directly on a child (or a missing
 * policy with the flags left alone) passed clean. Deliberately does NOT
 * expect a `portal_scope_*` policy on the child — see fix pass item 9 /
 * `app.apply_tenant_rls`'s own header comment for why that asymmetry is
 * correct, not a gap.
 */
function computeExpectedChildPolicy(child: PartitionChild, parentPolicies: readonly ExpectedPolicy[]): ExpectedPolicy | null {
  const parentWsPolicy = parentPolicies.find(
    (p) => p.table === child.parent && p.policyName === `ws_isolation_${child.parent}`,
  );
  if (!parentWsPolicy) {
    return null;
  }
  return {
    table: child.name,
    policyName: `ws_isolation_${child.name}`,
    cmd: "ALL",
    roles: parentWsPolicy.roles,
    using: parentWsPolicy.using,
    withCheck: parentWsPolicy.withCheck,
  };
}

/**
 * Checks `client`'s ALREADY-MIGRATED database against src/db/rls/generate.ts.
 * Does not apply migrations itself (mirrors checkDrift's contract) — see
 * main() below for the shadow-database CLI wrapper that does.
 */
export async function checkRls(client: Client): Promise<RlsCheckResult> {
  const tables = await introspectTables(client);
  const globalSet = new Set<string>(GLOBAL_TABLES);

  const unclassifiedTables: string[] = [];
  const classifiable: TableDescriptor[] = [];
  for (const table of tables) {
    if (globalSet.has(table.name)) {
      continue;
    }
    try {
      generateRlsSql([table]);
      classifiable.push(table);
    } catch {
      unclassifiedTables.push(table.name);
    }
  }

  const partitionChildren = await findPartitionChildren(client);
  const rlsFlagTargets = [...classifiable.map((t) => t.name), ...partitionChildren.map((c) => c.name)];
  // Namespace-qualified (fix pass item 18) — matches the migration's own
  // DO block pattern; pg_class.relname is not unique across schemas, so an
  // unqualified match could silently collapse two same-named relations from
  // different schemas into one entry.
  const flagsResult = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [rlsFlagTargets],
  );
  const flagsByName = new Map(flagsResult.rows.map((row) => [row.relname, row]));
  const missingRls: string[] = [];
  for (const name of rlsFlagTargets) {
    const flags = flagsByName.get(name);
    if (!flags || !flags.relrowsecurity || !flags.relforcerowsecurity) {
      missingRls.push(
        `${name}: relrowsecurity=${flags?.relrowsecurity ?? "missing"} relforcerowsecurity=${flags?.relforcerowsecurity ?? "missing"}`,
      );
    }
  }

  // STORY-021 / ADR-0001 — the actor-self-scoped policies are additive to
  // the ws_isolation_*/portal_scope_* set above, on the same two
  // (already-classifiable) tables, so they merge into the same expected set
  // rather than a separate comparison bucket.
  const expectedPolicies: ExpectedPolicy[] = [
    ...computeExpectedPolicies(classifiable),
    ...computeActorSelfScopedPolicies(classifiable),
  ];

  // Fix pass item 1 — every partition child is expected to carry a
  // ws_isolation_<child> policy that is a verbatim copy of its parent's own
  // ws_isolation_<parent> predicate (exactly what app.apply_tenant_rls does).
  // A child whose parent isn't itself classifiable is skipped rather than
  // silently ignored — computeExpectedChildPolicy returns null and this loop
  // drops it, so a stray, unrelated partition can never surface HERE (its
  // ENABLE/FORCE flags are still checked above via rlsFlagTargets).
  const expectedChildPolicies: ExpectedPolicy[] = [];
  for (const child of partitionChildren) {
    const expectedChild = computeExpectedChildPolicy(child, expectedPolicies);
    if (expectedChild) {
      expectedChildPolicies.push(expectedChild);
    }
  }

  const expectedFingerprints = new Map<string, ExpectedPolicy>();
  for (const policy of [...expectedPolicies, ...expectedChildPolicies]) {
    expectedFingerprints.set(
      fingerprint(policy.table, policy.policyName, policy.cmd, policy.roles, policy.using, policy.withCheck),
      policy,
    );
  }

  const actualResult = await client.query<{
    tablename: string;
    policyname: string;
    cmd: string;
    // See parsePgTextArray's comment — this is the raw "{a,b,c}" text, not a JS array.
    roles: string;
    qual: string | null;
    with_check: string | null;
  }>(
    `SELECT tablename, policyname, cmd, roles, qual, with_check
       FROM pg_policies
      WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
    [[...classifiable.map((t) => t.name), ...partitionChildren.map((c) => c.name)]],
  );

  const actualFingerprints = new Map<string, (typeof actualResult.rows)[number]>();
  for (const row of actualResult.rows) {
    actualFingerprints.set(
      fingerprint(row.tablename, row.policyname, row.cmd, parsePgTextArray(row.roles), row.qual ?? "", row.with_check),
      row,
    );
  }

  const missingPolicies: string[] = [];
  for (const [fp, policy] of expectedFingerprints) {
    if (!actualFingerprints.has(fp)) {
      missingPolicies.push(describe(policy.table, policy.policyName));
    }
  }

  const unexpectedPolicies: string[] = [];
  for (const [fp, row] of actualFingerprints) {
    if (!expectedFingerprints.has(fp)) {
      unexpectedPolicies.push(describe(row.tablename, row.policyname));
    }
  }

  // Independent, blanket catalog checks — not scoped to the expected/actual
  // comparison above, so a mistake here is caught even if it happens to
  // coincide with an otherwise-correct classification.
  // ⚠ EVERY NON-SYSTEM SCHEMA. A FOR ALL policy with a NULL with_check is a
  // write that escapes its own read filter, and that is no less true in `app`
  // than in `public`. Scoped to public, this bucket would have reported clean
  // on one.
  const forAllNullCheckResult = await client.query<{ schemaname: string; tablename: string; policyname: string }>(
    `SELECT schemaname, tablename, policyname
       FROM pg_policies
      WHERE cmd = 'ALL' AND with_check IS NULL
        AND schemaname NOT IN ('pg_catalog', 'information_schema')`,
  );
  const policiesWithoutWithCheck = forAllNullCheckResult.rows.map((row) =>
    describe(row.schemaname === "public" ? row.tablename : `${row.schemaname}.${row.tablename}`, row.policyname),
  );

  const globalPoliciesResult = await client.query<{ tablename: string; policyname: string }>(
    "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
    [GLOBAL_TABLES],
  );
  const globalTablesWithPolicies = globalPoliciesResult.rows.map((row) => describe(row.tablename, row.policyname));

  // ⚠ READ FROM pg_class DIRECTLY, NOT FROM THE CENSUS. `CENSUS_TABLES_SQL`
  // filters `relkind IN ('r','p')` and would return nothing here — which is
  // the blind spot this bucket exists to close, so reusing it would rebuild
  // the blind spot inside its own fix.
  //
  // `reloptions` is NULL on a view created without options, and that is the
  // dangerous case (PostgreSQL's default is security DEFINER semantics), so a
  // missing array must fail rather than pass. Matched on the exact token
  // `security_invoker=true`; Postgres normalises the stored spelling, which
  // this is verified against in rls-check.spec.ts.
  // ⚠ EXTENSION-OWNED VIEWS ARE EXCLUDED, BY DEPENDENCY AND NOT BY NAME.
  // `pg_stat_statements` installs `pg_stat_statements` and
  // `pg_stat_statements_info` into `public`, and they are neither ours to
  // alter nor capable of leaking tenant data — they read shared memory, not
  // our tables. `pg_depend.deptype = 'e'` is what "belongs to an extension"
  // actually means; an allow-list of two names would quietly admit the next
  // extension's views, which is the same class of gap this bucket closes.
  const viewsResult = await client.query<{ nspname: string; relname: string; reloptions: string[] | null; enabled: boolean }>(
    `SELECT n.nspname, c.relname, c.reloptions, ${SECURITY_INVOKER_ENABLED_SQL} AS enabled
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'v'
        AND ${NON_SYSTEM_SCHEMA_SQL}
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass
             AND d.objid = c.oid
             AND d.deptype = 'e'
        )`,
  );
  // ⚠ PARSED, NOT STRING-MATCHED. `WITH (security_invoker = on)` stores
  // `security_invoker=on`, which is correct and which an `includes("...=true")`
  // test reports as a violation. The direction is fail-safe, but a gate that
  // cries wolf on a correct view costs someone an hour and teaches them to
  // distrust it. Postgres's own boolean parse accepts on/true/1/yes.
  // Schema-qualified outside `public`, because the bucket below already does
  // and a review pointed out that an unqualified message names an object that
  // may also exist in `public` and be fine — sending the operator to the
  // wrong relation first.
  const viewsWithoutSecurityInvoker = viewsResult.rows
    .filter((row) => !row.enabled)
    .map(
      (row) =>
        `${row.nspname === "public" ? row.relname : `${row.nspname}.${row.relname}`}: ` +
        `security_invoker=${(row.reloptions ?? []).join(",") || "unset"}`,
    );

  // ⚠ THE INVERTED CENSUS. Every other query here names the relkinds it wants;
  // this one names the relkinds that are ACCOUNTED FOR and reports the rest.
  //
  //   r, p  tables and partitioned tables   -> the six buckets above
  //   v     views                           -> viewsWithoutSecurityInvoker
  //   i, I  indexes                         -> hold no rows of their own
  //   S     sequences                       -> no tenant data
  //   c     composite types                 -> not a relation with rows
  //   t     TOAST                           -> inaccessible, follows its table
  //
  // `m` (materialized view) and `f` (foreign table) are deliberately ABSENT
  // from that list, so both land here. A matview is forbidden by ISO-16 and a
  // foreign table is outside RLS entirely — neither has a bucket, and before
  // this they had no report either.
  //
  // ⚠ EVERY NON-SYSTEM SCHEMA, NOT `public`. This was public-only for one
  // round, while ISO-23 had already been widened — so the reasoning existed
  // in this repository and had simply not been carried across. A review
  // planted `app.projects_shadow`, a FOREIGN TABLE granted to all three
  // runtime roles, and it fell through every control: this bucket did not see
  // the schema, ISO-23 only looks at views, and ISO-16 only at matviews. RLS
  // does not apply to foreign tables at all, so nothing else was going to
  // catch it either. The name is schema-qualified for the same reason.
  const unhandledResult = await client.query<{ nspname: string; relname: string; relkind: string }>(
    `SELECT n.nspname, c.relname, c.relkind::text
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${NON_SYSTEM_SCHEMA_SQL}
        AND c.relkind NOT IN ('r', 'p', 'v', 'i', 'I', 'S', 'c', 't')
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
        )`,
  );
  const unclassifiedRelations = unhandledResult.rows.map(
    (row) => `${row.nspname === "public" ? row.relname : `${row.nspname}.${row.relname}`} (relkind=${row.relkind})`,
  );

  // Base tables outside the generator's scope. Partition children are
  // excluded the same way the generator's census excludes them, so a
  // partitioned table in another schema reports once rather than once per
  // child.
  const unmanagedResult = await client.query<{ qualified: string }>(
    `SELECT n.nspname || '.' || c.relname AS qualified
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE ${NON_SYSTEM_SCHEMA_SQL}
        AND n.nspname <> 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relispartition
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
        )`,
  );
  const unmanagedTables = unmanagedResult.rows
    .map((row) => row.qualified)
    .filter((qualified) => !EXPECTED_NON_PUBLIC_TABLES.includes(qualified));

  return {
    unclassifiedTables,
    missingRls,
    missingPolicies,
    unexpectedPolicies,
    policiesWithoutWithCheck,
    globalTablesWithPolicies,
    viewsWithoutSecurityInvoker,
    unclassifiedRelations,
    unmanagedTables,
  };
}

async function main() {
  const maintenanceUrl = requireDatabaseUrl();
  const shadowDbName = `nominara_rlscheck_${Date.now()}`;
  const maintenance = await connect(maintenanceUrl);
  try {
    await maintenance.query(`CREATE DATABASE ${shadowDbName}`);
  } finally {
    await maintenance.end();
  }

  const shadowUrl = new URL(maintenanceUrl);
  shadowUrl.pathname = `/${shadowDbName}`;
  const shadow = await connect(shadowUrl.toString());

  let result: RlsCheckResult;
  try {
    await migrateUp(shadow, MIGRATIONS_DIR);
    result = await checkRls(shadow);
  } finally {
    await shadow.end();
    const cleanup = await connect(maintenanceUrl);
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${shadowDbName}`);
    } finally {
      await cleanup.end();
    }
  }

  if (!isClean(result)) {
    console.error("rls check failed:");
    if (result.unclassifiedTables.length > 0) {
      console.error(`  unclassified tables: ${result.unclassifiedTables.join(", ")}`);
    }
    if (result.missingRls.length > 0) {
      console.error(`  missing RLS flags: ${result.missingRls.join("; ")}`);
    }
    if (result.missingPolicies.length > 0) {
      console.error(`  missing policies: ${result.missingPolicies.join(", ")}`);
    }
    if (result.unexpectedPolicies.length > 0) {
      console.error(`  unexpected policies: ${result.unexpectedPolicies.join(", ")}`);
    }
    if (result.policiesWithoutWithCheck.length > 0) {
      console.error(`  FOR ALL policies without a with_check: ${result.policiesWithoutWithCheck.join(", ")}`);
    }
    if (result.globalTablesWithPolicies.length > 0) {
      console.error(`  policies on GLOBAL_TABLES entries: ${result.globalTablesWithPolicies.join(", ")}`);
    }
    if (result.viewsWithoutSecurityInvoker.length > 0) {
      console.error(`  views without security_invoker (they run as OWNER and bypass RLS): ${result.viewsWithoutSecurityInvoker.join(", ")}`);
    }
    if (result.unclassifiedRelations.length > 0) {
      console.error(`  relations of an unhandled kind — no bucket examines these: ${result.unclassifiedRelations.join(", ")}`);
    }
    if (result.unmanagedTables.length > 0) {
      console.error(`  base tables outside \`public\` — the RLS generator does not manage these: ${result.unmanagedTables.join(", ")}`);
    }
    // ⚠ A BUCKET WITH NO LINE HERE PRINTS NOTHING AND EXITS 1, which reads as
    // a broken tool on the one invariant nobody was looking for. The seventh
    // bucket shipped in exactly that state: `isClean` consulted it and this
    // block did not, so `pnpm db:rls-check` failed with a bare header.
    //
    // This is the backstop rather than a reason to relax: it names any bucket
    // that is non-empty and unprinted, so the NEXT one is merely ugly instead
    // of silent. The per-bucket lines above are still what a reviewer reads.
    const printed = new Set([
      "unclassifiedTables",
      "missingRls",
      "missingPolicies",
      "unexpectedPolicies",
      "policiesWithoutWithCheck",
      "globalTablesWithPolicies",
      "viewsWithoutSecurityInvoker",
      "unclassifiedRelations",
      "unmanagedTables",
    ]);
    for (const [bucket, entries] of Object.entries(result)) {
      if (!printed.has(bucket) && Array.isArray(entries) && entries.length > 0) {
        console.error(`  ${bucket} (no dedicated message — add one): ${entries.join(", ")}`);
      }
    }
    process.exit(1);
  }

  console.log("rls check passed: policies match src/db/rls/generate.ts");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
