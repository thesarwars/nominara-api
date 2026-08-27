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

// STORY-009 — data-model.md §2 "Table census", verbatim (STORY-017 update:
// 73 tables, 59 tenant-scoped, 14 global; STORY-015 update: 74 tables, 59
// tenant-scoped, 15 global; STORY-016 update: 76 tables, 59 tenant-scoped,
// 17 global). The census assertion depends on
// this partition being exact, so a new table is either tenant-scoped with RLS or
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
  // STORY-013 — release-train deploy-gate telemetry (src/db/purge-check.ts),
  // same class as engine_health: platform ops state, not tenant data, and
  // written by a job with no single tenant context. Migration
  // 0007_partition_maintenance_and_retention.up.sql.
  "purge_failures",
  // STORY-014 — WebAuthn ceremony state (challenge/rp_id/origin), not tenant
  // data, GRANT-protected the same way as user_credentials (see
  // expectedTablePrivileges below). Migration
  // 0008_identity_authenticator_attachment.up.sql.
  "webauthn_challenges",
  // STORY-017 — session identity state: a `sid` stays stable across a
  // workspace switch, so this is not tenant data, same reasoning as
  // user_credentials. GRANT-protected the same way. Migration
  // 0009_session_model_and_refresh_tokens.up.sql.
  "sessions",
  "refresh_tokens",
  // STORY-015 — the OAuth state parameter's server-held payload (PKCE
  // verifier, session-binding hash) for an in-flight authorization-code
  // flow. Not tenant data — resolved before any workspace context exists —
  // and GRANT-protected the same way as user_credentials/
  // webauthn_challenges/sessions: only the auth path (nominara_app) ever
  // reads a live PKCE verifier. Migration
  // 0013_oauth_authorization_requests.up.sql.
  "oauth_authorization_requests",
  // STORY-016 — email OTP (fallback sign-in). Both new tables are pre-tenant
  // auth-path state, not tenant data, GRANT-protected the same way as
  // user_credentials/webauthn_challenges: email_otp_codes holds a live
  // Argon2id code hash per user, and email_otp_requests is the rate-limit
  // ledger keyed on a peppered email hash — deliberately NOT linked to
  // `users`, since it must accept addresses with no account. Migration
  // 0014_email_otp.up.sql.
  "email_otp_codes",
  "email_otp_requests",
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

// STORY-120 — the migration ledger (src/db/migrate-runner.ts's BOOTSTRAP_SQL)
// lives in its OWN schema, outside the `public` census that
// expectedTablePrivileges below describes, so it needs its own declared
// expectation or nothing asserts it at all. Migration 0005 granted
// `USAGE ON SCHEMA app, public` and never `_migrations`, which is why
// readiness — which compares the applied set against the build's own — could
// never succeed for the role that actually serves.
export const MIGRATION_LEDGER_SCHEMA = "_migrations";
export const MIGRATION_LEDGER_TABLE = "_migrations.applied";

/**
 * The runtime roles that may READ the ledger, and by omission the ones that
 * may not. Each was decided, not defaulted:
 *
 * - `nominara_app`  — YES. It is the pooled connection behind `/health/ready`
 *   (docker-compose.yml, .env.example), and readiness must report what the
 *   APPLICATION's own connection can see or it is a probe for the migration
 *   tool instead.
 * - `nominara_worker` — NO. Workers expose no readiness probe today (there is
 *   no worker service in docker-compose.yml, and src/worker.ts builds an
 *   application CONTEXT with no HTTP listener). When one is added, adding
 *   the role here is that story's decision to make deliberately. Note the
 *   worker also opens its pool from DATABASE_URL_POOLED, which is
 *   `nominara_app` today — so this row is a statement of intent about the
 *   role, not a description of a connection any process currently makes.
 * - `nominara_report` — NO. Read-only and replica-only; it serves no probe.
 * - `nominara_portal` — NO. The share-token portal serves no probe, and the
 *   ledger is platform state that a share-token session has no claim on.
 *
 * READ means exactly `USAGE` on the schema plus `SELECT` on the ledger. No
 * runtime role may write it: an application that can rewrite the record of
 * its own schema version can lie to its own readiness probe.
 */
export const MIGRATION_LEDGER_READERS: readonly RuntimeRole[] = ["nominara_app"];

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

// STORY-021 — ADR-0001 "Actor-self-scoped RLS policy class for cross-
// workspace self-reads". Pinned to exactly these two tables; extending this
// list is a new decision, not a precedent the ADR pre-approves. Consumed by
// a SEPARATE policy branch in src/db/rls/generate.ts
// (computeActorSelfScopedPolicies) from the ws_isolation_*/portal_scope_*
// branches, and by src/tenancy/query-guard.ts's actor-only-mode allow-list.
export const ACTOR_SELF_SCOPED_TABLES = ["workspaces", "workspace_members"] as const;

// STORY-011 — which runtime roles receive which generated policy. Every
// FOR ALL ws_isolation_* policy is granted to `forAll`; every portal_scope_*
// SELECT-only policy is granted to `portal`. Kept here as declared data
// (not literals inside generate.ts) so a future 5th runtime role forces a
// conscious decision about which bucket it belongs to — see this file's own
// test asserting RLS_POLICY_ROLES stays consistent with RUNTIME_ROLES.
export const RLS_POLICY_ROLES = {
  forAll: ["nominara_app", "nominara_worker", "nominara_report"] as const,
  portal: "nominara_portal" as const,
  // STORY-021 — ADR-0001's self_membership_* policies are granted TO
  // nominara_app ONLY, never the other forAll roles (a background worker or
  // reporting replica has no actor session to key a self-read off of).
  actorSelfScoped: ["nominara_app"] as const,
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
// STORY-013 — data-model.md §5 partitioning / §8 vacuum and maintenance.
// PARTITIONED_FACT_TABLES is the single source of truth src/workers/rollup/
// maintenance.ts and retention.ts both import, rather than three separate
// hand-typed literal arrays that could silently drift apart.
export const PARTITIONED_FACT_TABLES = ["answer_captures", "mention_facts", "citation_facts"] as const;
export type PartitionedFactTable = (typeof PARTITIONED_FACT_TABLES)[number];

/** How many months AHEAD of the current month app.ensure_partitions-equivalent logic creates — data-model.md §5. */
export const PARTITION_LEAD_MONTHS = 3;

/** data-model.md §8 step 2 — partitions older than this move to COLD_TABLESPACE with fillfactor=100. */
export const HOT_WINDOW_DAYS = 90;

/** data-model.md §8 step 2. Provisioned outside migrations (a physical filesystem location, environment-specific — see this story's Implementation Decisions), never created by a portable migration. */
export const COLD_TABLESPACE = "cold_tier";

export interface VacuumTuning {
  readonly vacuumScaleFactor: number;
  readonly analyzeScaleFactor: number;
  readonly fillfactor?: number;
  readonly vacuumThreshold?: number;
  readonly analyzeThreshold?: number;
}

// data-model.md §8 — "autovacuum_vacuum_scale_factor = 0.02 and
// autovacuum_analyze_scale_factor = 0.01" on all six; usage_counters and
// credit_wallets additionally get fillfactor=70 (already applied at table
// creation, migration 0002) plus "a dedicated aggressive threshold" the
// reference names but does not number — see this story's Implementation
// Decisions section for the chosen values (25/25, half Postgres's own
// default of 50).
export const VACUUM_TUNED_TABLES: Readonly<Record<string, VacuumTuning>> = Object.freeze({
  answer_captures: { vacuumScaleFactor: 0.02, analyzeScaleFactor: 0.01 },
  mention_facts: { vacuumScaleFactor: 0.02, analyzeScaleFactor: 0.01 },
  citation_facts: { vacuumScaleFactor: 0.02, analyzeScaleFactor: 0.01 },
  metric_daily: { vacuumScaleFactor: 0.02, analyzeScaleFactor: 0.01 },
  usage_counters: { vacuumScaleFactor: 0.02, analyzeScaleFactor: 0.01, fillfactor: 70, vacuumThreshold: 25, analyzeThreshold: 25 },
  credit_wallets: { vacuumScaleFactor: 0.02, analyzeScaleFactor: 0.01, fillfactor: 70, vacuumThreshold: 25, analyzeThreshold: 25 },
});

export interface HnswIndexedTable {
  readonly table: string;
  readonly column: string;
  readonly indexName: string;
}

// data-model.md §6 "Vector ANN" — deliberately excludes semantic_nodes (E-3
// known defect, STORY-009: that table's literal DDL has neither an HNSW
// index nor an embedding_model column, diverging from the reference table).
export const HNSW_INDEXED_TABLES: readonly HnswIndexedTable[] = [
  { table: "tracked_prompts", column: "embedding", indexName: "ix_prompts_embedding" },
  { table: "topic_clusters", column: "centroid", indexName: "ix_topic_clusters_hnsw" },
  { table: "content_chunks", column: "embedding", indexName: "ix_content_chunks_hnsw" },
  { table: "corpus_passages", column: "embedding", indexName: "ix_corpus_hnsw" },
] as const;

/** data-model.md §8 step 4 — "regressed below 0.98". */
export const VECTOR_RECALL_THRESHOLD = 0.98;

/** data-model.md §8 step 4 — "rebuilding with ef_construction = 128". */
export const HNSW_REBUILD_EF_CONSTRUCTION = 128;

export function expectedTablePrivileges(role: string, table: string): readonly TablePrivilege[] {
  if (
    table === "user_credentials" ||
    table === "webauthn_challenges" ||
    table === "sessions" ||
    table === "refresh_tokens" ||
    table === "oauth_authorization_requests" ||
    table === "email_otp_codes" ||
    table === "email_otp_requests"
  ) {
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
