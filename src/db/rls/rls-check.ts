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
}

export function isClean(result: RlsCheckResult): boolean {
  return (
    result.unclassifiedTables.length === 0 &&
    result.missingRls.length === 0 &&
    result.missingPolicies.length === 0 &&
    result.unexpectedPolicies.length === 0 &&
    result.policiesWithoutWithCheck.length === 0 &&
    result.globalTablesWithPolicies.length === 0 &&
    result.viewsWithoutSecurityInvoker.length === 0
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
  const forAllNullCheckResult = await client.query<{ tablename: string; policyname: string }>(
    "SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public' AND cmd = 'ALL' AND with_check IS NULL",
  );
  const policiesWithoutWithCheck = forAllNullCheckResult.rows.map((row) => describe(row.tablename, row.policyname));

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
  const viewsResult = await client.query<{ relname: string; reloptions: string[] | null }>(
    `SELECT c.relname, c.reloptions
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'v'
        AND NOT EXISTS (
          SELECT 1 FROM pg_depend d
           WHERE d.classid = 'pg_class'::regclass
             AND d.objid = c.oid
             AND d.deptype = 'e'
        )`,
  );
  const viewsWithoutSecurityInvoker = viewsResult.rows
    .filter((row) => !(row.reloptions ?? []).includes("security_invoker=true"))
    .map((row) => `${row.relname}: security_invoker=${(row.reloptions ?? []).join(",") || "unset"}`);

  return {
    unclassifiedTables,
    missingRls,
    missingPolicies,
    unexpectedPolicies,
    policiesWithoutWithCheck,
    globalTablesWithPolicies,
    viewsWithoutSecurityInvoker,
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
    process.exit(1);
  }

  console.log("rls check passed: policies match src/db/rls/generate.ts");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
