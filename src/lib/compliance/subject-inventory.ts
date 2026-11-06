// STORY-111 / NFR-CMP-02 - the subject-request inventory, derived from the SAME metadata that generates the isolation policies.
//
// `TENANT_TABLES` (src/db/rls/tenant-tables.generated.ts) is produced by `pnpm db:rls-generate` from the live schema: it is the set of
// tables that hold tenant data. This registry must carry an explicit disposition for EVERY member of it, so a table added six months from
// now fails `subject-inventory.spec.ts` (and so the build) until someone decides whether it holds personal data. A default of "export" is
// deliberately NOT applied: a missing entry is a failure, not a silent inclusion or omission.
//
// "export": rows referencing the subject are exported. The columns are NOT listed here - they are discovered from the database (every
//   foreign key to users(id) on the table) plus `extraColumns` for the two actor columns that carry no foreign key because their tables are
//   append-only and partitioned/hash-chained. A new user-referencing column on an export table is therefore picked up automatically.
// "exempt": holds workspace business data or aggregates with no person reference. The integration test (subject-request.int.spec.ts)
//   fails if an exempt table gains a foreign key to users, so an exemption cannot go stale silently.

export type InventoryEntry =
  | { readonly disposition: "export"; readonly extraColumns?: readonly string[] }
  | { readonly disposition: "exempt"; readonly reason: string };

const AGGREGATE = "Aggregated measurement or counter keyed by workspace and project; references no person.";
const WORKSPACE_CONFIG = "Workspace configuration or business data keyed by workspace; references no person.";
const DERIVED = "Derived analysis recomputable from facts; references no person.";

function exempt(reason: string): InventoryEntry {
  return { disposition: "exempt", reason };
}
const exported: InventoryEntry = { disposition: "export" };

export const SUBJECT_INVENTORY: Readonly<Record<string, InventoryEntry>> = Object.freeze({
  answer_captures: exported,
  api_keys: exported,
  attribution_configs: exported, // created_by references users
  attribution_daily: exempt("Aggregated at ingest: counts only, never per-visitor data (NFR-CMP-12), so there is no subject surface."),
  attribution_url_rollup: exempt(AGGREGATE),
  // actor_id has no foreign key (the table is append-only and hash-chained); the pseudonymised actor survives erasure.
  audit_log: { disposition: "export", extraColumns: ["actor_id"] },
  aux_audits: exported,
  aux_findings: exempt(DERIVED),
  brand_themes: exported,
  capture_runs: exported,
  citation_facts: exempt("Fact row about a cited URL in an engine answer; references no person."),
  competitors: exported,
  content_chunks: exempt("Chunk of the customer's own crawled pages; references no person."),
  corpus_passages: exempt("Passage of the customer's own crawled pages; references no person."),
  credit_daily_counters: exempt(AGGREGATE),
  credit_hold_carries: exempt(AGGREGATE),
  credit_ledger: { disposition: "export", extraColumns: ["actor_id"] },
  credit_purchases: exported,
  credit_wallets: exempt("Balance row keyed by workspace; references no person."),
  custom_domains: exported,
  displacement_events: exported,
  domain_verifications: exported,
  downgrade_notices: exported,
  entity_nodes: exempt(DERIVED),
  geo_alignments: exported,
  geo_analyses: exported,
  goals: exported,
  gsc_connections: exported,
  gsc_daily: exempt(AGGREGATE),
  invoices: exempt("Financial record keyed by workspace; retained under accounting law (NFR-CMP-07); references no person."),
  mention_facts: exempt("Fact row about an entity mentioned in an engine answer; references no person of this product."),
  metric_daily: exempt(AGGREGATE),
  milestones: exported,
  notification_emails: exported,
  notification_reads: exported,
  notifications: exported,
  patches: exported,
  project_engines: exempt(WORKSPACE_CONFIG),
  project_source_index: exempt(DERIVED),
  projects: exported,
  prompt_stability: exempt(AGGREGATE),
  ref_counters: exempt("Sequence counter keyed by workspace; references no person."),
  report_artifacts: exported,
  scheduled_report_deliveries: exported,
  scheduled_reports: exported,
  semantic_nodes: exempt(DERIVED),
  share_token_views: exported,
  share_tokens: exported,
  source_domains: exempt(WORKSPACE_CONFIG),
  sso_configurations: exported,
  stripe_subscription_syncs: exempt("Billing sync log keyed by workspace; references no person."),
  subscription_addons: exported, // created_by references users
  subscriptions: exempt("Billing state keyed by workspace; references no person."),
  support_grants: exported,
  task_events: exported,
  task_verifications: exempt("Re-measurement schedule row; references no person."),
  tasks: exported,
  tool_runs: exported,
  topic_clusters: exempt(DERIVED),
  tracked_prompts: exported,
  usage_counters: exempt(AGGREGATE),
  usage_ledger: exempt(AGGREGATE),
  usage_reservations: exempt(AGGREGATE),
  workspace_invitations: exported,
  workspace_keys: exempt("Wrapped key material keyed by workspace; never exported, references no person."),
  workspace_members: exported,
  workspaces: exported,
});

/** Tenant tables the isolation policies cover that have NO entry here. Non-empty = the build fails. */
export function unregisteredTenantTables(tenantTables: ReadonlySet<string>): string[] {
  return [...tenantTables].filter((table) => !(table in SUBJECT_INVENTORY)).sort();
}

/** Entries for tables the isolation policies no longer cover. Non-empty = the build fails (a dead entry hides a rename). */
export function staleInventoryEntries(tenantTables: ReadonlySet<string>): string[] {
  return Object.keys(SUBJECT_INVENTORY).filter((table) => !tenantTables.has(table)).sort();
}
