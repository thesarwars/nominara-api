import { describe, expect, it } from "vitest";
import {
  ACTOR_SELF_SCOPED_TABLES,
  GLOBAL_TABLES,
  PORTAL_JOIN_SCOPED_TABLES,
  PORTAL_READABLE_TABLES,
  RLS_POLICY_ROLES,
  RUNTIME_ROLES,
  TENANT_SCOPE_COLUMN,
} from "../../src/db/conventions.js";
import {
  computeActorSelfScopedPolicies,
  computeDefinerOwnerPolicies,
  computeExpectedPolicies,
  generateActorSelfScopedRlsSql,
  generatePortalJoinScopedRlsSql,
  generateRlsSql,
  resolveProjectPredicate,
  type TableDescriptor,
} from "../../src/db/rls/generate.js";

// STORY-011 · the RLS policy generator is a PURE function — no database
// access anywhere in this file. `REAL_SCHEMA_TABLES` below mirrors the
// migrated schema exactly (src/db/migrations/sql/0002-0004), so this file's
// exact-statement-count assertions are checked against a faithful model of
// production, not a toy fixture — the same 69 tables, the same 18
// portal-readable ones (fix pass STORY-011-E-2 removed source_domains and
// brand_themes — see conventions.ts's PORTAL_READABLE_TABLES comment), the
// same project_id presence/absence per table.
// (The integration suite additionally checks the generator against the REAL
// introspected schema live from Postgres — this file exists to keep the
// classification logic itself testable with zero I/O.)

function t(name: string, columns: readonly string[]): TableDescriptor {
  return { name, columns: new Set(columns) };
}

// ---- Global tables (10) — columns are irrelevant, they're skipped outright.
const GLOBAL_FIXTURES: TableDescriptor[] = [
  t("users", []),
  t("user_credentials", []),
  t("plans", []),
  t("engines", []),
  t("credit_packs", []),
  t("platform_metrics", []),
  t("niche_reports", []),
  t("aux_rule_catalog", []),
  t("task_generation_rules", []),
  t("engine_health", []),
];

// ---- Tenant tables (59), 0002_identity_tenancy_billing.up.sql (16, excl. workspaces/plans/users/user_credentials)
const IDENTITY_BILLING_FIXTURES: TableDescriptor[] = [
  t("workspaces", ["id", "name", "slug"]), // TENANT_SCOPE_COLUMN exception — scoped by id
  t("workspace_keys", ["id", "workspace_id"]),
  t("workspace_members", ["id", "workspace_id"]),
  t("workspace_invitations", ["id", "workspace_id"]),
  t("sso_configurations", ["id", "workspace_id"]),
  t("api_keys", ["id", "workspace_id"]),
  t("support_grants", ["id", "workspace_id"]),
  t("subscriptions", ["id", "workspace_id"]),
  t("credit_wallets", ["workspace_id"]),
  t("credit_daily_counters", ["workspace_id"]),
  t("credit_ledger", ["id", "workspace_id", "project_id"]),
  t("credit_purchases", ["id", "workspace_id"]),
  t("subscription_addons", ["id", "workspace_id"]),
  t("usage_counters", ["workspace_id"]),
  t("usage_ledger", ["id", "workspace_id", "project_id"]),
  t("invoices", ["id", "workspace_id"]),
];

// ---- 0003_projects_prompts_captures.up.sql (12, excl. engines/engine_health)
const PROJECTS_PROMPTS_FIXTURES: TableDescriptor[] = [
  t("projects", ["id", "workspace_id"]), // PORTAL_SELF_SCOPED_TABLES
  t("project_engines", ["workspace_id", "project_id"]),
  t("competitors", ["id", "workspace_id", "project_id"]),
  t("domain_verifications", ["id", "workspace_id", "project_id"]),
  t("tracked_prompts", ["id", "workspace_id", "project_id"]),
  t("prompt_stability", ["workspace_id"]), // no project_id
  t("topic_clusters", ["id", "workspace_id", "project_id"]),
  t("capture_runs", ["id", "workspace_id", "project_id"]),
  t("answer_captures", ["id", "workspace_id", "project_id"]),
  t("mention_facts", ["id", "workspace_id", "project_id"]),
  t("citation_facts", ["id", "workspace_id", "project_id"]),
  t("displacement_events", ["id", "workspace_id", "project_id"]),
];

// ---- 0004_rollups_aux_tasks_geo_tools.up.sql (31, excl. the 4 global ones)
const ROLLUPS_AUX_TASKS_GEO_FIXTURES: TableDescriptor[] = [
  t("source_domains", ["id", "workspace_id"]), // no project_id — portal-readable through project_source_index only (decision 83 c)
  t("project_source_index", ["workspace_id", "project_id"]),
  t("metric_daily", ["workspace_id", "project_id"]),
  t("milestones", ["id", "workspace_id", "project_id"]),
  t("notifications", ["id", "workspace_id", "project_id"]),
  t("aux_audits", ["id", "workspace_id", "project_id"]),
  t("aux_findings", ["id", "workspace_id", "project_id"]),
  t("tasks", ["id", "workspace_id", "project_id"]),
  t("goals", ["id", "workspace_id", "project_id"]),
  t("task_events", ["id", "workspace_id"]), // no project_id
  t("ref_counters", ["workspace_id"]),
  t("geo_analyses", ["workspace_id", "project_id"]),
  t("entity_nodes", ["workspace_id", "project_id"]),
  t("geo_alignments", ["id", "workspace_id", "project_id"]),
  t("content_chunks", ["id", "workspace_id", "project_id"]),
  t("corpus_passages", ["id", "workspace_id", "project_id"]),
  t("semantic_nodes", ["id", "workspace_id", "project_id"]),
  t("patches", ["id", "workspace_id", "project_id"]),
  t("tool_runs", ["id", "workspace_id"]), // no project_id
  t("attribution_configs", ["id", "workspace_id", "project_id"]),
  t("attribution_daily", ["workspace_id", "project_id"]),
  t("attribution_url_rollup", ["workspace_id", "project_id"]),
  t("gsc_connections", ["id", "workspace_id", "project_id"]),
  t("gsc_daily", ["workspace_id", "project_id"]),
  t("brand_themes", ["id", "workspace_id"]), // no project_id — not portal-readable, STORY-011-E-2
  t("custom_domains", ["id", "workspace_id"]),
  t("share_tokens", ["id", "workspace_id"]),
  t("share_token_views", ["id", "workspace_id"]),
  t("scheduled_reports", ["id", "workspace_id"]),
  t("report_artifacts", ["id", "workspace_id"]),
  t("audit_log", ["seq", "workspace_id"]),
];

const REAL_SCHEMA_TABLES: TableDescriptor[] = [
  ...GLOBAL_FIXTURES,
  ...IDENTITY_BILLING_FIXTURES,
  ...PROJECTS_PROMPTS_FIXTURES,
  ...ROLLUPS_AUX_TASKS_GEO_FIXTURES,
];

describe("STORY-011 · src/db/rls/generate.ts — RLS policy generator", () => {
  it("REAL_SCHEMA_TABLES fixture actually has 69 tables (10 global + 59 tenant), matching the census", () => {
    expect(REAL_SCHEMA_TABLES.length).toBe(69);
    expect(GLOBAL_FIXTURES.length).toBe(10);
    expect(REAL_SCHEMA_TABLES.length - GLOBAL_FIXTURES.length).toBe(59);
  });

  // ---- Test Scenario 6 — the fail-closed generator throw --------------------

  it("scenario 6 — throws for a table with no workspace_id column and no GLOBAL_TABLES/TENANT_SCOPE_COLUMN entry", () => {
    const rogue = t("mystery_table", ["id", "name"]);
    expect(() => generateRlsSql([...REAL_SCHEMA_TABLES, rogue])).toThrow(/mystery_table/);
    expect(() => generateRlsSql([rogue])).toThrow(/workspace_id/);
    expect(() => generateRlsSql([rogue])).toThrow(/TENANT_SCOPE_COLUMN/);
    expect(() => generateRlsSql([rogue])).toThrow(/GLOBAL_TABLES/);
  });

  it("does not throw when every table is classifiable (the real schema fixture)", () => {
    expect(() => generateRlsSql(REAL_SCHEMA_TABLES)).not.toThrow();
  });

  // ---- GLOBAL_TABLES emit nothing --------------------------------------------

  it("emits nothing for GLOBAL_TABLES entries — no ALTER TABLE, no CREATE POLICY, for any of the 10", () => {
    const sql = generateRlsSql(REAL_SCHEMA_TABLES);
    for (const table of GLOBAL_TABLES) {
      // Word-boundary anchored on "ON <table>" specifically (not a bare
      // "_<table>" suffix check) — several global names are substrings of
      // unrelated tenant table names with an underscore joiner (e.g.
      // "engines" inside "project_engines"), where "_" and the following
      // letter share no \b transition, so a naive suffix regex would
      // false-positive on those and hide a real generator bug.
      expect(sql).not.toMatch(new RegExp(`ALTER TABLE ${table}\\b`));
      expect(sql).not.toMatch(new RegExp(`\\bON ${table}\\b`));
    }
  });

  // ---- ENABLE + FORCE + FOR ALL with BOTH USING and WITH CHECK ---------------

  it("emits ENABLE, FORCE, and a FOR ALL policy with both USING and WITH CHECK for a plain tenant table", () => {
    const sql = generateRlsSql([t("competitors", ["id", "workspace_id", "project_id"])]);
    expect(sql).toContain("ALTER TABLE competitors ENABLE ROW LEVEL SECURITY;");
    expect(sql).toContain("ALTER TABLE competitors FORCE  ROW LEVEL SECURITY;");
    expect(sql).toMatch(/CREATE POLICY ws_isolation_competitors ON competitors\s*\n\s*FOR ALL TO nominara_app, nominara_worker, nominara_report/);
    expect(sql).toContain("USING      (workspace_id = app.current_workspace())");
    expect(sql).toContain("WITH CHECK (workspace_id = app.current_workspace());");
  });

  // ---- workspaces uses `id`, declared explicitly, not special-cased --------

  it("uses `id` (not workspace_id) as the scope column for workspaces, per TENANT_SCOPE_COLUMN", () => {
    expect(TENANT_SCOPE_COLUMN.workspaces).toBe("id");
    const sql = generateRlsSql([t("workspaces", ["id"])]);
    expect(sql).toContain("USING      (id = app.current_workspace())");
    expect(sql).toContain("WITH CHECK (id = app.current_workspace());");
    // workspaces is not portal-readable — no portal_scope_workspaces at all.
    expect(sql).not.toContain("portal_scope_workspaces");
  });

  // ---- portal_scope_* only for portal-readable tables ------------------------

  it("0006 emits portal_scope_* for the 18 project-keyed portal-readable tables, never a non-portal tenant table, and NOT source_domains (that policy has its own migration)", () => {
    expect(PORTAL_READABLE_TABLES.length).toBe(19);
    expect([...PORTAL_JOIN_SCOPED_TABLES]).toEqual(["source_domains"]);
    const sql = generateRlsSql(REAL_SCHEMA_TABLES);
    for (const table of PORTAL_READABLE_TABLES.filter((name) => !(PORTAL_JOIN_SCOPED_TABLES as readonly string[]).includes(name))) {
      expect(sql, `expected portal_scope_${table}`).toContain(`CREATE POLICY portal_scope_${table} ON ${table}`);
    }
    // ⚠ 0006 is an APPLIED migration: a policy added to it would never reach a database that already ran it.
    expect(sql).not.toContain("portal_scope_source_domains");
    const nonPortalTenantTables = REAL_SCHEMA_TABLES.filter(
      (table) =>
        !(GLOBAL_TABLES as readonly string[]).includes(table.name) &&
        !(PORTAL_READABLE_TABLES as readonly string[]).includes(table.name),
    );
    for (const table of nonPortalTenantTables) {
      expect(sql, `did not expect portal_scope_${table.name}`).not.toContain(`portal_scope_${table.name}`);
    }
  });

  // ---- predicate selection per the three cases -------------------------------

  it("predicate case 1 — projects (PORTAL_SELF_SCOPED_TABLES) uses `id = ANY(...)`, not project_id", () => {
    const sql = generateRlsSql([t("projects", ["id", "workspace_id"])]);
    expect(sql).toMatch(/CREATE POLICY portal_scope_projects ON projects\s*\n\s*FOR SELECT TO nominara_portal\s*\n\s*USING \(workspace_id = app\.current_workspace\(\)\s*\n\s*AND id = ANY \(app\.current_scope_projects\(\)\)\);/);
  });

  it("predicate case 2 — a project-descendant table (competitors) uses `project_id = ANY(...)`, carrying BOTH keys", () => {
    const sql = generateRlsSql([t("competitors", ["id", "workspace_id", "project_id"])]);
    expect(sql).toMatch(/CREATE POLICY portal_scope_competitors ON competitors\s*\n\s*FOR SELECT TO nominara_portal\s*\n\s*USING \(workspace_id = app\.current_workspace\(\)\s*\n\s*AND project_id = ANY \(app\.current_scope_projects\(\)\)\);/);
  });

  // ---- fix pass STORY-011-E-2 — source_domains/brand_themes removed from
  // PORTAL_READABLE_TABLES; the workspace-scope-only fallback branch of
  // resolveProjectPredicate is exercised directly rather than via a real
  // table, since no table in the live PORTAL_READABLE_TABLES set reaches it
  // anymore (see the invariant test below, which pins that fact).

  it("predicate case 3 (direct) — resolveProjectPredicate falls back to null (workspace-scope only, no join) for a table with no project_id and not self-scoped", () => {
    expect(resolveProjectPredicate(t("hypothetical_workspace_only_table", ["id", "workspace_id"]))).toBeNull();
  });

  it("decision 83 (c) — source_domains is portal-readable ONLY through a project_source_index row for a project in the token's scope; brand_themes still receives no portal policy", () => {
    const portalPolicy = computeExpectedPolicies(REAL_SCHEMA_TABLES).find((policy) => policy.policyName === "portal_scope_source_domains");
    expect(portalPolicy).toMatchObject({ table: "source_domains", cmd: "SELECT", roles: ["nominara_portal"], withCheck: null });
    expect(portalPolicy!.using).toBe(
      "workspace_id = app.current_workspace() AND EXISTS (SELECT 1 FROM project_source_index psi WHERE psi.source_domain_id = source_domains.id AND psi.project_id = ANY (app.current_scope_projects()))",
    );
    expect(computeExpectedPolicies(REAL_SCHEMA_TABLES).some((policy) => policy.policyName === "portal_scope_brand_themes")).toBe(false);
    expect((PORTAL_READABLE_TABLES as readonly string[])).not.toContain("brand_themes");
  });

  it("decision 83 (c) — the join-scoped portal policy is generated into its OWN migration: one guarded SELECT policy for nominara_portal, no ENABLE/FORCE, no ws_isolation, and it names the override of the STORY-011-E-2 note", () => {
    const sql = generatePortalJoinScopedRlsSql(REAL_SCHEMA_TABLES);
    expect(sql).toContain("CREATE POLICY portal_scope_source_domains ON source_domains");
    expect(sql).toContain("FOR SELECT TO nominara_portal");
    expect(sql).toContain("EXISTS (SELECT 1 FROM project_source_index psi");
    expect(sql).toContain("psi.project_id = ANY (app.current_scope_projects())");
    expect(sql).toContain("STORY-011-E-2");
    expect(sql).toMatch(/owner decision 83/i);
    expect(sql).not.toMatch(/ENABLE ROW LEVEL SECURITY|FORCE\s+ROW LEVEL SECURITY|ws_isolation_/);
    expect([...sql.matchAll(/CREATE POLICY /g)]).toHaveLength(1);
    expect(sql).toContain("pg_policies");
  });

  it("invariant — every real PORTAL_READABLE_TABLES entry resolves a non-null project predicate (the workspace-scope-only fallback is unreached in production)", () => {
    const byName = new Map(REAL_SCHEMA_TABLES.map((table) => [table.name, table]));
    for (const name of PORTAL_READABLE_TABLES) {
      const table = byName.get(name);
      expect(table, `${name} missing from REAL_SCHEMA_TABLES fixture`).toBeDefined();
      expect(resolveProjectPredicate(table!), `${name} resolved a null (workspace-scope-only) predicate`).not.toBeNull();
    }
  });

  // ---- alphabetical ordering --------------------------------------------------

  it("emits tenant table blocks in alphabetical order regardless of input order", () => {
    const shuffled = [
      t("tracked_prompts", ["id", "workspace_id", "project_id"]),
      t("competitors", ["id", "workspace_id", "project_id"]),
      t("workspaces", ["id"]),
      t("aux_findings", ["id", "workspace_id", "project_id"]),
    ];
    const sql = generateRlsSql(shuffled);
    const order = ["aux_findings", "competitors", "tracked_prompts", "workspaces"];
    const indices = order.map((name) => sql.indexOf(`ALTER TABLE ${name} ENABLE`));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });

  // ---- exact statement counts against the real schema ------------------------

  it("exact statement counts against the real 69-table schema: 59 ENABLE, 59 FORCE, 59 ws_isolation, 18 portal_scope, 0 policies on GLOBAL_TABLES", () => {
    const sql = generateRlsSql(REAL_SCHEMA_TABLES);

    const enableCount = [...sql.matchAll(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY;/g)].length;
    const forceCount = [...sql.matchAll(/ALTER TABLE \w+ FORCE {2}ROW LEVEL SECURITY;/g)].length;
    const wsIsolationCount = [...sql.matchAll(/CREATE POLICY ws_isolation_\w+ ON \w+/g)].length;
    const portalScopeCount = [...sql.matchAll(/CREATE POLICY portal_scope_\w+ ON \w+/g)].length;

    expect(enableCount).toBe(59);
    expect(forceCount).toBe(59);
    expect(wsIsolationCount).toBe(59);
    expect(portalScopeCount).toBe(18); // the 19th, source_domains, is in its own migration (decision 83 c)

    for (const table of GLOBAL_TABLES) {
      expect([...sql.matchAll(new RegExp(`CREATE POLICY \\w+ ON ${table}\\b`, "g"))]).toEqual([]);
    }
  });

  // ---- the reusable partition function is always present ---------------------

  it("always emits the app.apply_tenant_rls function and its partition-discovery DO block", () => {
    const sql = generateRlsSql(REAL_SCHEMA_TABLES);
    expect(sql).toContain("CREATE OR REPLACE FUNCTION app.apply_tenant_rls(target regclass)");
    expect(sql).toContain("FROM pg_inherits");
    expect(sql).toContain("PERFORM app.apply_tenant_rls(child);");
  });

  // ---- fix pass item 8 — app.apply_tenant_rls's role list must be derived
  // from RLS_POLICY_ROLES.forAll, not a second, independent hardcoded
  // literal that could silently diverge from it -----------------------------

  it("app.apply_tenant_rls's CREATE POLICY role list is interpolated from RLS_POLICY_ROLES.forAll, not a separate hardcoded literal", () => {
    const sql = generateRlsSql(REAL_SCHEMA_TABLES);
    const expectedRoleList = RLS_POLICY_ROLES.forAll.join(", ");
    expect(sql).toContain(
      `'CREATE POLICY %I ON %s FOR ALL TO ${expectedRoleList} USING (%s) WITH CHECK (%s)'`,
    );
  });

  // ---- header --------------------------------------------------------------

  it("carries the generated-file header naming the generator and the regenerate command", () => {
    const sql = generateRlsSql(REAL_SCHEMA_TABLES);
    expect(sql).toMatch(/GENERATED BY src\/db\/rls\/generate\.ts — DO NOT HAND-EDIT/);
    expect(sql).toMatch(/pnpm db:rls-generate/);
  });

  // ---- RLS_POLICY_ROLES stays consistent with RUNTIME_ROLES ------------------

  it("RLS_POLICY_ROLES covers exactly the same role set as RUNTIME_ROLES (a 5th runtime role must force a conscious decision here)", () => {
    const policyRoles = [...RLS_POLICY_ROLES.forAll, RLS_POLICY_ROLES.portal].slice().sort();
    const runtimeRoles = [...RUNTIME_ROLES].sort();
    expect(policyRoles).toEqual(runtimeRoles);
  });
});

// ---- STORY-021 · ADR-0001 — computeActorSelfScopedPolicies/generateActorSelfScopedRlsSql --------

describe("STORY-021 · src/db/rls/generate.ts — computeActorSelfScopedPolicies (ADR-0001)", () => {
  it("returns exactly the two ADR-0001 policies, SELECT-only, granted to RLS_POLICY_ROLES.actorSelfScoped, no WITH CHECK", () => {
    const policies = computeActorSelfScopedPolicies(REAL_SCHEMA_TABLES);
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(policy.cmd).toBe("SELECT");
      expect(policy.roles).toEqual(RLS_POLICY_ROLES.actorSelfScoped);
      expect(policy.withCheck).toBeNull();
    }
  });

  it("the workspace_members policy names itself self_membership_workspace_members and checks actor identity only (no status conjunct)", () => {
    const policies = computeActorSelfScopedPolicies(REAL_SCHEMA_TABLES);
    const policy = policies.find((p) => p.table === "workspace_members");
    expect(policy).toBeDefined();
    expect(policy!.policyName).toBe("self_membership_workspace_members");
    expect(policy!.using).toBe("app.current_workspace() IS NULL AND user_id = app.current_actor()");
  });

  it("the workspaces policy names itself self_membership_workspaces and requires an ACTIVE membership via EXISTS", () => {
    const policies = computeActorSelfScopedPolicies(REAL_SCHEMA_TABLES);
    const policy = policies.find((p) => p.table === "workspaces");
    expect(policy).toBeDefined();
    expect(policy!.policyName).toBe("self_membership_workspaces");
    expect(policy!.using).toContain("app.current_workspace() IS NULL AND EXISTS (SELECT 1 FROM workspace_members m");
    expect(policy!.using).toContain("m.status = 'active'::text");
  });

  it("ACTOR_SELF_SCOPED_TABLES is pinned to exactly {workspaces, workspace_members}, and every policy's table is one of them", () => {
    expect(new Set(ACTOR_SELF_SCOPED_TABLES)).toEqual(new Set(["workspaces", "workspace_members"]));
    const policies = computeActorSelfScopedPolicies(REAL_SCHEMA_TABLES);
    for (const policy of policies) {
      expect(ACTOR_SELF_SCOPED_TABLES as readonly string[]).toContain(policy.table);
    }
  });

  // ---- the fail-loud guard clause, both directions --------------------------

  it("throws, naming the missing table, when 'workspaces' is absent from the introspected schema", () => {
    const withoutWorkspaces = REAL_SCHEMA_TABLES.filter((table) => table.name !== "workspaces");
    expect(() => computeActorSelfScopedPolicies(withoutWorkspaces)).toThrow(/ACTOR_SELF_SCOPED_TABLES names "workspaces"/);
  });

  it("throws, naming the missing table, when 'workspace_members' is absent from the introspected schema", () => {
    const withoutMembers = REAL_SCHEMA_TABLES.filter((table) => table.name !== "workspace_members");
    expect(() => computeActorSelfScopedPolicies(withoutMembers)).toThrow(/ACTOR_SELF_SCOPED_TABLES names "workspace_members"/);
  });

  it("does not throw when both ACTOR_SELF_SCOPED_TABLES entries are present in the introspected schema", () => {
    expect(() => computeActorSelfScopedPolicies(REAL_SCHEMA_TABLES)).not.toThrow();
  });
});

describe("STORY-021 · src/db/rls/generate.ts — generateActorSelfScopedRlsSql (ADR-0001)", () => {
  it("carries a header naming ADR-0001 and states it is purely additive to migration 0006", () => {
    const sql = generateActorSelfScopedRlsSql(REAL_SCHEMA_TABLES);
    expect(sql).toMatch(/ADR-0001/);
    expect(sql).toMatch(/Purely additive to migration 0006/);
  });

  it("emits both CREATE POLICY blocks, FOR SELECT TO nominara_app — the role list interpolated from RLS_POLICY_ROLES.actorSelfScoped, not a hardcoded literal", () => {
    const sql = generateActorSelfScopedRlsSql(REAL_SCHEMA_TABLES);
    const expectedRoleList = RLS_POLICY_ROLES.actorSelfScoped.join(", ");
    expect(sql).toMatch(new RegExp(`CREATE POLICY self_membership_workspace_members ON workspace_members\\s*\\n\\s*FOR SELECT TO ${expectedRoleList}`));
    expect(sql).toMatch(new RegExp(`CREATE POLICY self_membership_workspaces ON workspaces\\s*\\n\\s*FOR SELECT TO ${expectedRoleList}`));
  });

  it("emits no WITH CHECK clause for either policy (SELECT-only)", () => {
    const sql = generateActorSelfScopedRlsSql(REAL_SCHEMA_TABLES);
    expect(sql).not.toContain("WITH CHECK");
  });

  it("does not re-emit ENABLE/FORCE ROW LEVEL SECURITY statements (migration 0006 already does — only the header's prose mentions them)", () => {
    const sql = generateActorSelfScopedRlsSql(REAL_SCHEMA_TABLES);
    expect(sql).not.toMatch(/ALTER TABLE \w+ ENABLE ROW LEVEL SECURITY/);
    expect(sql).not.toMatch(/ALTER TABLE \w+ FORCE {2}ROW LEVEL SECURITY/);
  });

  it("propagates computeActorSelfScopedPolicies' own fail-loud throw when a table is missing", () => {
    const withoutWorkspaces = REAL_SCHEMA_TABLES.filter((table) => table.name !== "workspaces");
    expect(() => generateActorSelfScopedRlsSql(withoutWorkspaces)).toThrow(/ACTOR_SELF_SCOPED_TABLES names "workspaces"/);
  });
});

// ---- CP2 decision 1 · ADR-0002 — computeDefinerOwnerPolicies --------------------------------------

describe("CP2 decision 1 · src/db/rls/generate.ts — computeDefinerOwnerPolicies (ADR-0002)", () => {
  it("DEF-U1 · the share-token policy is share_tokens, FOR SELECT, TO nominara_share_lookup only, USING (true), no WITH CHECK", () => {
    expect(computeDefinerOwnerPolicies(REAL_SCHEMA_TABLES).filter((p) => p.roles.includes("nominara_share_lookup"))).toEqual([
      { table: "share_tokens", policyName: "share_token_gate_lookup", cmd: "SELECT", roles: ["nominara_share_lookup"], using: "true", withCheck: null },
    ]);
  });

  it("DEF-U4 · ADR-0004: exactly one policy per table nominara_maintenance reads, FOR SELECT, TO that role only, USING (true), no WITH CHECK", () => {
    const maintenance = computeDefinerOwnerPolicies(REAL_SCHEMA_TABLES).filter((p) => p.roles.includes("nominara_maintenance"));
    expect(maintenance.map((p) => p.table).sort()).toEqual(["answer_captures", "citation_facts", "content_chunks", "corpus_passages", "mention_facts", "topic_clusters", "tracked_prompts"]);
    for (const p of maintenance) {
      expect([p.cmd, p.roles, p.using, p.withCheck]).toEqual(["SELECT", ["nominara_maintenance"], "true", null]);
    }
  });

  it("DEF-U5 · ADR-0004: fails loud when a table the maintenance role reads is absent from the introspected schema", () => {
    const without = REAL_SCHEMA_TABLES.filter((x) => x.name !== "corpus_passages");
    expect(() => computeDefinerOwnerPolicies(without)).toThrow(/corpus_passages/);
  });

  it("DEF-U2 · fails loud when share_tokens is absent from the introspected schema, rather than expecting a policy on nothing", () => {
    const without = REAL_SCHEMA_TABLES.filter((x) => x.name !== "share_tokens");
    expect(() => computeDefinerOwnerPolicies(without)).toThrow(/share_tokens/);
  });

  it("DEF-U3 · the owner role is not one of the runtime roles and appears in no other policy bucket", () => {
    expect(RUNTIME_ROLES as readonly string[]).not.toContain("nominara_share_lookup");
    expect(RUNTIME_ROLES as readonly string[]).not.toContain("nominara_maintenance");
    for (const bucket of [RLS_POLICY_ROLES.forAll, RLS_POLICY_ROLES.actorSelfScoped] as readonly (readonly string[])[]) {
      expect(bucket).not.toContain("nominara_share_lookup");
    }
    expect(RLS_POLICY_ROLES.portal).not.toBe("nominara_share_lookup");
  });
});
