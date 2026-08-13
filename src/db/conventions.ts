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
export const TENANT_SCOPE_COLUMN: Record<string, string> = { workspaces: "id" };

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
