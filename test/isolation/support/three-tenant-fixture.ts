import { createHash } from "node:crypto";
import type { Client } from "pg";
import { createUuidV7Generator } from "../../../src/lib/ids/uuidv7.js";

// STORY-012 T5/D-7 — the three-tenant fixture. Lives here, not
// src/db/seed/ (that is STORY-004's territory, currently skipped) — same
// shape so STORY-004 can adopt/wrap it later.
//
// Design: 50 PROJECTS per tenant (not 50 rows bolted onto 1-2 shared
// projects) is what makes "50 rows per tenant" achievable for tables with a
// genuine per-project uniqueness constraint (attribution_configs has a hard
// UNIQUE(project_id) — one row per project, ever). Every project-scoped
// table below maps row `i` to `projects[i]` 1:1, which trivially satisfies
// every per-project unique index in the schema. Workspace-scoped-only tables
// (no project_id) are seeded with 50 independently-unique rows directly.
//
// Two structural exceptions this fixture (and its own coverage spec) knows
// about and does NOT fight: `credit_wallets` (PRIMARY KEY (workspace_id)
// alone — one row per tenant, by construction) and `workspaces` itself
// (scoped by its own `id` — the tenant root, one row per tenant). See
// test/isolation/support/discovery.ts's discoverSingleRowPerTenantTables.
//
// D-7's four "awkward shapes", per tenant:
//   - projects[0]  — "Acme Single", the single-prompt project.
//   - projects[1]  — "Apple", a common-word brand name.
//   - projects[2]  — "Blue Ocean Roasters", a multi-word brand name.
//   - competitors[0]/[1] — "Cloud" / "Cloudflare Systems", a
//     substring-colliding competitor pair (proves isolation isn't achieved
//     by accidental substring/text matching).
export const ROW_COUNT = 50;

export interface TenantFixture {
  readonly label: string;
  readonly workspaceId: string;
  readonly ownerUserId: string;
  readonly userIds: string[];
  readonly projectIds: string[];
  readonly competitorIds: string[];
  readonly promptIds: string[];
  readonly runIds: string[];
  readonly resultIds: string[];
  readonly result2Ids: string[];
  readonly taskIds: string[];
  readonly auditIds: string[];
  readonly sourceDomainIds: string[];
  readonly shareTokenIds: string[];
  readonly subscriptionIds: string[];
}

function deterministicUuidGenerator(seed: string) {
  let invocation = 0;
  const clock = () => 1_700_000_000_000 + invocation;
  const randomBytes = (size: number) => {
    invocation += 1;
    const buf = Buffer.alloc(size);
    let filled = 0;
    let block = 0;
    while (filled < size) {
      const hash = createHash("sha256").update(`${seed}:${invocation}:${block}`).digest();
      const take = Math.min(size - filled, hash.length);
      hash.copy(buf, filled, 0, take);
      filled += take;
      block += 1;
    }
    return buf;
  };
  return createUuidV7Generator(clock, randomBytes);
}

function hashBuf(label: string): Buffer {
  return createHash("sha256").update(label).digest();
}

export async function ensureGlobalCatalog(client: Client): Promise<void> {
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
}

/** Seeds one tenant: a workspace plus >=50 rows in every one of the 59 discovered tenant tables. */
export async function seedTenant(client: Client, label: string): Promise<TenantFixture> {
  const id = deterministicUuidGenerator(`tenant-${label}`);
  const h = (suffix: string) => hashBuf(`${label}:${suffix}`);
  const R = ROW_COUNT;

  const workspaceId = id();
  await client.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, $2, $3, 'free')", [
    workspaceId,
    `Tenant ${label}`,
    `tenant-${label.toLowerCase()}`,
  ]);

  // ---- users (50, workspace_members needs one distinct user per row) ----
  const userIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const userId = id();
    await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [userId, `${label.toLowerCase()}-user-${i}@example.com`]);
    userIds.push(userId);
  }
  const ownerUserId = userIds[0]!;

  // ---- workspace-scoped 0002 tables ----
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO workspace_keys (workspace_id, dek_id, wrapped_dek, kms_key_arn, status) VALUES ($1, $2, 'x', 'arn:aws:kms:x', $3)",
      [workspaceId, `dek-${label}-${i}`, i === 0 ? "active" : "retired"],
    );
  }
  const ROLE_CYCLE = ["admin", "manager", "analyst", "viewer"];
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)", [
      workspaceId,
      userIds[i],
      i === 0 ? "owner" : ROLE_CYCLE[i % ROLE_CYCLE.length],
    ]);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, 'analyst', $3, $4, now() + interval '7 days')`,
      [workspaceId, `invitee-${label}-${i}@example.com`, h(`invite-${i}`), ownerUserId],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO sso_configurations (workspace_id, protocol, idp_entity_id, idp_sso_url, idp_certificate, email_domains, status)
       VALUES ($1, 'oidc', $2, 'https://idp.example/sso', 'cert', ARRAY['example.com']::citext[], $3)`,
      [workspaceId, `entity-${label}-${i}`, i === 0 ? "active" : "disabled"],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO api_keys (workspace_id, name, key_prefix, key_hash, permissions, created_by)
       VALUES ($1, 'Key', $2, $3, ARRAY['project:read'], $4)`,
      [workspaceId, `nk_live_${label}${i}`, h(`apikey-${i}`), ownerUserId],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, justification, ticket_ref, expires_at)
       VALUES ($1, $2, $3, 'metadata', 'debug', $4, now() + interval '1 day')`,
      [workspaceId, userIds[i], userIds[(i + 1) % R], `TICKET-${label}-${i}`],
    );
  }
  const subscriptionIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO subscriptions (workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id, status, current_period_start, current_period_end)
       VALUES ($1, 'starter', 'monthly', $2, $3, $4, now(), now() + interval '30 days')
       RETURNING id`,
      [workspaceId, `cus_${label}_${i}`, `sub_${label}_${i}`, i === 0 ? "active" : "canceled"],
    );
    subscriptionIds.push(result.rows[0]!.id);
  }
  // NEW-D-2 checkpoint-1 (migration 0074) — a stale-fetch mark per subscription.
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO stripe_subscription_syncs (workspace_id, stripe_subscription_id, fetch_started_at) VALUES ($1, $2, now())", [workspaceId, `sub_${label}_${i}`]);
  }
  // credit_wallets: PRIMARY KEY (workspace_id) alone — structurally ONE row per tenant.
  await client.query("INSERT INTO credit_wallets (workspace_id, cycle_start, cycle_end) VALUES ($1, CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days')", [
    workspaceId,
  ]);
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO credit_daily_counters (workspace_id, utc_date, action_code, limit_count) VALUES ($1, CURRENT_DATE - $2::int, 'lookup', 3)",
      [workspaceId, i],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      // `bucket` since STORY-073's migration 0023 — a `grant` that does not
      // name the balance it moved cannot be replayed, and
      // `ck_credit_ledger_bucket_scope` refuses it.
      `INSERT INTO credit_ledger (workspace_id, entry_type, credits, bucket, included_after, purchased_after, reserved_after, idempotency_key)
       VALUES ($1, 'grant', 10, 'included', 10, 0, 0, $2)`,
      [workspaceId, `idem-${label}-${i}`],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd) VALUES ($1, 'pack_a', 100, 10)", [
      workspaceId,
    ]);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO subscription_addons (workspace_id, subscription_id, kind, quantity, unit_price_usd, stripe_subscription_item_id, active_until)
       VALUES ($1, $2, $3, 1, 10, $4, $5)`,
      [
        workspaceId,
        subscriptionIds[i],
        i % 2 === 0 ? "extra_seat" : "extra_project",
        `si_${label}_${i}`,
        // ux_addons_active only allows ONE row per (workspace_id, kind) with
        // active_until IS NULL — i 0 and 1 (one of each kind) stay NULL/open,
        // every other row is already "closed".
        i < 2 ? null : new Date(Date.now() - 86_400_000),
      ],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO usage_counters (workspace_id, metric, period_start, limit_value) VALUES ($1, 'pdf_exports', CURRENT_DATE - $2::int, 10)",
      [workspaceId, i],
    );
  }
  // STORY-070 — one open reservation per counter row. The composite foreign
  // key means a reservation can only exist against a counter that exists, so
  // this loop follows the one above and reuses its period_start values.
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO usage_reservations (workspace_id, metric, job_id, period_start, quantity)
       VALUES ($1, 'pdf_exports', $2, CURRENT_DATE - $3::int, 1)`,
      [workspaceId, `job_${label}_${i}`, i],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO usage_ledger (workspace_id, metric, quantity, source) VALUES ($1, 'pdf_exports', 1, 'system')", [
      workspaceId,
    ]);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO invoices (workspace_id, stripe_invoice_id, status, subtotal, total, period_start, period_end)
       VALUES ($1, $2, 'paid', 10, 10, now(), now() + interval '30 days')`,
      [workspaceId, `inv_${label}_${i}`],
    );
  }

  // ---- 50 projects (0003), the backbone every project-scoped table maps 1:1 onto ----
  const projectIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const projectId = id();
    const name = i === 0 ? "Acme Single" : i === 1 ? "Apple" : i === 2 ? "Blue Ocean Roasters" : `Project ${label} ${i}`;
    await client.query(
      "INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, $4, 'https://example.com', $5)",
      [projectId, workspaceId, name, `project-${label.toLowerCase()}-${i}`, `site-${label.toLowerCase()}-${i}.example.com`],
    );
    projectIds.push(projectId);
  }

  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO project_engines (workspace_id, project_id, engine_key) VALUES ($1, $2, 'chatgpt')", [
      workspaceId,
      projectIds[i],
    ]);
  }

  const competitorIds: string[] = [];
  for (let i = 0; i < R; i++) {
    // D-7 awkward shape: a substring-colliding competitor pair.
    const name = i === 0 ? "Cloud" : i === 1 ? "Cloudflare Systems" : `Competitor ${i}`;
    const result = await client.query<{ id: string }>(
      "INSERT INTO competitors (workspace_id, project_id, name) VALUES ($1, $2, $3) RETURNING id",
      [workspaceId, projectIds[i], name],
    );
    competitorIds.push(result.rows[0]!.id);
  }

  const VERIFY_METHODS = ["dns_txt", "well_known_file", "meta_tag"];
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO domain_verifications (workspace_id, project_id, domain, method, nonce) VALUES ($1, $2, $3, $4, $5)",
      [workspaceId, projectIds[i], `verify-${label}-${i}.example.com`, VERIFY_METHODS[i % VERIFY_METHODS.length], `nonce-${label}-${i}`],
    );
  }

  const promptIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage)
       VALUES ($1, $2, $3, $4, 'recommendation', 'awareness')
       RETURNING id`,
      [workspaceId, projectIds[i], `prompt text ${label} ${i}`, h(`prompt-${i}`)],
    );
    promptIds.push(result.rows[0]!.id);
  }

  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO prompt_stability (workspace_id, prompt_id, engine_key, window_start, sample_count, presence_rate, sov_median, sov_iqr, entity_set_jsd)
       VALUES ($1, $2, 'chatgpt', CURRENT_DATE, 5, 0.8, 10, 2, 0.1)`,
      [workspaceId, promptIds[i]],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO topic_clusters (workspace_id, project_id, label) VALUES ($1, $2, $3)", [
      workspaceId,
      projectIds[i],
      `cluster-${label}-${i}`,
    ]);
  }

  const runIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>(
      "INSERT INTO capture_runs (workspace_id, project_id, trigger, engine_keys) VALUES ($1, $2, 'manual', ARRAY['chatgpt']) RETURNING id",
      [workspaceId, projectIds[i]],
    );
    runIds.push(result.rows[0]!.id);
  }

  const baseTime = Date.now();
  const resultIds: string[] = [];
  const result2Ids: string[] = [];
  for (let i = 0; i < R; i++) {
    const capturedAt = new Date(baseTime + i * 1000);
    const result = await client.query<{ id: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, $3, $4, 'chatgpt', $5, 'api', 'v1', 'v1', $6)
       RETURNING id`,
      [workspaceId, projectIds[i], runIds[i], promptIds[i], capturedAt, h(`capture-${i}`)],
    );
    resultIds.push(result.rows[0]!.id);

    const capturedAt2 = new Date(baseTime + i * 1000 + 500);
    const result2 = await client.query<{ id: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, $3, $4, 'chatgpt', $5, 'api', 'v1', 'v1', $6)
       RETURNING id`,
      [workspaceId, projectIds[i], runIds[i], promptIds[i], capturedAt2, h(`capture2-${i}`)],
    );
    result2Ids.push(result2.rows[0]!.id);
  }

  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          entity_type, entity_label, matched_alias, occurrence_index, char_start, char_end,
          first_token_index, prominence, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(), 'brand', 'Our Brand', 'Our Brand', 0, 0, 10, 0, 0.9, 'positive', 0.8, 0.9, 'lexicon')`,
      [workspaceId, projectIds[i], resultIds[i], promptIds[i]],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO citation_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, slot_index, raw_url, normalized_url, url_hash, domain, position_weight)
       VALUES ($1, $2, $3, $4, 'chatgpt', now(), 1, 'https://example.com/p', 'https://example.com/p', $5, 'example.com', 1.0)`,
      [workspaceId, projectIds[i], resultIds[i], promptIds[i], h(`citation-${i}`)],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO displacement_events (workspace_id, project_id, prompt_id, engine_key, kind, before_result_id, after_result_id, displaced_by)
       VALUES ($1, $2, $3, 'chatgpt', 'presence_lost', $4, $5, '[]'::jsonb)`,
      [workspaceId, projectIds[i], promptIds[i], resultIds[i], result2Ids[i]],
    );
  }

  // ---- 0004 tables ----
  const sourceDomainIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>("INSERT INTO source_domains (workspace_id, domain) VALUES ($1, $2) RETURNING id", [
      workspaceId,
      `source-${label}-${i}.example.com`,
    ]);
    sourceDomainIds.push(result.rows[0]!.id);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO project_source_index (workspace_id, project_id, source_domain_id, engine_key, window_start, window_days)
       VALUES ($1, $2, $3, 'chatgpt', CURRENT_DATE, 30)`,
      [workspaceId, projectIds[i], sourceDomainIds[i]],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date)
       VALUES ($1, $2, 'chatgpt', 'brand', $2, CURRENT_DATE)`,
      [workspaceId, projectIds[i]],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title) VALUES ($1, $2, now(), 'annotation', $3)", [
      workspaceId,
      projectIds[i],
      `Milestone ${i}`,
    ]);
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO notifications (workspace_id, kind, severity, title) VALUES ($1, 'info', 'info', $2)", [
      workspaceId,
      `Notice ${i}`,
    ]);
  }

  const auditIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer)
       VALUES ($1, $2, 'manual', ARRAY['https://example.com/'], 'v1', 'cl100k')
       RETURNING id`,
      [workspaceId, projectIds[i]],
    );
    auditIds.push(result.rows[0]!.id);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, severity, fingerprint, title, evidence, rule_version)
       VALUES ($1, $2, $3, 'AUX-1', 'medium', $4, 'Finding', '{}'::jsonb, 'v1')`,
      [workspaceId, projectIds[i], auditIds[i], h(`finding-${i}`)],
    );
  }

  const taskIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, dedupe_fingerprint, title, description)
       VALUES ($1, $2, $3, 'content', $4, 'Title', 'Description')
       RETURNING id`,
      [workspaceId, projectIds[i], `${label}-${i}`, h(`task-${i}`)],
    );
    taskIds.push(result.rows[0]!.id);
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO goals (workspace_id, project_id, title, kind, target) VALUES ($1, $2, 'Goal', 'custom', '{}'::jsonb)", [
      workspaceId,
      projectIds[i],
    ]);
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO task_events (workspace_id, task_id, event) VALUES ($1, $2, 'created')", [workspaceId, taskIds[i]]);
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO ref_counters (workspace_id, prefix) VALUES ($1, $2)", [workspaceId, `P${label}${i}`]);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO geo_analyses (workspace_id, project_id, analysis, window_start, window_days) VALUES ($1, $2, 'alignment', CURRENT_DATE, 30)",
      [workspaceId, projectIds[i]],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO entity_nodes (workspace_id, project_id, node) VALUES ($1, $2, 'wikidata')", [
      workspaceId,
      projectIds[i],
    ]);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO geo_alignments (workspace_id, project_id, target_url, engine_keys, embedding_model) VALUES ($1, $2, $3, ARRAY['chatgpt'], 'text-embedding-3-small')",
      [workspaceId, projectIds[i], `https://example.com/${label}/${i}`],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO content_chunks (workspace_id, project_id, url, chunk_index, text, token_count, content_hash)
       VALUES ($1, $2, $3, 0, 'text', 10, $4)`,
      [workspaceId, projectIds[i], `https://example.com/${label}/${i}`, h(`chunk-${i}`)],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO corpus_passages (workspace_id, project_id, citation_url_hash, url, domain, passage_index, text, token_count, content_hash, embedding_model, expires_at)
       VALUES ($1, $2, $3, $4, 'example.com', 0, 'text', 10, $5, 'text-embedding-3-small', now() + interval '30 days')`,
      [workspaceId, projectIds[i], h(`passageurl-${i}`), `https://example.com/${label}/${i}`, h(`passagecontent-${i}`)],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO semantic_nodes (workspace_id, project_id, phrase, phrase_normalized, node_type, evidence_url, evidence_snippet)
       VALUES ($1, $2, $3, $3, 'capability', $4, 'snippet')`,
      [workspaceId, projectIds[i], `phrase-${label}-${i}`, `https://example.com/${label}/${i}`],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO patches (workspace_id, project_id, target_url, kind, content_before_hash, content_after)
       VALUES ($1, $2, $3, 'markdown', $4, 'content')`,
      [workspaceId, projectIds[i], `https://example.com/${label}/${i}`, h(`patch-${i}`)],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO tool_runs (workspace_id, tool_key, input_hash, result_json, expires_at)
       VALUES ($1, 'schema_builder', $2, '{}'::jsonb, now() + interval '1 day')`,
      [workspaceId, h(`toolrun-${i}`)],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO attribution_configs (workspace_id, project_id, method, site_token, site_token_hash)
       VALUES ($1, $2, 'script', $3, $4)`,
      [workspaceId, projectIds[i], `token-${label}-${i}`, h(`attrtoken-${i}`)],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO attribution_daily
         (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, country, device)
       VALUES ($1, $2, CURRENT_DATE, $3, $4, 'chatgpt', 'US', 'desktop')`,
      [workspaceId, projectIds[i], h(`landingurl-${i}`), `https://example.com/${label}/${i}`],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO attribution_url_rollup (workspace_id, project_id, window_start, window_days, landing_url_hash, landing_url, pattern)
       VALUES ($1, $2, CURRENT_DATE, 30, $3, $4, 'dual_visibility')`,
      [workspaceId, projectIds[i], h(`rollupurl-${i}`), `https://example.com/${label}/${i}`],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO gsc_connections (workspace_id, project_id, property_url, property_type, credentials_enc, refresh_enc, dek_id, scopes)
       VALUES ($1, $2, $3, 'domain', $4, $5, 'dek-1', ARRAY['scope'])`,
      [workspaceId, projectIds[i], `https://example-${label}-${i}.com/`, `enc:${label}:${i}:credentials`, `enc:${label}:${i}:refresh`],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO gsc_daily (workspace_id, project_id, metric_date, report, dimension, page_url_hash, query_hash, country, device)
       VALUES ($1, $2, CURRENT_DATE, 'classic', 'page_query', $3, $4, 'US', 'desktop')`,
      [workspaceId, projectIds[i], h(`pageurl-${i}`), h(`queryhash-${i}`)],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO brand_themes (workspace_id, is_default) VALUES ($1, $2)", [workspaceId, i === 0]);
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO custom_domains (workspace_id, hostname, cname_target, verification_token) VALUES ($1, $2, 'cname.example.com', $3)",
      [workspaceId, `portal-${label}-${i}.example.com`, `token-${label}-${i}`],
    );
  }
  const shareTokenIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, created_by)
       VALUES ($1, 'Label', $2, $3, $4, $5)
       RETURNING id`,
      [workspaceId, h(`sharetoken-${i}`), `${label}${i}`.padEnd(8, "0").slice(0, 8), [projectIds[i]], ownerUserId],
    );
    shareTokenIds.push(result.rows[0]!.id);
  }
  for (let i = 0; i < R; i++) {
    await client.query("INSERT INTO share_token_views (workspace_id, share_token_id) VALUES ($1, $2)", [workspaceId, shareTokenIds[i]]);
  }
  const scheduledReportIds: string[] = [];
  for (let i = 0; i < R; i++) {
    const result = await client.query<{ id: string }>(
      "INSERT INTO scheduled_reports (workspace_id, name, project_ids, cadence, recipients) VALUES ($1, $2, $3, 'weekly', ARRAY['owner@example.com']::citext[]) RETURNING id",
      [workspaceId, `Report ${i}`, [projectIds[i]]],
    );
    scheduledReportIds.push(result.rows[0]!.id);
  }
  // NEW-E-1 (migration 0051) — delivery history, one row per scheduled report.
  for (let i = 0; i < R; i++) {
    await client.query(
      "INSERT INTO scheduled_report_deliveries (workspace_id, scheduled_report_id, status, recipient_count) VALUES ($1, $2, 'delivered', 1)",
      [workspaceId, scheduledReportIds[i]],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO report_artifacts (workspace_id, project_ids, period_start, period_end, format, object_key, bytes, methodology_footer, expires_at)
       VALUES ($1, $2, CURRENT_DATE, CURRENT_DATE, 'pdf', $3, 100, '{}'::jsonb, now() + interval '30 days')`,
      [workspaceId, [projectIds[i]], `key-${label}-${i}`],
    );
  }
  for (let i = 0; i < R; i++) {
    await client.query(
      `INSERT INTO audit_log (workspace_id, actor_type, action, resource_type, request_id, prev_hash, row_hash)
       VALUES ($1, 'user', 'workspace.create', 'workspace', $2, $3, $4)`,
      [workspaceId, `req-${label}-${i}`, Buffer.alloc(32, 0), h(`audit-${i}`)],
    );
  }

  return {
    label,
    workspaceId,
    ownerUserId,
    userIds,
    projectIds,
    competitorIds,
    promptIds,
    runIds,
    resultIds,
    result2Ids,
    taskIds,
    auditIds,
    sourceDomainIds,
    shareTokenIds,
    subscriptionIds,
  };
}

export interface ThreeTenantFixture {
  readonly a: TenantFixture;
  readonly b: TenantFixture;
  readonly c: TenantFixture;
}

export async function seedThreeTenantFixture(client: Client): Promise<ThreeTenantFixture> {
  await ensureGlobalCatalog(client);
  const a = await seedTenant(client, "A");
  const b = await seedTenant(client, "B");
  const c = await seedTenant(client, "C");
  return { a, b, c };
}
