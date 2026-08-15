import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BREAKGLASS_ROLE,
  GLOBAL_TABLES,
  PORTAL_READABLE_TABLES,
  RUNTIME_ROLES,
} from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-011 · generated RLS policies + tenant context, end to end against a
// real Postgres 18 + pgvector database. Same shared-container /
// isolated-temp-migrations-dir / openConnection(role) pattern as
// test/integration/database-roles-and-grants.spec.ts — CRITICAL: every RLS
// behavioral assertion in this file connects as the ACTUAL runtime role via
// openConnection(), never as the superuser `client`. A Postgres superuser
// bypasses RLS by an entirely different mechanism than FORCE ROW LEVEL
// SECURITY addresses, so asserting against `client` would pass vacuously
// regardless of whether any policy works at all. `client` (the superuser) is
// used ONLY to seed fixture data and to inspect catalogs.
//
// Every it() below is titled with both its scenario number from STORY-011's
// Test Scenarios table AND the ISO-* id it prefigures (security-and-tenancy
// .md §10), so STORY-012's isolation suite can find these by grep.
describe("STORY-011 · generated RLS policies & tenant context", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let migrationsDir: string;
  let seq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();

    migrationsDir = await mkdtemp(path.join(tmpdir(), "nominara-story011-isolated-"));
    for (const name of [
      "0001_extensions_and_conventions",
      "0002_identity_tenancy_billing",
      "0003_projects_prompts_captures",
      "0004_rollups_aux_tasks_geo_tools",
      "0005_roles_grants_and_pooling",
      "0006_generated_rls_policies",
    ]) {
      for (const ext of ["up", "down"] as const) {
        const content = await readFile(path.join(MIGRATIONS_DIR, `${name}.${ext}.sql`), "utf8");
        await writeFile(path.join(migrationsDir, `${name}.${ext}.sql`), content);
      }
    }
  }, 180_000);

  afterAll(async () => {
    await container.stop();
    await rm(migrationsDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client, migrationsDir);
    seq = 0;

    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      const password = resolvePassword(role, {});
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
    }

    // Global catalog rows every seeded tenant table needs as an FK target.
    await client.query(
      `INSERT INTO engines (key, display_name, vendor, capture_mode, adapter_version, cache_ttl_seconds, volatility_band, min_plan_key)
       VALUES ('chatgpt', 'chatgpt', 'vendor', 'api', 'v1', 3600, 'medium', 'free')
       ON CONFLICT (key) DO NOTHING`,
    );
    await client.query(
      "INSERT INTO credit_packs (key, display_name, credits, price_usd) VALUES ('pack_a', 'Pack A', 100, 10) ON CONFLICT (key) DO NOTHING",
    );
    await client.query(
      `INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, rule_version)
       VALUES ('AUX-1', 'structured_data', 'Title', 'Description', 'rationale', 'high', 0.5, 'v1')
       ON CONFLICT (code) DO NOTHING`,
    );
  });

  afterEach(async () => {
    await client.end();
  });

  // ---- helpers --------------------------------------------------------

  async function openConnection(role: string, password?: string): Promise<Client> {
    const c = new Client({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      database: container.getDatabase(),
      user: role,
      password: password ?? resolvePassword(role, {}),
    });
    await c.connect();
    return c;
  }

  // Matches the census query pattern from every prior story's own tests
  // (rollups-aux-tasks-geo-tools.spec.ts, database-roles-and-grants.spec.ts)
  // and src/db/rls/introspect.ts itself.
  const CENSUS_TABLES_SQL = `
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relispartition
  `;

  async function tenantTableNames(): Promise<string[]> {
    const result = await client.query<{ table_name: string }>(CENSUS_TABLES_SQL);
    return result.rows.map((r) => r.table_name).filter((name) => !(GLOBAL_TABLES as readonly string[]).includes(name));
  }

  async function createWorkspace(planKey = "free"): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, $3) RETURNING id",
      [`Workspace ${seq}`, `workspace-${seq}-${Math.random().toString(36).slice(2)}`, planKey],
    );
    return result.rows[0]!.id;
  }

  async function createProject(workspaceId: string): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [workspaceId, `Project ${seq}`, `project-${seq}-${Math.random().toString(36).slice(2)}`, "https://example.com", "example.com"],
    );
    return result.rows[0]!.id;
  }

  async function createUser(): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO users (email) VALUES ($1) RETURNING id",
      [`user-${seq}-${Math.random().toString(36).slice(2)}@example.com`],
    );
    return result.rows[0]!.id;
  }

  function randomHash(label: string): Buffer {
    seq += 1;
    return createHash("sha256").update(`${label}-${seq}-${Math.random()}`).digest();
  }

  /**
   * Inserts exactly one row into EVERY one of the 59 tenant tables for
   * `workspaceId`, as the superuser (bypasses RLS/grants entirely, purely a
   * fixture-seeding step) — so scenario 1/5's "SELECT count(*) returns 0
   * with no context" is a real assertion about real rows, not a vacuous
   * truth about empty tables. Returns the ids this suite's tests need to
   * reference afterwards.
   */
  async function seedOneRowPerTenantTable(workspaceId: string) {
    const projectId = await createProject(workspaceId);
    const userA = await createUser();
    const userB = await createUser();

    // ---- 0002 workspace-scoped tables ----
    await client.query(
      "INSERT INTO workspace_keys (workspace_id, dek_id, wrapped_dek, kms_key_arn) VALUES ($1, $2, 'x', 'arn:aws:kms:x')",
      [workspaceId, `dek-${seq++}`],
    );
    await client.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
      [workspaceId, userA],
    );
    await client.query(
      `INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, 'invitee@example.com', 'analyst', $2, $3, now() + interval '7 days')`,
      [workspaceId, randomHash("invite"), userA],
    );
    await client.query(
      `INSERT INTO sso_configurations (workspace_id, protocol, idp_entity_id, idp_sso_url, idp_certificate, email_domains)
       VALUES ($1, 'oidc', 'entity', 'https://idp.example/sso', 'cert', ARRAY['example.com']::citext[])`,
      [workspaceId],
    );
    await client.query(
      `INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, permissions, created_by)
       VALUES ($1, 'Key', 'nk_live_x', $2, ARRAY['project:read'], $3)`,
      [workspaceId, randomHash("apikey"), userA],
    );
    await client.query(
      `INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at)
       VALUES ($1, $2, $3, 'metadata', 'debug', 'TICKET-1', now() + interval '1 day')`,
      [workspaceId, userA, userB],
    );
    const subResult = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1, 'starter', 'monthly', 'cus_x', $2, 'active', now(), now() + interval '30 days')
       RETURNING id`,
      [workspaceId, `sub_${seq++}`],
    );
    const subscriptionId = subResult.rows[0]!.id;
    await client.query(
      "INSERT INTO credit_wallets (workspace_id, cycle_start, cycle_end) VALUES ($1, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days')",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, limit_count) VALUES ($1, CURRENT_DATE, 'lookup', 3)",
      [workspaceId],
    );
    await client.query(
      `INSERT INTO credit_ledger (workspace_id, entry_type, credits, included_after, purchased_after, reserved_after, idempotency_key)
       VALUES ($1, 'grant', 10, 10, 0, 0, $2)`,
      [workspaceId, `idem-${seq++}`],
    );
    await client.query(
      "INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd) VALUES ($1, 'pack_a', 100, 10)",
      [workspaceId],
    );
    await client.query(
      `INSERT INTO subscription_addons (workspace_id, subscription_id, kind, quantity, unit_price_usd, stripe_subscription_item_id)
       VALUES ($1, $2, 'extra_seat', 1, 10, $3)`,
      [workspaceId, subscriptionId, `si_${seq++}`],
    );
    await client.query(
      "INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value) VALUES ($1, 'pdf_exports', CURRENT_DATE, 10)",
      [workspaceId],
    );
    await client.query(
      "INSERT INTO usage_ledger (workspace_id, metric, quantity, source) VALUES ($1, 'pdf_exports', 1, 'system')",
      [workspaceId],
    );
    await client.query(
      `INSERT INTO invoices (workspace_id, stripe_invoice_id, status, subtotal, total, period_start, period_end)
       VALUES ($1, $2, 'paid', 10, 10, now(), now() + interval '30 days')`,
      [workspaceId, `inv_${seq++}`],
    );

    // ---- 0003 project-scoped tables ----
    await client.query(
      "INSERT INTO project_engines (workspace_id, project_id, engine_key) VALUES ($1, $2, 'chatgpt')",
      [workspaceId, projectId],
    );
    await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'Acme Co')", [
      workspaceId,
      projectId,
    ]);
    await client.query(
      "INSERT INTO domain_verifications (workspace_id, project_id, domain, method, nonce) VALUES ($1, $2, 'example.com', 'dns_txt', 'nonce')",
      [workspaceId, projectId],
    );
    const promptResult = await client.query<{ id: string }>(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage)
       VALUES ($1, $2, $3, $4, 'recommendation', 'awareness')
       RETURNING id`,
      [workspaceId, projectId, `prompt text ${seq}`, randomHash("prompt")],
    );
    const promptId = promptResult.rows[0]!.id;
    await client.query(
      `INSERT INTO prompt_stability (workspace_id, prompt_id, engine_key, window_start, sample_count, presence_rate, sov_median, sov_iqr, entity_set_jsd)
       VALUES ($1, $2, 'chatgpt', CURRENT_DATE, 5, 0.8, 10, 2, 0.1)`,
      [workspaceId, promptId],
    );
    await client.query("INSERT INTO topic_clusters (workspace_id, project_id, label) VALUES ($1, $2, $3)", [
      workspaceId,
      projectId,
      `cluster ${seq++}`,
    ]);
    const runResult = await client.query<{ id: string }>(
      "INSERT INTO capture_runs (workspace_id, project_id, trigger, engine_keys) VALUES ($1, $2, 'manual', ARRAY['chatgpt']) RETURNING id",
      [workspaceId, projectId],
    );
    const runId = runResult.rows[0]!.id;
    const captureResult = await client.query<{ id: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(), 'api', 'v1', 'v1', $5)
       RETURNING id`,
      [workspaceId, projectId, runId, promptId, randomHash("capture")],
    );
    const resultId = captureResult.rows[0]!.id;
    await client.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          entity_type, entity_label, matched_alias, occurrence_index, char_start, char_end,
          first_token_index, prominence, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(), 'brand', 'Our Brand', 'Our Brand', 0, 0, 10, 0, 0.9, 'positive', 0.8, 0.9, 'lexicon')`,
      [workspaceId, projectId, resultId, promptId],
    );
    await client.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain, position_weight)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(), 1, 'https://example.com/p', 'https://example.com/p', $5, 'example.com', 1.0)`,
      [workspaceId, projectId, resultId, promptId, randomHash("citation")],
    );
    const captureResult2 = await client.query<{ id: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(), 'api', 'v1', 'v1', $5)
       RETURNING id`,
      [workspaceId, projectId, runId, promptId, randomHash("capture2")],
    );
    await client.query(
      `INSERT INTO displacement_events (workspace_id, project_id, prompt_id, engine_key, kind, before_result_id, after_result_id, displaced_by)
       VALUES ($1, $2, $3, 'chatgpt', 'presence_lost', $4, $5, '[]'::jsonb)`,
      [workspaceId, projectId, promptId, resultId, captureResult2.rows[0]!.id],
    );

    // ---- 0004 tables ----
    const sourceDomainResult = await client.query<{ id: string }>(
      "INSERT INTO source_domains (workspace_id, domain) VALUES ($1, $2) RETURNING id",
      [workspaceId, `source-${seq++}.example.com`],
    );
    const sourceDomainId = sourceDomainResult.rows[0]!.id;
    await client.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days)
       VALUES ($1, $2, $3, 'chatgpt', CURRENT_DATE, 30)`,
      [workspaceId, projectId, sourceDomainId],
    );
    await client.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date)
       VALUES ($1, $2, 'chatgpt', 'brand', $2, CURRENT_DATE)`,
      [workspaceId, projectId],
    );
    await client.query(
      "INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title) VALUES ($1, $2, now(), 'annotation', 'Milestone')",
      [workspaceId, projectId],
    );
    await client.query(
      "INSERT INTO notifications (workspace_id, kind, severity, title) VALUES ($1, 'info', 'info', 'Notice')",
      [workspaceId],
    );
    const auditResult = await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer)
       VALUES ($1, $2, 'manual', ARRAY['https://example.com/'], 'v1', 'cl100k')
       RETURNING id`,
      [workspaceId, projectId],
    );
    const auditId = auditResult.rows[0]!.id;
    await client.query(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, severity, fingerprint, title, evidence, rule_version)
       VALUES ($1, $2, $3, 'AUX-1', 'medium', $4, 'Finding', '{}'::jsonb, 'v1')`,
      [workspaceId, projectId, auditId, randomHash("finding")],
    );
    const taskResult = await client.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description)
       VALUES ($1, $2, $3, 'content', $4, 'Title', 'Description')
       RETURNING id`,
      [workspaceId, projectId, `HUB-${seq++}`, randomHash("task")],
    );
    const taskId = taskResult.rows[0]!.id;
    await client.query(
      "INSERT INTO goals (workspace_id, project_id, title, kind, target) VALUES ($1, $2, 'Goal', 'custom', '{}'::jsonb)",
      [workspaceId, projectId],
    );
    await client.query("INSERT INTO task_events (workspace_id, task_id, event) VALUES ($1, $2, 'created')", [
      workspaceId,
      taskId,
    ]);
    await client.query("INSERT INTO ref_counters (workspace_id, prefix) VALUES ($1, 'HUB') ON CONFLICT DO NOTHING", [
      workspaceId,
    ]);
    await client.query(
      "INSERT INTO geo_analyses (workspace_id, project_id, analysis, window_start, window_days) VALUES ($1, $2, 'alignment', CURRENT_DATE, 30)",
      [workspaceId, projectId],
    );
    await client.query("INSERT INTO entity_nodes (workspace_id, project_id, node) VALUES ($1, $2, 'wikidata')", [
      workspaceId,
      projectId,
    ]);
    await client.query(
      "INSERT INTO geo_alignments (workspace_id, project_id, target_url, engine_keys, embedding_model) VALUES ($1, $2, 'https://example.com/x', ARRAY['chatgpt'], 'text-embedding-3-small')",
      [workspaceId, projectId],
    );
    await client.query(
      `INSERT INTO content_chunks (workspace_id, project_id, url, chunk_index, text, token_count, content_hash)
       VALUES ($1, $2, 'https://example.com/x', 0, 'text', 10, $3)`,
      [workspaceId, projectId, randomHash("chunk")],
    );
    await client.query(
      `INSERT INTO corpus_passages (workspace_id, project_id, citation_url_hash, url, domain, passage_index, text, token_count, content_hash, embedding_model, expires_at)
       VALUES ($1, $2, $3, 'https://example.com/x', 'example.com', 0, 'text', 10, $4, 'text-embedding-3-small', now() + interval '30 days')`,
      [workspaceId, projectId, randomHash("passageurl"), randomHash("passagecontent")],
    );
    await client.query(
      `INSERT INTO semantic_nodes (workspace_id, project_id, phrase, phrase_normalized, node_type, evidence_url, evidence_snippet)
       VALUES ($1, $2, 'phrase', 'phrase', 'capability', 'https://example.com/x', 'snippet')`,
      [workspaceId, projectId],
    );
    await client.query(
      `INSERT INTO patches (workspace_id, project_id, target_url, kind, content_before_hash, content_after)
       VALUES ($1, $2, 'https://example.com/x', 'markdown', $3, 'content')`,
      [workspaceId, projectId, randomHash("patch")],
    );
    await client.query(
      `INSERT INTO tool_runs (workspace_id, tool_key, input_hash, result_json, expires_at)
       VALUES ($1, 'schema_builder', $2, '{}'::jsonb, now() + interval '1 day')`,
      [workspaceId, randomHash("toolrun")],
    );
    await client.query(
      `INSERT INTO attribution_configs (workspace_id, project_id, method, site_token, site_token_hash)
       VALUES ($1, $2, 'script', 'token', $3)`,
      [workspaceId, projectId, randomHash("attrtoken")],
    );
    await client.query(
      `INSERT INTO attribution_daily
         (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, country, device)
       VALUES ($1, $2, CURRENT_DATE, $3, 'https://example.com/x', 'chatgpt', 'US', 'desktop')`,
      [workspaceId, projectId, randomHash("landingurl")],
    );
    await client.query(
      `INSERT INTO attribution_url_rollup (workspace_id, project_id, window_start, window_days, landing_url_hash, landing_url, pattern)
       VALUES ($1, $2, CURRENT_DATE, 30, $3, 'https://example.com/x', 'dual_visibility')`,
      [workspaceId, projectId, randomHash("rollupurl")],
    );
    await client.query(
      `INSERT INTO gsc_connections (workspace_id, project_id, property_url, property_type, credentials_enc, dek_id, scopes)
       VALUES ($1, $2, 'https://example.com/', 'domain', 'enc', 'dek-1', ARRAY['scope'])`,
      [workspaceId, projectId],
    );
    await client.query(
      `INSERT INTO gsc_daily (workspace_id, project_id, metric_date, report, dimension, page_url_hash, query_hash, country, device)
       VALUES ($1, $2, CURRENT_DATE, 'classic', 'page_query', $3, $4, 'US', 'desktop')`,
      [workspaceId, projectId, randomHash("pageurl"), randomHash("queryhash")],
    );
    await client.query("INSERT INTO brand_themes (workspace_id) VALUES ($1)", [workspaceId]);
    await client.query(
      "INSERT INTO custom_domains (workspace_id, hostname, cname_target, verification_token) VALUES ($1, $2, 'cname.example.com', 'token')",
      [workspaceId, `portal-${seq++}.example.com`],
    );
    const shareTokenResult = await client.query<{ id: string }>(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, created_by)
       VALUES ($1, 'Label', $2, 'abcdefgh', $3, $4)
       RETURNING id`,
      [workspaceId, randomHash("sharetoken"), [projectId], userA],
    );
    await client.query("INSERT INTO share_token_views (workspace_id, share_token_id) VALUES ($1, $2)", [
      workspaceId,
      shareTokenResult.rows[0]!.id,
    ]);
    await client.query(
      "INSERT INTO scheduled_reports (workspace_id, name, project_ids, cadence, recipients) VALUES ($1, 'Report', $2, 'weekly', ARRAY['owner@example.com']::citext[])",
      [workspaceId, [projectId]],
    );
    await client.query(
      `INSERT INTO report_artifacts (workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at)
       VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 'pdf', 'key', 100, '{}'::jsonb, now() + interval '30 days')`,
      [workspaceId, [projectId]],
    );
    await client.query(
      `INSERT INTO audit_log (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
       VALUES ($1, 'user', 'workspace.create', 'workspace', $2, $3, $4)`,
      [workspaceId, `req-${seq++}`, Buffer.alloc(32, 0), randomHash("audit")],
    );

    return { projectId, userA, userB, promptId, runId, resultId, taskId, auditId, shareTokenId: shareTokenResult.rows[0]!.id };
  }

  // ======================================================================
  // Scenario 1 (ISO-01) — zero rows with no context, for EACH of the 59
  // tenant tables.
  // ======================================================================

  it("scenario 1 (ISO-01) — SELECT count(*) as nominara_app with NO context returns 0, for EACH of the 59 tenant tables", async () => {
    const workspaceId = await createWorkspace();
    await seedOneRowPerTenantTable(workspaceId);
    const tables = await tenantTableNames();
    expect(tables.length).toBe(59);

    const appClient = await openConnection("nominara_app");
    try {
      for (const table of tables) {
        const result = await appClient.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
        expect(Number(result.rows[0]!.count), `table ${table} leaked rows with no context`).toBe(0);
      }
    } finally {
      await appClient.end();
    }
  }, 60_000);

  // Fix pass item 13 — a SECOND pass, WITH the correct tenant's context set,
  // asserting exactly 1 row per table. QA-reviewer proved scenario 1's own
  // deny-only loop above cannot distinguish "correctly isolated" from
  // "totally bricked": setting `ws_isolation_tracked_prompts` to
  // `USING (false) WITH CHECK (false)` (permanently deny EVERYONE, including
  // the tenant that owns the row) left the entire 175-test suite green,
  // because nothing anywhere proved a valid context actually grants access.
  // This pass closes that — the seed already guarantees exactly one row per
  // table exists for `workspaceId`.
  it("scenario 1 positive pass — SELECT count(*) as nominara_app WITH the correct tenant's context returns exactly 1, for EACH of the 59 tenant tables", async () => {
    const workspaceId = await createWorkspace();
    await seedOneRowPerTenantTable(workspaceId);
    const tables = await tenantTableNames();
    expect(tables.length).toBe(59);

    const appClient = await openConnection("nominara_app");
    try {
      await withTenantContext(
        appClient,
        { workspaceId, actorId: "00000000-0000-0000-0000-0000000000aa" },
        async (tx) => {
          for (const table of tables) {
            const result = await tx.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
            // seedOneRowPerTenantTable inserts exactly one row per table,
            // EXCEPT answer_captures — it needs a second capture row to
            // populate displacement_events' before/after result ids.
            const expectedCount = table === "answer_captures" ? 2 : 1;
            expect(
              Number(result.rows[0]!.count),
              `table ${table} did not grant access under its own tenant's context`,
            ).toBe(expectedCount);
          }
        },
      );
    } finally {
      await appClient.end();
    }
  }, 60_000);

  // ======================================================================
  // Scenario 2 (ISO-03-adjacent) — INSERT with no context is rejected, on a
  // representative table AND on workspaces (the id-scoped exception).
  // ======================================================================

  it("scenario 2 — INSERT with no context set as nominara_app is rejected (42501), on a representative table and on workspaces", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const appClient = await openConnection("nominara_app");
    try {
      await expect(
        appClient.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'X')", [
          workspaceId,
          projectId,
        ]),
      ).rejects.toMatchObject({ code: "42501" });

      await expect(
        appClient.query("INSERT INTO workspaces (name, slug, plan_key) VALUES ('x', $1, 'free')", [
          `no-context-${Math.random().toString(36).slice(2)}`,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await appClient.end();
    }
  });

  // ======================================================================
  // Scenario 3 (ISO-03) — INSERT under tenant A's context with tenant B's
  // identifier raises, SQLSTATE asserted not message text. Fix pass item 12
  // — parameterized across THREE table shapes (previously only competitors
  // was ever tested): a workspace-only table, a project-descendant table,
  // and workspaces itself (the `id`-scoped exception).
  // ======================================================================

  describe("scenario 3 (ISO-03) — INSERT under tenant A's context with tenant B's identifier raises 42501", () => {
    it("a workspace-only table (workspace_keys)", async () => {
      const workspaceA = await createWorkspace();
      const workspaceB = await createWorkspace();

      const appClient = await openConnection("nominara_app");
      try {
        await expect(
          withTenantContext(appClient, { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" }, async (tx) => {
            return tx.query(
              "INSERT INTO workspace_keys (workspace_id, dek_id, wrapped_dek, kms_key_arn) VALUES ($1, $2, 'x', 'arn:aws:kms:x')",
              [workspaceB, `dek-scn3-${Math.random().toString(36).slice(2)}`],
            );
          }),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await appClient.end();
      }
    });

    it("a project-descendant table (competitors), carrying A's own project_id but B's workspace_id", async () => {
      const workspaceA = await createWorkspace();
      const workspaceB = await createWorkspace();
      const projectA = await createProject(workspaceA);

      const appClient = await openConnection("nominara_app");
      try {
        await expect(
          withTenantContext(appClient, { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" }, async (tx) => {
            return tx.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'X')", [
              workspaceB,
              projectA,
            ]);
          }),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await appClient.end();
      }
    });

    it("workspaces itself — the id-scoped exception (a new row whose own id doesn't match current_workspace())", async () => {
      const workspaceA = await createWorkspace();
      const workspaceB = await createWorkspace();

      const appClient = await openConnection("nominara_app");
      try {
        await expect(
          withTenantContext(appClient, { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" }, async (tx) => {
            // workspaces' own ws_isolation policy scopes by `id`, not a
            // workspace_id column — inserting a row whose id is workspaceB
            // (not workspaceA, the active context) must be rejected exactly
            // the same way.
            return tx.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'x', $2, 'free')", [
              workspaceB,
              `scn3-workspaces-${Math.random().toString(36).slice(2)}`,
            ]);
          }),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await appClient.end();
      }
    });
  });

  // ======================================================================
  // Scenario 4 (ISO-04) — UPDATE ... SET workspace_id = B under A's context.
  // Fix pass item 12 — the generator's policy shape (FOR ALL with an
  // IDENTICAL USING and WITH CHECK predicate) means this ALWAYS raises. The
  // previous either/or wording ("0 rows OR raises") let this pass without
  // ever proving which branch actually occurs — tightened to require the
  // raise, outright.
  //
  // CORRECTED (second fix pass) — the previous version of this comment (and
  // commit 27dddc9's message) claimed WITH CHECK specifically is what blocks
  // this UPDATE. That was verified WRONG by direct minimal-table probing,
  // confirmed independently here by reproducing it against a real Postgres
  // 18 instance: a policy shaped `USING (ws-scoped) WITH CHECK (true)` STILL
  // raises 42501 on this exact cross-tenant UPDATE, so WITH CHECK cannot be
  // the thing blocking it there.
  //
  // The actual mechanism: for a `FOR ALL` policy on UPDATE, Postgres applies
  // the USING clause to BOTH the pre-update row (to determine whether it's
  // even visible/selectable for the update at all) AND the post-update row
  // (to determine whether the row, as it would exist after the update, is
  // still visible) — independent of whatever WITH CHECK says. Here, the
  // pre-update row (workspace_id = A) passes USING under A's context, but
  // the post-update row (workspace_id = B) fails that same USING check, so
  // the UPDATE is rejected before WITH CHECK is even relevant to the
  // outcome. Scenario 4b below proves this distinction directly. WITH CHECK
  // is still correctly proven necessary elsewhere: scenario 3 (INSERT) has
  // no pre-existing row for USING to fall back on, so it is the one test
  // that actually isolates WITH CHECK — that, plus rls-generate.spec.ts (the
  // generator always emits WITH CHECK) and rls-check.ts's drift detection
  // (flags a WITH CHECK removal as both missing and unexpected), are what
  // actually guard WITH CHECK's necessity, not this scenario.
  // ======================================================================

  it("scenario 4 (ISO-04) — UPDATE ... SET workspace_id = B under A's context raises 42501", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const projectA = await createProject(workspaceA);
    const competitorResult = await client.query<{ id: string }>(
      "INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'X') RETURNING id",
      [workspaceA, projectA],
    );
    const competitorId = competitorResult.rows[0]!.id;

    const appClient = await openConnection("nominara_app");
    try {
      await expect(
        withTenantContext(appClient, { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" }, async (tx) => {
          return tx.query("UPDATE competitors SET workspace_id = $1 WHERE id = $2", [workspaceB, competitorId]);
        }),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await appClient.end();
    }
  });

  // ======================================================================
  // Scenario 4b — directly isolates the USING-vs-WITH-CHECK distinction
  // asserted in scenario 4's comment above, against a throwaway table (not
  // one of the 59 generated tenant tables) so this test can freely swap
  // policy shapes without touching migration 0006's own policies. Proves,
  // rather than merely asserts, which clause is doing the work.
  // ======================================================================

  it("scenario 4b — USING governs a cross-tenant UPDATE independent of WITH CHECK", async () => {
    await client.query("CREATE TABLE IF NOT EXISTS scn4b_probe (id uuid PRIMARY KEY, workspace_id uuid NOT NULL)");
    await client.query("ALTER TABLE scn4b_probe ENABLE ROW LEVEL SECURITY");
    await client.query("ALTER TABLE scn4b_probe FORCE ROW LEVEL SECURITY");
    await client.query("GRANT ALL ON scn4b_probe TO nominara_app");

    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const rowId = "00000000-0000-0000-0000-0000000000f1";
    await client.query("INSERT INTO scn4b_probe (id, workspace_id) VALUES ($1, $2)", [rowId, workspaceA]);

    const appClient = await openConnection("nominara_app");
    try {
      // USING restrictive (workspace-scoped), WITH CHECK fully permissive
      // (true) — the cross-tenant UPDATE still fails, proving USING alone
      // (not WITH CHECK) blocks it here.
      await client.query("DROP POLICY IF EXISTS scn4b_policy ON scn4b_probe");
      await client.query(
        "CREATE POLICY scn4b_policy ON scn4b_probe FOR ALL TO nominara_app USING (workspace_id = app.current_workspace()) WITH CHECK (true)",
      );
      await expect(
        withTenantContext(appClient, { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" }, async (tx) => {
          return tx.query("UPDATE scn4b_probe SET workspace_id = $1 WHERE id = $2", [workspaceB, rowId]);
        }),
      ).rejects.toMatchObject({ code: "42501" });

      // USING fully permissive (true), WITH CHECK fully permissive (true) —
      // the SAME cross-tenant UPDATE now succeeds, confirming USING (not
      // some other constraint) was what blocked it above.
      await client.query("DROP POLICY scn4b_policy ON scn4b_probe");
      await client.query("CREATE POLICY scn4b_policy ON scn4b_probe FOR ALL TO nominara_app USING (true) WITH CHECK (true)");
      await withTenantContext(appClient, { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" }, async (tx) => {
        return tx.query("UPDATE scn4b_probe SET workspace_id = $1 WHERE id = $2", [workspaceB, rowId]);
      });
      const afterPermissive = await client.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM scn4b_probe WHERE id = $1",
        [rowId],
      );
      expect(afterPermissive.rows[0]?.workspace_id).toBe(workspaceB);
    } finally {
      await appClient.end();
      await client.query("DROP TABLE IF EXISTS scn4b_probe");
    }
  });

  // ======================================================================
  // Scenario 5 (ISO-05) — pg_policies inspection: every FOR ALL policy has
  // non-null with_check; every tenant table (AND partition child) has
  // relrowsecurity + relforcerowsecurity true; zero policies on any
  // GLOBAL_TABLES entry.
  // ======================================================================

  it("scenario 5 (ISO-05) — every FOR ALL policy has a non-null with_check", async () => {
    const result = await client.query<{ tablename: string; policyname: string; with_check: string | null }>(
      "SELECT tablename, policyname, with_check FROM pg_policies WHERE schemaname = 'public' AND cmd = 'ALL'",
    );
    expect(result.rowCount).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.with_check, `${row.tablename}.${row.policyname} has a null with_check`).not.toBeNull();
    }
  });

  // Fix pass item 13 — exact COUNTS, not just "rowCount > 0". QA-reviewer
  // proved a blanket "greater than 0" check can't distinguish a correctly-
  // populated policy set from one with entries silently missing (e.g. one
  // ws_isolation_* policy dropped outright still leaves rowCount > 0).
  // Scoped to the 59 PARENT tenant tables specifically (via tenantTableNames,
  // which excludes partition children) — partition children also carry their
  // own copied ws_isolation_<child> policy (app.apply_tenant_rls), so an
  // unscoped count would include those too and no longer mean "59".
  it("scenario 5 — EXACTLY 59 ws_isolation_* policies and EXACTLY 18 portal_scope_* policies exist on the 59 parent tenant tables", async () => {
    const tables = await tenantTableNames();
    expect(tables.length).toBe(59);

    const wsIsolationCount = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'ws_isolation_%' AND tablename = ANY($1::text[])",
      [tables],
    );
    expect(Number(wsIsolationCount.rows[0]!.count)).toBe(59);

    const portalScopeCount = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'portal_scope_%' AND tablename = ANY($1::text[])",
      [tables],
    );
    expect(Number(portalScopeCount.rows[0]!.count)).toBe(18);
  });

  it("scenario 5 (ISO-05/ISO-06) — every one of the 59 tenant tables AND every existing partition child has relrowsecurity + relforcerowsecurity = true", async () => {
    const tables = await tenantTableNames();
    const partitionChildren = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE c.relkind = 'r' AND p.relkind = 'p'`,
    );
    const allNames = [...tables, ...partitionChildren.rows.map((r) => r.relname)];

    const flags = await client.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[])",
      [allNames],
    );
    expect(flags.rowCount).toBe(allNames.length);
    for (const row of flags.rows) {
      expect(row.relrowsecurity, `${row.relname} relrowsecurity`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} relforcerowsecurity`).toBe(true);
    }
  });

  it("scenario 5 — zero policies exist on any GLOBAL_TABLES entry", async () => {
    const result = await client.query<{ count: string }>(
      "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
      [GLOBAL_TABLES],
    );
    expect(Number(result.rows[0]!.count)).toBe(0);
  });

  // ======================================================================
  // The partition-hole test — the story's headline finding.
  // ======================================================================

  it("the partition RLS hole — a partition child of answer_captures is protected identically to its parent, and this test provably catches regression", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const projectA = await createProject(workspaceA);

    // 0003's DO block creates a current-month and next-month partition
    // (answer_captures_YYYY_MM) plus a permanent answer_captures_default —
    // picking the CURRENT-MONTH one specifically (not "any child") is what
    // lets a plain `captured_at = now()` row insert without tripping the
    // partition's own range CHECK.
    const childResult = await client.query<{ relname: string }>(
      `SELECT c.relname FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'answer_captures' AND c.relkind = 'r' AND c.relname <> 'answer_captures_default'
        ORDER BY c.relname
        LIMIT 1`,
    );
    expect(childResult.rowCount).toBe(1);
    const child = childResult.rows[0]!.relname;

    // Seed one row directly into the CHILD (bypassing the parent entirely)
    // as superuser, so there's something real to (attempt to) leak.
    await client.query(
      `INSERT INTO ${child}
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', now(), 'api', 'v1', 'v1', $3)`,
      [workspaceA, projectA, randomHash("childcapture")],
    );

    // ---- fixed state: querying/inserting the child directly is blocked ----
    const appClient = await openConnection("nominara_app");
    try {
      const countFixed = await appClient.query<{ count: string }>(`SELECT count(*) FROM ${child}`);
      expect(Number(countFixed.rows[0]!.count)).toBe(0);

      await expect(
        appClient.query(
          `INSERT INTO ${child}
             (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
           VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', now(), 'api', 'v1', 'v1', $3)`,
          [workspaceB, projectA, randomHash("childcapture2")],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await appClient.end();
    }

    // ---- demonstrate this test actually catches the bug: reopen the exact
    // hole (as if app.apply_tenant_rls's DO block had never run against
    // this child) by stripping RLS from the child directly, then re-run the
    // SAME assertion shape and confirm it would now FAIL to catch a leak. ----
    await client.query(`ALTER TABLE ${child} NO FORCE ROW LEVEL SECURITY`);
    await client.query(`ALTER TABLE ${child} DISABLE ROW LEVEL SECURITY`);

    const appClientBroken = await openConnection("nominara_app");
    try {
      const countBroken = await appClientBroken.query<{ count: string }>(`SELECT count(*) FROM ${child}`);
      // The hole, reopened: the row is now visible with NO context at all.
      expect(Number(countBroken.rows[0]!.count)).toBeGreaterThan(0);
    } finally {
      await appClientBroken.end();
      // ---- restore the fix via the exact reusable function STORY-013 will
      // call for every future partition ----
      await client.query(`SELECT app.apply_tenant_rls('${child}'::regclass)`);

      const restoredFlags = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1",
        [child],
      );
      expect(restoredFlags.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
  });

  // ======================================================================
  // Fix pass item 9 — app.apply_tenant_rls deliberately does NOT copy the
  // portal_scope_* policy to a partition child. This proves the claim in
  // that function's own header comment: a portal session reading through
  // the PARENT (answer_captures) gets exactly its in-scope row, even though
  // that row physically lives in a partition child with no portal_scope_*
  // policy of its own at all.
  // ======================================================================

  it("fix pass item 9 — a portal session reads an in-scope row from answer_captures (partitioned) through the PARENT; the same row is invisible querying the CHILD directly", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const promptResult = await client.query<{ id: string }>(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage)
       VALUES ($1, $2, $3, $4, 'recommendation', 'awareness')
       RETURNING id`,
      [workspaceId, projectId, `prompt ${seq}`, randomHash("portal-prompt")],
    );
    const promptId = promptResult.rows[0]!.id;
    const runResult = await client.query<{ id: string }>(
      "INSERT INTO capture_runs (workspace_id, project_id, trigger, engine_keys) VALUES ($1, $2, 'manual', ARRAY['chatgpt']) RETURNING id",
      [workspaceId, projectId],
    );
    // Inserted through the PARENT (normal application insert path) — Postgres
    // routes it to the correct child partition itself via partition pruning.
    const captureResult = await client.query<{ id: string; child_table: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(), 'api', 'v1', 'v1', $5)
       RETURNING id, tableoid::regclass::text AS child_table`,
      [workspaceId, projectId, runResult.rows[0]!.id, promptId, randomHash("portal-capture")],
    );
    const child = captureResult.rows[0]!.child_table;
    expect(child).not.toBe("answer_captures");

    const portalClient = await openConnection("nominara_portal");
    try {
      await portalClient.query("BEGIN");
      await portalClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
      await portalClient.query("SELECT set_config('app.current_scope_projects', $1, true)", [projectId]);

      // Through the parent: exactly the in-scope row comes back.
      const throughParent = await portalClient.query<{ id: string }>("SELECT id FROM answer_captures");
      expect(throughParent.rows.map((r) => r.id)).toEqual([captureResult.rows[0]!.id]);

      // Through the child directly, by name: zero rows — no portal_scope_*
      // policy exists on the child at all, and FORCE ROW LEVEL SECURITY with
      // no matching policy denies by default.
      const throughChild = await portalClient.query(`SELECT id FROM ${child}`);
      expect(throughChild.rowCount).toBe(0);

      await portalClient.query("COMMIT");
    } finally {
      await portalClient.end();
    }
  });

  // ======================================================================
  // Scenario 11 (ISO-09) — portal role scoping.
  // ======================================================================

  describe("scenario 11 (ISO-09) — portal role project scoping", () => {
    async function withPortalContext<T>(
      portalClient: Client,
      workspaceId: string,
      scopeProjectIds: readonly string[],
      fn: (tx: Client) => Promise<T>,
    ): Promise<T> {
      await portalClient.query("BEGIN");
      try {
        await portalClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
        if (scopeProjectIds.length > 0) {
          await portalClient.query("SELECT set_config('app.current_scope_projects', $1, true)", [
            scopeProjectIds.join(","),
          ]);
        }
        const result = await fn(portalClient);
        await portalClient.query("COMMIT");
        return result;
      } catch (error) {
        await portalClient.query("ROLLBACK");
        throw error;
      }
    }

    it("reading a P2 row of a project-descendant portal table (competitors) with scope = [P1] returns zero rows; a P1 row returns it", async () => {
      const workspaceId = await createWorkspace();
      const p1 = await createProject(workspaceId);
      const p2 = await createProject(workspaceId);
      await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'In scope')", [
        workspaceId,
        p1,
      ]);
      await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'Out of scope')", [
        workspaceId,
        p2,
      ]);

      const portalClient = await openConnection("nominara_portal");
      try {
        await withPortalContext(portalClient, workspaceId, [p1], async (tx) => {
          const rows = await tx.query<{ project_id: string }>("SELECT project_id FROM competitors");
          expect(rows.rows.map((r) => r.project_id)).toEqual([p1]);
        });
      } finally {
        await portalClient.end();
      }
    });

    it("projects itself — the id = ANY(...) self-scoped case", async () => {
      const workspaceId = await createWorkspace();
      const p1 = await createProject(workspaceId);
      const p2 = await createProject(workspaceId);

      const portalClient = await openConnection("nominara_portal");
      try {
        await withPortalContext(portalClient, workspaceId, [p1], async (tx) => {
          const rows = await tx.query<{ id: string }>("SELECT id FROM projects");
          expect(rows.rows.map((r) => r.id)).toEqual([p1]);
          expect(rows.rows.map((r) => r.id)).not.toContain(p2);
        });
      } finally {
        await portalClient.end();
      }
    });

    it("a non-portal-readable tenant table (domain_verifications) returns zero rows even 'in scope'", async () => {
      const workspaceId = await createWorkspace();
      const p1 = await createProject(workspaceId);
      await client.query(
        "INSERT INTO domain_verifications (workspace_id, project_id, domain, method, nonce) VALUES ($1, $2, 'example.com', 'dns_txt', 'nonce')",
        [workspaceId, p1],
      );

      const portalClient = await openConnection("nominara_portal");
      try {
        await withPortalContext(portalClient, workspaceId, [p1], async (tx) => {
          const rows = await tx.query("SELECT * FROM domain_verifications");
          expect(rows.rowCount).toBe(0);
        });
      } finally {
        await portalClient.end();
      }
    });

    // ---- boundary cases ----

    it("boundary — empty scope_project_ids → zero rows everywhere on a project-descendant portal table", async () => {
      const workspaceId = await createWorkspace();
      const p1 = await createProject(workspaceId);
      await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'X')", [
        workspaceId,
        p1,
      ]);

      const portalClient = await openConnection("nominara_portal");
      try {
        await withPortalContext(portalClient, workspaceId, [], async (tx) => {
          const rows = await tx.query("SELECT * FROM competitors");
          expect(rows.rowCount).toBe(0);
        });
      } finally {
        await portalClient.end();
      }
    });

    it("boundary — unset scope GUC (workspace context set, scope never set at all) → zero rows", async () => {
      const workspaceId = await createWorkspace();
      const p1 = await createProject(workspaceId);
      await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'X')", [
        workspaceId,
        p1,
      ]);

      const portalClient = await openConnection("nominara_portal");
      try {
        await portalClient.query("BEGIN");
        await portalClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [workspaceId]);
        const rows = await portalClient.query("SELECT * FROM competitors");
        expect(rows.rowCount).toBe(0);
        await portalClient.query("COMMIT");
      } finally {
        await portalClient.end();
      }
    });

    it("boundary — a project id from ANOTHER workspace placed in the scope array still yields zero rows (the workspace conjunct does real work)", async () => {
      // Fix pass item 3 — QA-reviewer proved the ORIGINAL fixture here could
      // never fail regardless of whether the workspace conjunct existed:
      // it seeded its row in workspace A and put workspace B's project id in
      // the scope array, so there was no row anywhere that could match BOTH
      // conditions. Deleting the workspace conjunct entirely from the
      // generated policy left this test green.
      //
      // The CORRECT fixture seeds the row in workspace B (under project
      // P_B, a project that genuinely has a matching row) and opens the
      // portal context as workspace A with scope_project_ids = [P_B]. If
      // the workspace conjunct weren't doing real work, `project_id = ANY
      // (app.current_scope_projects())` alone would match B's row and leak
      // it to a portal session scoped to A — the exact cross-tenant-leak
      // scenario AC 26 / ISO-09 exists to prevent.
      const workspaceA = await createWorkspace();
      const workspaceB = await createWorkspace();
      const projectOfB = await createProject(workspaceB);
      await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'X')", [
        workspaceB,
        projectOfB,
      ]);

      const portalClient = await openConnection("nominara_portal");
      try {
        await withPortalContext(portalClient, workspaceA, [projectOfB], async (tx) => {
          const rows = await tx.query("SELECT * FROM competitors");
          expect(rows.rowCount).toBe(0);
        });
      } finally {
        await portalClient.end();
      }
    });
  });

  // ======================================================================
  // Scenario 10 (ISO-10-adjacent) — the replica read path (nominara_report)
  // through the IDENTICAL withTenantContext.
  // ======================================================================

  it("scenario 10 — nominara_report through withTenantContext gets identical read enforcement (zero rows without context, tenant-A-only with A's context), but a WRITE fails at the grant layer", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const projectA = await createProject(workspaceA);
    const projectB = await createProject(workspaceB);
    await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'A')", [
      workspaceA,
      projectA,
    ]);
    await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'B')", [
      workspaceB,
      projectB,
    ]);

    const reportClient = await openConnection("nominara_report");
    try {
      // Zero rows without context.
      const withoutContext = await reportClient.query("SELECT * FROM competitors");
      expect(withoutContext.rowCount).toBe(0);

      // Tenant-A-only with A's context.
      await withTenantContext(
        reportClient,
        { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" },
        async (tx) => {
          const rows = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM competitors");
          expect(rows.rows.map((r) => r.workspace_id)).toEqual([workspaceA]);
        },
      );

      // A write fails at the GRANT layer (nominara_report has SELECT only) —
      // proving RLS and grants are two distinct, both-necessary layers.
      await withTenantContext(
        reportClient,
        { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" },
        async (tx) => {
          await expect(
            tx.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'C')", [
              workspaceA,
              projectA,
            ]),
          ).rejects.toThrow(/permission denied for table competitors/i);
          // Roll the transaction's own state back to a clean point so the
          // outer withTenantContext's own COMMIT doesn't try to commit an
          // aborted transaction.
          throw new Error("expected-rollback");
        },
      ).catch((error) => {
        expect((error as Error).message).toBe("expected-rollback");
      });
    } finally {
      await reportClient.end();
    }
  });

  // ======================================================================
  // Fix pass item 14 — AC 20 ("stable and parallel-safe so the planner can
  // inline them") had NO test anywhere in the suite. Confirmed by grep: zero
  // hits for provolatile/proparallel/STABLE/PARALLEL SAFE in any test file.
  // ======================================================================

  it("fix pass item 14 (AC 20) — app.current_workspace/current_actor/current_scope_projects are all STABLE and PARALLEL SAFE", async () => {
    const result = await client.query<{ proname: string; provolatile: string; proparallel: string }>(
      `SELECT proname, provolatile, proparallel
         FROM pg_proc
        WHERE pronamespace = 'app'::regnamespace
          AND proname IN ('current_workspace', 'current_actor', 'current_scope_projects')`,
    );
    expect(result.rowCount).toBe(3);
    for (const row of result.rows) {
      expect(row.provolatile, `${row.proname} is not STABLE`).toBe("s");
      expect(row.proparallel, `${row.proname} is not PARALLEL SAFE`).toBe("s");
    }
  });

  // ======================================================================
  // Fix pass item 15 — app.current_actor() was never exercised by anything:
  // no policy references it, and nothing proved the actor context set by
  // withTenantContext is actually readable through it inside a transaction.
  // This matters because the SYSTEM_ACTOR_ID design (STORY-011-E-4) depends
  // on actor attribution actually working end to end.
  // ======================================================================

  it("fix pass item 15 — app.current_actor() returns exactly the actorId withTenantContext set, inside the transaction", async () => {
    const workspaceId = await createWorkspace();
    const actorId = "00000000-0000-0000-0000-0000000000ab";
    const appClient = await openConnection("nominara_app");
    try {
      await withTenantContext(appClient, { workspaceId, actorId }, async (tx) => {
        const result = await tx.query<{ actor: string }>("SELECT app.current_actor() AS actor");
        expect(result.rows[0]!.actor).toBe(actorId);
      });
    } finally {
      await appClient.end();
    }
  });

  // ======================================================================
  // Fix pass item 16 — nothing tested that tenant context actually REVERTS
  // at commit, or that it doesn't bleed across sequential withTenantContext
  // calls on the SAME physical connection (the application-level equivalent
  // of STORY-010's raw-GUC pgBouncer-leak test, for the actual helper
  // function every future story will call).
  // ======================================================================

  it("fix pass item 16(a) — after a withTenantContext block commits, the SAME connection's context reverts to NULL", async () => {
    const workspaceId = await createWorkspace();
    const appClient = await openConnection("nominara_app");
    try {
      await withTenantContext(
        appClient,
        { workspaceId, actorId: "00000000-0000-0000-0000-0000000000aa" },
        async (tx) => {
          const inside = await tx.query<{ ws: string | null }>("SELECT app.current_workspace()::text AS ws");
          expect(inside.rows[0]!.ws).toBe(workspaceId);
        },
      );

      // Outside the block, on the exact same connection: reverted to NULL.
      const after = await appClient.query<{ ws: string | null }>("SELECT app.current_workspace()::text AS ws");
      expect(after.rows[0]!.ws).toBeNull();
    } finally {
      await appClient.end();
    }
  });

  it("fix pass item 16(b) — two sequential withTenantContext calls on the SAME connection never bleed A's rows into B's block", async () => {
    const workspaceA = await createWorkspace();
    const workspaceB = await createWorkspace();
    const projectA = await createProject(workspaceA);
    const projectB = await createProject(workspaceB);
    await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'A')", [
      workspaceA,
      projectA,
    ]);
    await client.query("INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, 'B')", [
      workspaceB,
      projectB,
    ]);

    const appClient = await openConnection("nominara_app");
    try {
      await withTenantContext(
        appClient,
        { workspaceId: workspaceA, actorId: "00000000-0000-0000-0000-0000000000aa" },
        async (tx) => {
          const rows = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM competitors");
          expect(rows.rows.map((r) => r.workspace_id)).toEqual([workspaceA]);
        },
      );

      // Same connection, SECOND withTenantContext call, different tenant —
      // must see ONLY B's rows, never any of A's.
      await withTenantContext(
        appClient,
        { workspaceId: workspaceB, actorId: "00000000-0000-0000-0000-0000000000bb" },
        async (tx) => {
          const rows = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM competitors");
          expect(rows.rows.map((r) => r.workspace_id)).toEqual([workspaceB]);
        },
      );
    } finally {
      await appClient.end();
    }
  });

  // ======================================================================
  // Fix pass item 22 — boundary-value tests for malformed GUC values on the
  // three accessor functions, pinning actual (not assumed) behavior.
  // ======================================================================

  describe("fix pass item 22 — malformed GUC boundary values", () => {
    it("an explicitly empty-string workspace GUC is treated as unset (NULLIF), same as never having been set", async () => {
      const appClient = await openConnection("nominara_app");
      try {
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('app.current_workspace_id', '', true)");
        const result = await appClient.query<{ ws: string | null }>("SELECT app.current_workspace()::text AS ws");
        expect(result.rows[0]!.ws).toBeNull();
        await appClient.query("COMMIT");
      } finally {
        await appClient.end();
      }
    });

    it("a malformed (non-UUID) workspace GUC value raises 22P02 (invalid_text_representation), pinned rather than left unspecified", async () => {
      const appClient = await openConnection("nominara_app");
      try {
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('app.current_workspace_id', 'not-a-uuid', true)");
        await expect(appClient.query("SELECT app.current_workspace()")).rejects.toMatchObject({ code: "22P02" });
        await appClient.query("ROLLBACK");
      } finally {
        await appClient.end();
      }
    });

    it("a trailing-comma/empty-element scope-projects GUC ('p1,') raises 22P02 — an empty array element does not cast to uuid", async () => {
      const appClient = await openConnection("nominara_app");
      const workspaceId = await createWorkspace();
      const p1 = await createProject(workspaceId);
      try {
        await appClient.query("BEGIN");
        await appClient.query("SELECT set_config('app.current_scope_projects', $1, true)", [`${p1},`]);
        await expect(appClient.query("SELECT app.current_scope_projects()")).rejects.toMatchObject({ code: "22P02" });
        await appClient.query("ROLLBACK");
      } finally {
        await appClient.end();
      }
    });
  });

  // ======================================================================
  // Migration hygiene.
  // ======================================================================

  describe("migration hygiene", () => {
    it("0006 is idempotent — re-applying its own SQL directly does not throw", async () => {
      const sql = await readFile(path.join(migrationsDir, "0006_generated_rls_policies.up.sql"), "utf8");
      await expect(client.query(sql)).resolves.toBeDefined();
    });

    it("rollback GENUINELY removes every policy and sets relrowsecurity=false on all tenant tables + partition children (mid-state assertion), and reapply restores the same set", async () => {
      const tables = await tenantTableNames();
      const partitionChildren = await client.query<{ relname: string }>(
        `SELECT c.relname FROM pg_inherits i
           JOIN pg_class c ON c.oid = i.inhrelid
           JOIN pg_class p ON p.oid = i.inhparent
          WHERE c.relkind = 'r' AND p.relkind = 'p'`,
      );
      const allNames = [...tables, ...partitionChildren.rows.map((r) => r.relname)];

      const beforePolicyCount = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public'",
      );

      const rolledBack = await rollbackLast(client, migrationsDir);
      expect(rolledBack).toBe("0006_generated_rls_policies");

      // Mid-state assertion, BEFORE reapply — a symmetric no-op down
      // migration must NOT pass this (STORY-010's review caught exactly
      // this bug class for migration 0005).
      const midPolicyCount = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public'",
      );
      expect(Number(midPolicyCount.rows[0]!.count)).toBe(0);

      const midFlags = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY($1::text[])",
        [allNames],
      );
      expect(midFlags.rowCount).toBe(allNames.length);
      for (const row of midFlags.rows) {
        expect(row.relrowsecurity).toBe(false);
        expect(row.relforcerowsecurity).toBe(false);
      }

      const fnCount = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM pg_proc WHERE pronamespace = 'app'::regnamespace AND proname IN ('current_workspace','current_actor','current_scope_projects','apply_tenant_rls')",
      );
      expect(Number(fnCount.rows[0]!.count)).toBe(0);

      const reapplied = await migrateUp(client, migrationsDir);
      expect(reapplied).toEqual(["0006_generated_rls_policies"]);

      const afterPolicyCount = await client.query<{ count: string }>(
        "SELECT count(*) AS count FROM pg_policies WHERE schemaname = 'public'",
      );
      expect(afterPolicyCount.rows[0]!.count).toBe(beforePolicyCount.rows[0]!.count);
    });
  });

  // ======================================================================
  // pg_policies structural sanity checks not already covered above.
  // ======================================================================

  it("every portal-readable table has a portal_scope_* policy, and none of the others do", async () => {
    const result = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'portal_scope_%'",
    );
    const actual = result.rows.map((r) => r.tablename).sort();
    expect(actual).toEqual([...PORTAL_READABLE_TABLES].sort());
  });
});
