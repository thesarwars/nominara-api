// STORY-122 — which subsystem each table's definition lives in.
//
// project-structure.md §2: "Drizzle pgTable definitions, one file per
// subsystem". A filename heuristic over the migration that happened to
// create a table would put `engines` in with `projects` and `sessions` in
// with `plans`, because migrations are grouped by when they were needed and
// subsystems by what they mean. So the assignment is an explicit list,
// reviewed like GLOBAL_TABLES is, and src/db/schema/generate.ts REFUSES to
// generate for a table that is not in it — a new table lands in a named
// file or it does not land at all. There is no default bucket.

export const SCHEMA_SUBSYSTEMS = {
  identity: [
    "users",
    "user_credentials",
    "sessions",
    "refresh_tokens",
    "webauthn_challenges",
    "oauth_authorization_requests",
    "email_otp_codes",
    "email_otp_requests",
  ],
  tenancy: [
    "workspaces",
    "workspace_keys",
    "workspace_members",
    "workspace_invitations",
    "sso_configurations",
    "api_keys",
    "support_grants",
  ],
  billing: [
    "plans",
    "subscriptions",
    "subscription_addons",
    "credit_wallets",
    "credit_daily_counters",
    "credit_ledger",
    "credit_hold_carries",
    "credit_packs",
    "credit_purchases",
    "usage_counters",
    "usage_ledger",
    "usage_reservations",
    "invoices",
    "stripe_webhook_events",
    "stripe_subscription_syncs",
    "downgrade_notices",
  ],
  projects: ["projects", "project_engines", "competitors", "domain_verifications"],
  prompts: ["tracked_prompts", "prompt_stability", "topic_clusters"],
  captures: [
    "engines",
    "engine_health",
    "capture_runs",
    "answer_captures",
    "mention_facts",
    "citation_facts",
    "displacement_events",
  ],
  rollups: ["metric_daily", "milestones", "notifications", "notification_reads", "notification_emails", "platform_metrics", "niche_reports", "ref_counters"],
  aux: ["aux_rule_catalog", "aux_audits", "aux_findings", "source_domains", "project_source_index"],
  tasks: ["task_generation_rules", "tasks", "goals", "task_events"],
  geo: [
    "geo_analyses",
    "entity_nodes",
    "geo_alignments",
    "content_chunks",
    "corpus_passages",
    "semantic_nodes",
    "patches",
  ],
  tools: [
    "tool_runs",
    "attribution_configs",
    "attribution_daily",
    "attribution_url_rollup",
    "gsc_connections",
    "gsc_daily",
    "brand_themes",
    "custom_domains",
    "share_tokens",
    "share_token_views",
    "scheduled_reports",
    "report_artifacts",
    "scheduled_report_deliveries",
  ],
  platform: ["audit_log", "audit_chain_marks", "purge_failures"],
} as const satisfies Record<string, readonly string[]>;

export type SchemaSubsystem = keyof typeof SCHEMA_SUBSYSTEMS;

/** table name → subsystem, built from the list above so the two can never disagree. */
export const SUBSYSTEM_BY_TABLE: ReadonlyMap<string, SchemaSubsystem> = new Map(
  Object.entries(SCHEMA_SUBSYSTEMS).flatMap(([subsystem, tables]) =>
    tables.map((table) => [table, subsystem as SchemaSubsystem] as const),
  ),
);
