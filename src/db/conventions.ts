// The canonical source of truth for what the migration chain is required to
// produce, updated by any story that extends the shared foundation (STORY-006
// introduced this file; STORY-007 added reject_mutation). src/db/drift-check.ts
// introspects a shadow database after applying every committed migration and
// fails the build if reality diverges from this list — this is what makes the
// list, not the SQL files, the thing engineers edit first when the foundation
// needs to change.

export const REQUIRED_EXTENSIONS = [
  "pgcrypto", // cryptographic functions
  "citext", // case-insensitive text
  "vector", // pgvector — embeddings
  "pg_trgm", // trigram search
  "btree_gin", // composite index support
  "pg_stat_statements", // statement statistics
] as const;

// data-model.md §1 "Extensions and shared helpers" — STORY-011 adds the
// tenant-context accessor functions into this same schema.
export const INTERNAL_SCHEMA = "app";

export const REQUIRED_INTERNAL_FUNCTIONS = [
  "touch_updated_at",
  "assert_jsonb_size",
  "reject_mutation", // STORY-007 — generic append-only guard, first used by credit_ledger
  "breakglass_login_alert", // STORY-010 — ON login event trigger function; drift-check must notice if it disappears
  // STORY-011 — security-and-tenancy.md §3's three context accessor
  // functions, verbatim. STABLE + PARALLEL SAFE so the planner can inline
  // them into every generated policy's USING/WITH CHECK clause.
  "current_workspace",
  "current_actor",
  "current_scope_projects",
  // STORY-011 — the reusable partition-RLS-application function
  // (src/db/rls/generate.ts's partition DO block calls this once per
  // discovered partition child). STORY-013's monthly partition-maintenance
  // job is the next consumer: exactly one call per new partition, or the
  // partition reopens the RLS bypass this story found and fixed.
  "apply_tenant_rls",
] as const;

// STORY-009 — data-model.md §2 "Table census", verbatim. The census
// assertion (69 tables: 59 tenant-scoped, 10 global) depends on this
// partition being exact, so a new table is either tenant-scoped with RLS or
// an explicit, reviewed addition here — there is no third option.
// STORY-011's src/db/rls/generate.ts should import GLOBAL_TABLES and
// TENANT_SCOPE_COLUMN from here rather than redeclaring them, so the
// generator and the census assertion can never silently diverge.
export const GLOBAL_TABLES = [
  "users", // global identity; owns no data rows
  "user_credentials", // protected by GRANT, not RLS — see security-and-tenancy §1
  "plans",
  "engines", // billing + adapter catalogs
  "credit_packs", // purchasable add-on catalog
  "platform_metrics", // k>=20 anonymised cross-tenant benchmarks
  "niche_reports", // public marketing content, written only by a batch job
  "aux_rule_catalog",
  "task_generation_rules", // versioned reference catalogs
  "engine_health", // vendor reliability telemetry, not tenant data
] as const;

// workspaces is scoped by its own `id`, not a `workspace_id` column — declared
// explicitly so the tenant-scope assertion stays fail-closed rather than
// silently excluding it.
//
// Frozen (Object.freeze + `as const`) — unlike this file's other exported
// constants, this one was a mutable Record, which is out of place for a
// load-bearing input to BOTH src/db/rls/generate.ts (the RLS generator) and
// src/db/rls/rls-check.ts (the drift checker): a stray runtime mutation here
// would make the generator and the checker silently agree on a wrong answer
// together, rather than disagree loudly.
export const TENANT_SCOPE_COLUMN: Readonly<Record<string, string>> = Object.freeze({ workspaces: "id" } as const);

// STORY-009 AC "no ordering column exists anywhere" (tasks specifically —
// no hand-authored ordering/priority-lane column may exist on tasks or
// task_events). Two patterns, single source of truth so integration specs
// import rather than retype the regex (retyping risks drift between the scan
// and its own test of the scan):
//
// - ORDER_COLUMN_PATTERN: word-boundary-ish match on "order"/"ordering"
//   only. Applied to every table this story's migration creates.
// - WIDE_ORDER_COLUMN_PATTERN: also matches ordinal/sort/sequence/rank/
//   position/lane/slot/index as whole segments. Reserved for `tasks` and
//   `task_events` specifically — the two tables where a hand-authored
//   ordering column would actually defeat the AC's intent — because
//   broadening it to every table in the migration would false-positive on
//   legitimate, unrelated columns such as rank_position, chunk_index,
//   passage_index, or priority_rank that happen to live on other tables.
export const ORDER_COLUMN_PATTERN = /(^|_)(order|ordering)(_|$)/;
export const WIDE_ORDER_COLUMN_PATTERN =
  /(^|_)(order|ordering|ordinal|sort|sequence|rank|position|lane|slot|index)(_|$)/;

// STORY-010 — security-and-tenancy.md §2 "Database roles", verbatim, plus the
// two corrections recorded in STORY-010's Technical Notes (ALTER DEFAULT
// PRIVILEGES and the audit_log sequence grant). The single source of truth
// for role names/attributes so the migration, the drift checker, and every
// integration test assert against the same catalog rather than retyped
// literals that could silently drift apart.

export const MIGRATION_OWNER_ROLE = "nominara_owner";
export const BREAKGLASS_ROLE = "nominara_breakglass";

// Ordered src/api, src/gateway, src/workers/*, replica-only reporting,
// share-token portal — matches the comments in security-and-tenancy.md §2.
export const RUNTIME_ROLES = ["nominara_app", "nominara_worker", "nominara_report", "nominara_portal"] as const;

export type RuntimeRole = (typeof RUNTIME_ROLES)[number];

export interface DatabaseRoleSpec {
  /** Whether the role can open its own connection at all. */
  login: boolean;
  /** Whether the role bypasses row-level security (§3). Exactly one role may. */
  bypassrls: boolean;
  /** pg_roles.rolconnlimit — -1 means unlimited (the migration owner, never a running service). */
  connectionLimit: number;
  /**
   * pg_roles.rolinherit — every role in this project is created NOINHERIT
   * (security-relevant: an inheriting role silently picks up the privileges
   * of every role it is a member of, without an explicit SET ROLE). Added
   * post-review (fix pass item 9) so drift-check actually notices a
   * hand-altered INHERIT the same way it already notices BYPASSRLS.
   */
  inherit: boolean;
}

export const DATABASE_ROLES: Record<string, DatabaseRoleSpec> = {
  [MIGRATION_OWNER_ROLE]: { login: false, bypassrls: false, connectionLimit: -1, inherit: false },
  nominara_app: { login: true, bypassrls: false, connectionLimit: 400, inherit: false },
  nominara_worker: { login: true, bypassrls: false, connectionLimit: 300, inherit: false },
  nominara_report: { login: true, bypassrls: false, connectionLimit: 40, inherit: false },
  nominara_portal: { login: true, bypassrls: false, connectionLimit: 60, inherit: false },
  [BREAKGLASS_ROLE]: { login: true, bypassrls: true, connectionLimit: 2, inherit: false },
};

// STORY-011 — schemas/README.md "Tenancy" section's portal-readable
// enumeration, REVISED (fix pass STORY-011-E-2 — see that story's
// Implementation Decisions section) to 18 entries, down from the doc's
// literal 20: `source_domains` and `brand_themes` are workspace-scoped-only
// tables with no `project_id` column, so their portal policy could only ever
// filter by workspace, never by project. security-and-tenancy.md's own
// ISO-09 requires a share-token session be unable to read a project outside
// its scope "even within the same workspace", and AC 26 explicitly disallows
// enforcing portal scope via a join — so a project-scoped share token in an
// agency workspace with two competing clients as separate projects could
// enumerate EVERY domain/theme in the workspace, including ones that only
// ever appeared in a project outside the token's scope. Removed from this
// list rather than shipped with that gap; revisited by a future story with a
// real product requirement (e.g. a `project_id` column, or a join the AC
// would need to be revised to permit). src/db/rls/generate.ts imports this
// rather than redeclaring it, so the generator and this list can never
// silently diverge.
export const PORTAL_READABLE_TABLES = [
  "projects",
  "competitors",
  "tracked_prompts",
  "answer_captures",
  "mention_facts",
  "citation_facts",
  "metric_daily",
  "milestones",
  "aux_audits",
  "aux_findings",
  "displacement_events",
  "tasks",
  "goals",
  "project_source_index",
  "topic_clusters",
  "geo_analyses",
  "entity_nodes",
  "attribution_url_rollup",
] as const;

// security-and-tenancy.md §3's own `portal_scope_projects` example policy
// scopes by the table's own `id`, not a `project_id` column — `projects` is
// the only portal-readable table where that applies, declared explicitly
// (mirroring TENANT_SCOPE_COLUMN's own workspaces exception) rather than
// special-cased in src/db/rls/generate.ts.
export const PORTAL_SELF_SCOPED_TABLES = ["projects"] as const;

// STORY-011 — which runtime roles receive which generated policy. Every
// FOR ALL ws_isolation_* policy is granted to `forAll`; every portal_scope_*
// SELECT-only policy is granted to `portal`. Kept here as declared data
// (not literals inside generate.ts) so a future 5th runtime role forces a
// conscious decision about which bucket it belongs to — see this file's own
// test asserting RLS_POLICY_ROLES stays consistent with RUNTIME_ROLES.
export const RLS_POLICY_ROLES = {
  forAll: ["nominara_app", "nominara_worker", "nominara_report"] as const,
  portal: "nominara_portal" as const,
};

export type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";

const FULL_WRITE: readonly TablePrivilege[] = ["SELECT", "INSERT", "UPDATE", "DELETE"];
const READ_ONLY: readonly TablePrivilege[] = ["SELECT"];
const APPEND_ONLY: readonly TablePrivilege[] = ["SELECT", "INSERT"];
const NO_PRIVILEGES: readonly TablePrivilege[] = [];

// The census-driven ACL matrix (STORY-010 task 14): every table gets the
// blanket read-write/read-only split EXCEPT the two grant-level exceptions
// called out by security-and-tenancy.md §1/§2 — user_credentials (reachable
// only by the auth path, nominara_app) and audit_log (append-only: insert
// and select, never update or delete, for the two write-capable roles).
export function expectedTablePrivileges(role: string, table: string): readonly TablePrivilege[] {
  if (table === "user_credentials") {
    return role === "nominara_app" ? FULL_WRITE : NO_PRIVILEGES;
  }
  if (table === "audit_log") {
    if (role === "nominara_app" || role === "nominara_worker") return APPEND_ONLY;
    if (role === "nominara_report" || role === "nominara_portal") return READ_ONLY;
    return NO_PRIVILEGES;
  }
  if (role === "nominara_app" || role === "nominara_worker") return FULL_WRITE;
  if (role === "nominara_report" || role === "nominara_portal") return READ_ONLY;
  return NO_PRIVILEGES;
}
