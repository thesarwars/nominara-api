// STORY-111 / NFR-CMP-02 - the subject-request inventory, derived from the SAME metadata that generates the isolation policies.
//
// `TENANT_TABLES` (src/db/rls/tenant-tables.generated.ts) is produced by `pnpm db:rls-generate` from the live schema: it is the set of
// tables that hold tenant data. This registry must carry an explicit disposition for EVERY member of it, so a table added six months from
// now fails `subject-inventory.spec.ts` (and so the build) until someone decides whether it holds personal data. A default of "export" is
// deliberately NOT applied: a missing entry is a failure, not a silent inclusion or omission.
//
// "export": rows referencing the subject are exported, and the export is DEFAULT-DENY. A column is exported only when this registry declares
//   it exportable (`columns`); every other column of the table must be named in `omit` (credential material, hashes, and other people's personal
//   data). `compliance-retention.spec.ts` compares the live catalogue with `columns` + `omit` and fails on a column in NEITHER list, so a column
//   added later is unexported until a person decides, instead of leaking by default. `subject-inventory.spec.ts` fails if a column that looks
//   like credential material (`*_enc`, `*credential*`, hash, token, secret ...) is in `columns`.
//   WHICH ROWS: by default every row where a foreign key to users(id) (discovered from the catalogue) or one of `extraColumns` (the two actor
//   columns with no foreign key) equals the subject; `subjectColumns` narrows that to the columns that make the subject the data subject
//   (workspace_members.user_id, not invited_by - that would export every member the subject invited). Whatever the row, a user id in it that is NOT
//   the subject's is exported as null: another person's identifier is not the subject's data (GDPR Art. 15(4)).
// "exempt": holds workspace business data or aggregates with no person reference. The integration test (compliance-retention.spec.ts)
//   fails if an exempt table gains a foreign key to users, so an exemption cannot go stale silently.

export type InventoryEntry =
  | {
      readonly disposition: "export";
      /** Declared exportable. */
      readonly columns: readonly string[];
      /** Named as omitted: credential material, hashes, other people's personal data. */
      readonly omit: readonly string[];
      readonly extraColumns?: readonly string[];
      readonly subjectColumns?: readonly string[];
    }
  | { readonly disposition: "exempt"; readonly reason: string };

const AGGREGATE = "Aggregated measurement or counter keyed by workspace and project; references no person.";
const WORKSPACE_CONFIG = "Workspace configuration or business data keyed by workspace; references no person.";
const DERIVED = "Derived analysis recomputable from facts; references no person.";

function exempt(reason: string): InventoryEntry {
  return { disposition: "exempt", reason };
}

const words = (list: string): string[] => list.split(" ").filter((w) => w !== "");

const EXPORT_COLUMNS: Readonly<Record<string, { readonly columns: string; readonly omit: string }>> = {
  answer_captures: {
    columns:
      "id workspace_id project_id run_id prompt_id engine_key sample_index captured_at capture_mode adapter_version model_fingerprint normalizer_version latency_ms truncated async_generated raw_object_key response_excerpt payload brand_present brand_rank_position sov sentiment_label sentiment_score citation_count owned_citation_count flags cache_layer source_result_id scoring_version status error_code created_at",
    omit: "response_tokens_est content_hash alias_fingerprint",
  },
  api_keys: {
    columns:
      "id workspace_id name key_prefix permissions project_scope created_by last_used_at last_used_ip expires_at revoked_at created_at",
    omit: "key_hash",
  },
  attribution_configs: {
    columns:
      "id workspace_id project_id method allowed_origins ga4_property_id conversion_events status first_event_at last_event_at created_by created_at updated_at",
    omit: "site_token site_token_hash ga4_credentials_enc dek_id",
  },
  audit_log: {
    columns:
      "seq workspace_id occurred_at actor_type actor_id actor_ip actor_ua action resource_type resource_id request_id support_grant_id severity",
    omit: "before_state after_state prev_hash row_hash",
  },
  aux_audits: {
    columns:
      "id workspace_id project_id trigger triggered_by scope target_urls pages_crawled pages_failed excluded_rules robots_snapshot llms_txt_present sitemap_url_count aux_score score_capped score_breakdown findings_critical findings_high findings_medium findings_low rule_version dom_object_prefix status error_summary started_at finished_at created_at",
    omit: "robots_hash tokenizer request_hash",
  },
  capture_runs: {
    columns:
      "id workspace_id project_id trigger triggered_by engine_keys prompt_scope scope_ref planned_cells skipped_cells captured_cells failed_cells scoring_version status error_summary started_at finished_at created_at retry_of",
    omit: "",
  },
  competitors: {
    columns:
      "id workspace_id project_id name aliases root_domain is_primary source detected_count visibility_blended created_at updated_at deleted_at",
    omit: "",
  },
  credit_ledger: {
    columns:
      "id workspace_id project_id actor_id actor_type entry_type action_code credits bucket included_after purchased_after reserved_after reference_type reference_id idempotency_key unit_detail internal_cost_usd reason occurred_at attempt seq actor_pseudonym",
    omit: "",
  },
  credit_purchases: {
    columns:
      "id workspace_id pack_key credits amount_usd source stripe_payment_intent_id stripe_invoice_id status expires_at purchased_by created_at updated_at",
    omit: "",
  },
  custom_domains: {
    columns:
      "id workspace_id hostname purpose cname_target dns_cname_verified_at dns_txt_verified_at cert_status cert_expires_at last_check_at last_error status created_at updated_at",
    omit: "verification_token cert_arn",
  },
  displacement_events: {
    columns:
      "id workspace_id project_id prompt_id engine_key detected_at kind before_result_id after_result_id before_position after_position before_position_class after_position_class displaced_by citation_gap concept_gap impact_score task_id acknowledged_at recovered_at scoring_version dismissed_at dismissed_by",
    omit: "",
  },
  domain_verifications: {
    columns:
      "id workspace_id project_id domain method nonce verified_at last_checked_at failure_reason created_at inconclusive_since",
    omit: "",
  },
  downgrade_notices: {
    columns:
      "id workspace_id request_id kind recipient subject text_body created_at sent_at",
    omit: "",
  },
  retention_exports: {
    columns: "id workspace_id requested_by status coverage error_code expires_at ready_at emailed_at created_at updated_at object_purged_at scope",
    omit: "object_key",
  },
  geo_alignments: {
    columns:
      "id workspace_id project_id task_id target_url prompt_cluster_id engine_keys embedding_model embedding_dims centroid_source_count centroid_domains live_content_md draft_content_md baseline_alignment current_alignment target_band_low target_band_high percentile_vs_corpus coverage_ratio recommendations status created_by created_at updated_at",
    omit: "centroid analysis_state analysis_reason draft_state draft_recompute_due_at page_structure",
  },
  geo_analyses: {
    columns:
      "workspace_id project_id analysis window_start window_days score score_label evidence_cells evidence_passages sufficient suppression_reason findings lever_rank scoring_version computed_at",
    omit: "",
  },
  goals: {
    columns:
      "id workspace_id project_id title kind target baseline current progress_pct target_date status achieved_at created_by created_at updated_at",
    omit: "",
  },
  gsc_connections: {
    columns:
      "id workspace_id project_id property_url property_type scopes last_sync_at last_sync_date backfill_completed health_status last_error created_by created_at updated_at revoked_at",
    omit: "credentials_enc dek_id refresh_enc token_expires_at",
  },
  milestones: {
    columns:
      "id workspace_id project_id occurred_at kind title detail icon severity source_type source_id affected_engines affected_prompt_cluster measured_impact visible_in_portal created_by created_at",
    omit: "",
  },
  notification_emails: {
    columns:
      "id workspace_id user_id kind dedupe_key notification_id cadence period_start period_end notification_count status subject text_body created_at sent_at",
    omit: "",
  },
  notification_reads: {
    columns:
      "workspace_id notification_id user_id read_at",
    omit: "",
  },
  notifications: {
    columns:
      "id workspace_id project_id user_id kind severity title body payload channels read_at dispatched_at created_at event_key",
    omit: "",
  },
  patches: {
    columns:
      "id workspace_id project_id session_id finding_id target_url kind unified_diff content_after jsonld_blocks reversal risk_flags applied_node_ids alignment_before alignment_projected created_by created_at rule_code requires_human_review review_reason explanation derivation preconditions",
    omit: "content_before_hash",
  },
  projects: {
    columns:
      "id workspace_id name slug kind parent_project_id root_url root_domain owned_domains brand_aliases negative_aliases category_slug verticals locale description cadence priority_prompt_limit next_run_at last_run_at discovery discovery_status fingerprint domain_verified_at visibility_blended visibility_by_engine visibility_delta_30d rendering_quality entity_authority aux_score_current source_coverage sparkline_30d open_task_count prompts_active prompts_cap status created_by created_at updated_at deleted_at rendering_delta_30d sentiment_score sentiment_delta_30d cells_30d open_tasks_by_severity demo_seeded_at paused_by_downgrade_at paused_by_downgrade_from benchmark_category_slug benchmark_category_applied_at",
    omit: "",
  },
  report_artifacts: {
    columns:
      "id workspace_id scheduled_report_id project_ids period_start period_end format object_key bytes methodology_footer download_count expires_at created_at link_revoked_at quarantined_at",
    omit: "link_token_hash",
  },
  scheduled_report_deliveries: {
    columns:
      "id workspace_id scheduled_report_id attempted_at status reason recipient_count report_artifact_id",
    omit: "",
  },
  scheduled_reports: {
    columns:
      "id workspace_id name project_ids cadence day_of_period send_hour_local timeframe format theme_id include_sections last_sent_at last_error next_send_at active created_by created_at updated_at",
    omit: "recipients",
  },
  share_token_views: {
    columns:
      "id workspace_id authenticated pages_viewed duration_ms viewed_at",
    omit: "share_token_id ip user_agent country",
  },
  share_tokens: {
    columns:
      "id workspace_id label scope_project_ids scope_tabs hide_competitors hide_costs timeframe_lock theme_id allowed_email_domains max_views view_count last_viewed_at expires_at revoked_at created_by created_at updated_at failed_attempts locked_until",
    omit: "token_hash token_prefix password_hash password_required",
  },
  sso_configurations: {
    columns:
      "id workspace_id protocol idp_entity_id idp_sso_url idp_certificate email_domains jit_provisioning default_role enforce_sso_only status created_at updated_at",
    omit: "client_secret_enc dek_id scim_token_hash",
  },
  subscription_addons: {
    columns:
      "id workspace_id subscription_id kind quantity unit_price_usd stripe_subscription_item_id active_from active_until created_by created_at updated_at",
    omit: "",
  },
  support_grants: {
    columns:
      "id workspace_id requested_by approved_by scope allow_write justification ticket_ref expires_at revoked_at created_at",
    omit: "",
  },
  task_events: {
    columns:
      "id workspace_id task_id actor_id actor_type event from_value to_value comment_body payload occurred_at",
    omit: "",
  },
  tasks: {
    columns:
      "id workspace_id project_id short_ref kind origin rule_code title description status dismissed_reason resurface_at goal_id priority impact_score effort_band assignee_id due_at source_finding_id source_domain_id source_displacement_id source_geo_analysis affected_url affected_engines affected_prompt_ids prompt_cluster_id playbook_slug playbook_payload alignment_session_id baseline_metrics completion_metrics completed_at completed_by milestone_id created_at updated_at deleted_at recurrence_count last_evidence_at",
    omit: "dedupe_fingerprint",
  },
  tool_runs: {
    columns:
      "id workspace_id created_by tool_key brand_name brand_url target_url query_text prompt_texts engine_keys locale result_json sov_estimate citation_count sentiment_label brand_present aux_score entities_found pages_scanned items_kept engines_succeeded engines_failed cache_layer cells_charged cells_cached credits_charged duration_ms status error_code diff_base_run_id diff_compare_run_id converted_project_id converted_at pinned expires_at created_at",
    omit: "input_hash",
  },
  tracked_prompts: {
    columns:
      "id workspace_id project_id generation_batch_id generation_source text intent_archetype funnel_stage generator_meta cluster_id is_priority stability_score superseded_by last_captured_at status created_at updated_at deleted_at first_activated_at activation_credits paused_by_downgrade_at embedding_model status_changed_at embedding_next_model",
    omit: "text_hash embedding embedding_next",
  },
  workspace_invitations: {
    columns:
      "id workspace_id role project_scope invited_by expires_at accepted_at accepted_user_id revoked_at created_at",
    omit: "email token_hash",
  },
  workspace_members: {
    columns:
      "id workspace_id user_id role project_scope status invited_by joined_at last_active_at created_at updated_at digest_cadence sentiment_alerts_enabled",
    omit: "",
  },
  workspaces: {
    columns:
      "id name slug org_type region timezone plan_key entitlement_version entitlement_overrides status scoring_version data_retention_days deletion_requested_at deletion_execute_at created_at updated_at deleted_at retention_purge_not_before retention_deferred_raw_days retention_deferred_rollups_days",
    omit: "billing_email dsar_contact_email ownership_transfer",
  },
};

const EXPORT_ROWS: Readonly<Record<string, { readonly extraColumns?: readonly string[]; readonly subjectColumns?: readonly string[] }>> = {
  // actor_id has no foreign key (append-only, hash-chained tables); the pseudonymised actor survives erasure.
  audit_log: { extraColumns: ["actor_id"] },
  credit_ledger: { extraColumns: ["actor_id"] },
  workspace_members: { subjectColumns: ["user_id"] },
  workspace_invitations: { subjectColumns: ["invited_by", "accepted_user_id"] },
};

function exportOf(table: string): InventoryEntry {
  const declared = EXPORT_COLUMNS[table];
  if (declared === undefined) throw new Error(`subject-inventory: no column declaration for exported table ${table}`);
  return { disposition: "export", columns: words(declared.columns), omit: words(declared.omit), ...EXPORT_ROWS[table] };
}

export const SUBJECT_INVENTORY: Readonly<Record<string, InventoryEntry>> = Object.freeze({
  answer_captures: exportOf("answer_captures"),
  api_keys: exportOf("api_keys"),
  attribution_configs: exportOf("attribution_configs"), // created_by references users
  attribution_daily: exempt("Aggregated at ingest: counts only, never per-visitor data (NFR-CMP-12), so there is no subject surface."),
  attribution_url_rollup: exempt(AGGREGATE),
  // actor_id has no foreign key (the table is append-only and hash-chained); the pseudonymised actor survives erasure.
  audit_log: exportOf("audit_log"),
  aux_audits: exportOf("aux_audits"),
  aux_findings: exempt(DERIVED),
  brand_themes: exempt(WORKSPACE_CONFIG), // no foreign key to users; the exempt check in compliance-retention.spec.ts keeps that true
  capture_runs: exportOf("capture_runs"),
  citation_facts: exempt("Fact row about a cited URL in an engine answer; references no person."),
  competitors: exportOf("competitors"),
  content_chunks: exempt("Chunk of the customer's own crawled pages; references no person."),
  corpus_passages: exempt("Passage of the customer's own crawled pages; references no person."),
  credit_daily_counters: exempt(AGGREGATE),
  credit_hold_carries: exempt(AGGREGATE),
  credit_ledger: exportOf("credit_ledger"),
  credit_purchases: exportOf("credit_purchases"),
  credit_wallets: exempt("Balance row keyed by workspace; references no person."),
  custom_domains: exportOf("custom_domains"),
  displacement_events: exportOf("displacement_events"),
  domain_verifications: exportOf("domain_verifications"),
  downgrade_notices: exportOf("downgrade_notices"),
  retention_exports: exportOf("retention_exports"), // requested_by references users
  entity_nodes: exempt(DERIVED),
  geo_alignments: exportOf("geo_alignments"),
  geo_analyses: exportOf("geo_analyses"),
  goals: exportOf("goals"),
  gsc_connections: exportOf("gsc_connections"),
  gsc_daily: exempt(AGGREGATE),
  invoices: exempt("Financial record keyed by workspace; retained under accounting law (NFR-CMP-07); references no person."),
  mention_facts: exempt("Fact row about an entity mentioned in an engine answer; references no person of this product."),
  metric_daily: exempt(AGGREGATE),
  milestones: exportOf("milestones"),
  notification_emails: exportOf("notification_emails"),
  notification_reads: exportOf("notification_reads"),
  notifications: exportOf("notifications"),
  patches: exportOf("patches"),
  project_engines: exempt(WORKSPACE_CONFIG),
  project_source_index: exempt(DERIVED),
  projects: exportOf("projects"),
  prompt_stability: exempt(AGGREGATE),
  ref_counters: exempt("Sequence counter keyed by workspace; references no person."),
  report_artifacts: exportOf("report_artifacts"),
  scheduled_report_deliveries: exportOf("scheduled_report_deliveries"),
  scheduled_reports: exportOf("scheduled_reports"),
  semantic_nodes: exempt(DERIVED),
  share_token_email_codes: exempt(
    "Single-use sign-in code (10-minute life) for an external share-link visitor: a peppered address hash and a code hash only, never the address or the code, and no foreign key to users; it cannot be turned back into a person, and it cascades with its share token.",
  ),
  share_token_views: exportOf("share_token_views"),
  share_tokens: exportOf("share_tokens"),
  source_domains: exempt(WORKSPACE_CONFIG),
  name_match_judge_usage: exempt("Per-workspace monthly count of matches sent to the name-match model: a number, no text, no person."),
  name_match_verdicts: exempt("Model verdict on a brand-name match: ids, a judge version and a label, no answer text and no person."),
  prompt_generations: exempt("Background prompt-generation pass: the request and the result hold brand vocabulary and prompt text, no person."),
  sso_configurations: exportOf("sso_configurations"),
  stripe_subscription_syncs: exempt("Billing sync log keyed by workspace; references no person."),
  subscription_addons: exportOf("subscription_addons"), // created_by references users
  subscriptions: exempt("Billing state keyed by workspace; references no person."),
  support_grants: exportOf("support_grants"),
  task_events: exportOf("task_events"),
  task_verifications: exempt("Re-measurement schedule row; references no person."),
  tasks: exportOf("tasks"),
  tool_runs: exportOf("tool_runs"),
  topic_clusters: exempt(DERIVED),
  tracked_prompts: exportOf("tracked_prompts"),
  usage_counters: exempt(AGGREGATE),
  usage_ledger: exempt(AGGREGATE),
  usage_reservations: exempt(AGGREGATE),
  workspace_invitations: exportOf("workspace_invitations"),
  workspace_keys: exempt("Wrapped key material keyed by workspace; never exported, references no person."),
  workspace_members: exportOf("workspace_members"),
  workspaces: exportOf("workspaces"),
});

/** Tenant tables the isolation policies cover that have NO entry here. Non-empty = the build fails. */
export function unregisteredTenantTables(tenantTables: ReadonlySet<string>): string[] {
  return [...tenantTables].filter((table) => !(table in SUBJECT_INVENTORY)).sort();
}

/** Entries for tables the isolation policies no longer cover. Non-empty = the build fails (a dead entry hides a rename). */
export function staleInventoryEntries(tenantTables: ReadonlySet<string>): string[] {
  return Object.keys(SUBJECT_INVENTORY).filter((table) => !tenantTables.has(table)).sort();
}
