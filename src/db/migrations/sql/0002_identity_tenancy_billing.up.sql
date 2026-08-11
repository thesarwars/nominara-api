-- STORY-007: global identity, the tenant root and its keys, membership with
-- both ownership invariants, invitations, SSO configuration, service keys,
-- support grants, and the complete billing and credit table set.
-- Spec: schemas/identity-and-tenancy.md, schemas/billing-and-credits.md

-- A generic append-only guard, reusable by any table that must never be
-- mutated after the fact (credit_ledger here; the hash-chained audit log in
-- STORY-020 is the next known consumer).
CREATE OR REPLACE FUNCTION app.reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'read_only_sql_transaction';
END;
$$;

-- ============================================================================
-- plans — global catalog (schemas/billing-and-credits.md)
-- ============================================================================
CREATE TABLE plans (
  key                  text        PRIMARY KEY
                                   CHECK (key IN ('free','starter','growth','business','enterprise')),
  display_name         text        NOT NULL,
  monthly_price        numeric(12,2) NOT NULL,
  annual_price         numeric(12,2) NOT NULL,
  currency             char(3)     NOT NULL DEFAULT 'USD',
  stripe_product_id    text,
  stripe_price_monthly text,
  stripe_price_annual  text,
  credits_per_cycle    integer     NOT NULL DEFAULT 0,
  entitlements         jsonb       NOT NULL,
  is_public            boolean     NOT NULL DEFAULT true,
  sort_order           smallint    NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Seed values generated from src/db/seed/plan-entitlements.ts via
-- scripts/print-entitlements.mts, so the SQL literal and the zod-validated
-- TypeScript source cannot silently drift apart. Regenerate both together if
-- the matrix in plans-and-entitlements.md §2 ever changes.
INSERT INTO plans (key, display_name, monthly_price, annual_price, credits_per_cycle, sort_order, entitlements) VALUES
('free', 'Free', 0, 0, 60, 0, '{"price.monthly_usd":0,"price.annual_usd":null,"workspaces.owned_max":1,"projects.max":0,"projects.addon_allowed":false,"prompts.max_per_project":null,"prompts.max_total":0,"prompts.free_at_creation":null,"prompts.credits_per_generated":null,"seats.max":1,"seats.addon_allowed":false,"competitors.max_per_project":null,"engines.enabled":"none_tools_only","tools.engine_set":2,"tools.engines_selectable":false,"deep_scan.credits":null,"scan.cadence":null,"scan.runs_per_cycle":null,"scan.priority_subset_size":null,"credits.included_per_cycle":60,"credits.lookups_per_day_max":3,"credits.nlp_parses_per_day_max":20,"credits.rollover_purchased_months":12,"credits.packs_purchasable":true,"exports.pdf_per_cycle":0,"exports.csv":false,"share_links.enabled":false,"whitelabel.custom_domain":false,"whitelabel.remove_branding":false,"whitelabel.email_digest":false,"integrations.gsc":false,"optimizer.enabled":false,"aux.scheduled_audits":false,"api.keys_max":0,"sso.oidc":false,"scim.provisioning":false,"audit_log.export":false,"drift_sampling.enabled":false,"retention.raw_captures_days":30,"retention.rollups_days":null,"residency.region_choice":"us-east-1","sla.uptime":null,"support.response_target_hours":"community","fair_use.captures_per_cycle":40,"no_shared_cache":false}'::jsonb),
('starter', 'Starter', 49, 490, 450, 1, '{"price.monthly_usd":49,"price.annual_usd":490,"workspaces.owned_max":1,"projects.max":1,"projects.addon_allowed":false,"prompts.max_per_project":30,"prompts.max_total":30,"prompts.free_at_creation":10,"prompts.credits_per_generated":1,"seats.max":3,"seats.addon_allowed":true,"competitors.max_per_project":10,"engines.enabled":"3_core","tools.engine_set":3,"tools.engines_selectable":false,"deep_scan.credits":100,"scan.cadence":"weekly","scan.runs_per_cycle":4,"scan.priority_subset_size":null,"credits.included_per_cycle":450,"credits.lookups_per_day_max":null,"credits.nlp_parses_per_day_max":null,"credits.rollover_purchased_months":12,"credits.packs_purchasable":true,"exports.pdf_per_cycle":0,"exports.csv":false,"share_links.enabled":false,"whitelabel.custom_domain":false,"whitelabel.remove_branding":false,"whitelabel.email_digest":false,"integrations.gsc":false,"optimizer.enabled":"unlimited","aux.scheduled_audits":"1_per_project_per_month","api.keys_max":0,"sso.oidc":false,"scim.provisioning":false,"audit_log.export":false,"drift_sampling.enabled":false,"retention.raw_captures_days":90,"retention.rollups_days":395,"residency.region_choice":"us-east-1","sla.uptime":null,"support.response_target_hours":48,"fair_use.captures_per_cycle":1200,"no_shared_cache":false}'::jsonb),
('growth', 'Growth', 129, 1290, 1200, 2, '{"price.monthly_usd":129,"price.annual_usd":1290,"workspaces.owned_max":1,"projects.max":3,"projects.addon_allowed":true,"prompts.max_per_project":40,"prompts.max_total":120,"prompts.free_at_creation":10,"prompts.credits_per_generated":1,"seats.max":7,"seats.addon_allowed":true,"competitors.max_per_project":10,"engines.enabled":4,"tools.engine_set":4,"tools.engines_selectable":false,"deep_scan.credits":200,"scan.cadence":"twice_weekly","scan.runs_per_cycle":8,"scan.priority_subset_size":null,"credits.included_per_cycle":1200,"credits.lookups_per_day_max":null,"credits.nlp_parses_per_day_max":null,"credits.rollover_purchased_months":12,"credits.packs_purchasable":true,"exports.pdf_per_cycle":25,"exports.csv":true,"share_links.enabled":"10_active","whitelabel.custom_domain":false,"whitelabel.remove_branding":false,"whitelabel.email_digest":false,"integrations.gsc":true,"optimizer.enabled":true,"aux.scheduled_audits":"1_per_project_per_month","api.keys_max":0,"sso.oidc":false,"scim.provisioning":false,"audit_log.export":false,"drift_sampling.enabled":false,"retention.raw_captures_days":180,"retention.rollups_days":730,"residency.region_choice":"us-east-1","sla.uptime":99.5,"support.response_target_hours":24,"fair_use.captures_per_cycle":6000,"no_shared_cache":false}'::jsonb),
('business', 'Business', 349, 3490, 3000, 3, '{"price.monthly_usd":349,"price.annual_usd":3490,"workspaces.owned_max":1,"projects.max":5,"projects.addon_allowed":true,"prompts.max_per_project":50,"prompts.max_total":250,"prompts.free_at_creation":10,"prompts.credits_per_generated":1,"seats.max":20,"seats.addon_allowed":true,"competitors.max_per_project":10,"engines.enabled":6,"tools.engine_set":4,"tools.engines_selectable":false,"deep_scan.credits":500,"scan.cadence":"daily_priority","scan.runs_per_cycle":"4_full_plus_26_priority","scan.priority_subset_size":50,"credits.included_per_cycle":3000,"credits.lookups_per_day_max":null,"credits.nlp_parses_per_day_max":null,"credits.rollover_purchased_months":12,"credits.packs_purchasable":true,"exports.pdf_per_cycle":"unlimited","exports.csv":true,"share_links.enabled":"50_active","whitelabel.custom_domain":true,"whitelabel.remove_branding":true,"whitelabel.email_digest":"weekly","integrations.gsc":true,"optimizer.enabled":true,"aux.scheduled_audits":"1_per_project_per_month_plus_post_fix","api.keys_max":3,"sso.oidc":false,"scim.provisioning":false,"audit_log.export":true,"drift_sampling.enabled":"le_20_prompts","retention.raw_captures_days":395,"retention.rollups_days":1095,"residency.region_choice":"us_or_eu","sla.uptime":99.9,"support.response_target_hours":"8_business_hours","fair_use.captures_per_cycle":22000,"no_shared_cache":false}'::jsonb),
('enterprise', 'Enterprise', 0, 0, 0, 4, '{"price.monthly_usd":"custom","price.annual_usd":"custom","workspaces.owned_max":1,"projects.max":"custom","projects.addon_allowed":null,"prompts.max_per_project":"custom","prompts.max_total":"uncapped","prompts.free_at_creation":10,"prompts.credits_per_generated":1,"seats.max":"unlimited","seats.addon_allowed":null,"competitors.max_per_project":"custom","engines.enabled":"all_6_plus_private","tools.engine_set":4,"tools.engines_selectable":false,"deep_scan.credits":"negotiated","scan.cadence":"hourly_priority","scan.runs_per_cycle":"negotiated","scan.priority_subset_size":"50_default","credits.included_per_cycle":"custom","credits.lookups_per_day_max":null,"credits.nlp_parses_per_day_max":null,"credits.rollover_purchased_months":12,"credits.packs_purchasable":true,"exports.pdf_per_cycle":"unlimited","exports.csv":true,"share_links.enabled":"unlimited","whitelabel.custom_domain":true,"whitelabel.remove_branding":true,"whitelabel.email_digest":"configurable","integrations.gsc":true,"optimizer.enabled":true,"aux.scheduled_audits":"configurable","api.keys_max":"uncapped","sso.oidc":true,"scim.provisioning":true,"audit_log.export":true,"drift_sampling.enabled":true,"retention.raw_captures_days":1095,"retention.rollups_days":"unlimited","residency.region_choice":"any_supported","sla.uptime":99.95,"support.response_target_hours":"1_24_7","fair_use.captures_per_cycle":"negotiated","no_shared_cache":"optional"}'::jsonb);

-- ============================================================================
-- users — global (schemas/identity-and-tenancy.md)
-- ============================================================================
CREATE TABLE users (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email               citext      NOT NULL,
  email_verified_at   timestamptz,
  full_name           text,
  avatar_url          text,
  locale              text        NOT NULL DEFAULT 'en-US',
  timezone            text        NOT NULL DEFAULT 'UTC',
  persona_org_type    text        CHECK (persona_org_type IN ('in_house','agency')),
  persona_volume_band text        CHECK (persona_volume_band IN ('lt_1k','1k_10k','10k_100k','gt_100k')),
  persona_focus       text        CHECK (persona_focus IN ('ecommerce','technical_seo','corporate_pr','mixed')),
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','unverified','suspended','deleted')),
  last_login_at       timestamptz,
  mfa_required        boolean     NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz
);
CREATE UNIQUE INDEX ux_users_email    ON users (email) WHERE deleted_at IS NULL;
CREATE INDEX ix_users_email_trgm      ON users USING gin (email gin_trgm_ops);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- user_credentials — global
-- ============================================================================
CREATE TABLE user_credentials (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                text        NOT NULL CHECK (kind IN ('passkey','oauth','saml','oidc')),
  provider            text,
  external_subject    text,
  credential_id       bytea,
  public_key          bytea,
  sign_count          bigint      NOT NULL DEFAULT 0,
  transports          text[],
  device_label        text,
  last_used_at        timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_credentials_webauthn ON user_credentials (credential_id)
  WHERE credential_id IS NOT NULL;
CREATE UNIQUE INDEX ux_credentials_oauth ON user_credentials (provider, external_subject)
  WHERE kind IN ('oauth','saml','oidc');

-- ============================================================================
-- workspaces — the tenant root
-- ============================================================================
CREATE TABLE workspaces (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name                  text        NOT NULL,
  slug                  citext      NOT NULL,
  org_type              text        NOT NULL DEFAULT 'in_house'
                                    CHECK (org_type IN ('in_house','agency')),
  region                text        NOT NULL DEFAULT 'us-east-1'
                                    CHECK (region IN ('us-east-1','eu-central-1')),
  timezone              text        NOT NULL DEFAULT 'UTC',
  plan_key              text        NOT NULL REFERENCES plans(key),
  entitlement_version   integer     NOT NULL DEFAULT 1,
  entitlement_overrides jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status                text        NOT NULL DEFAULT 'active'
                                    CHECK (status IN ('trialing','active','past_due','soft_capped',
                                                      'suspended','pending_deletion','deleted')),
  billing_email         citext,
  scoring_version       text        NOT NULL DEFAULT 'v1',
  data_retention_days   integer     NOT NULL DEFAULT 180,
  dsar_contact_email    citext,
  ownership_transfer    jsonb,
  deletion_requested_at timestamptz,
  deletion_execute_at   timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);
CREATE UNIQUE INDEX ux_workspaces_slug ON workspaces (slug) WHERE deleted_at IS NULL;
CREATE INDEX ix_workspaces_status      ON workspaces (status) WHERE deleted_at IS NULL;
CREATE INDEX ix_workspaces_deletion    ON workspaces (deletion_execute_at)
  WHERE deletion_execute_at IS NOT NULL;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- workspace_keys — envelope-encryption DEKs
-- ============================================================================
CREATE TABLE workspace_keys (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dek_id              text        NOT NULL,
  wrapped_dek         bytea       NOT NULL,
  kms_key_arn         text        NOT NULL,
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','retiring','retired')),
  activated_at        timestamptz NOT NULL DEFAULT now(),
  retired_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_workspace_keys_dek    ON workspace_keys (workspace_id, dek_id);
CREATE UNIQUE INDEX ux_workspace_keys_active ON workspace_keys (workspace_id) WHERE status = 'active';

-- ============================================================================
-- workspace_members — the bridge between identity and data
-- ============================================================================
CREATE TABLE workspace_members (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                text        NOT NULL CHECK (role IN
                        ('owner','admin','manager','analyst','viewer')),
  project_scope       uuid[],
  status              text        NOT NULL DEFAULT 'active'
                                  CHECK (status IN ('active','suspended','removed')),
  invited_by          uuid        REFERENCES users(id),
  joined_at           timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_members_ws_user ON workspace_members (workspace_id, user_id)
  WHERE status <> 'removed';

-- Invariant 1: exactly one live owner per workspace.
CREATE UNIQUE INDEX ux_members_single_owner ON workspace_members (workspace_id)
  WHERE role = 'owner' AND status = 'active';

-- Invariant 2 (FR-WS-01): a user owns at most one workspace, ever. Enforced
-- here, in the database, so no application path, race, or migration can
-- create a second owned workspace.
CREATE UNIQUE INDEX ux_one_owned_workspace_per_user ON workspace_members (user_id)
  WHERE role = 'owner' AND status = 'active';

CREATE INDEX ix_members_user ON workspace_members (user_id, status);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON workspace_members
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- workspace_invitations
-- ============================================================================
CREATE TABLE workspace_invitations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email               citext      NOT NULL,
  role                text        NOT NULL,
  project_scope       uuid[],
  token_hash          bytea       NOT NULL,
  invited_by          uuid        NOT NULL REFERENCES users(id),
  expires_at          timestamptz NOT NULL,
  accepted_at         timestamptz,
  accepted_user_id    uuid        REFERENCES users(id),
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_invitations_token   ON workspace_invitations (token_hash);
CREATE UNIQUE INDEX ux_invitations_pending ON workspace_invitations (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ============================================================================
-- sso_configurations
-- ============================================================================
CREATE TABLE sso_configurations (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  protocol            text        NOT NULL CHECK (protocol IN ('saml','oidc')),
  idp_entity_id       text        NOT NULL,
  idp_sso_url         text        NOT NULL,
  idp_certificate     text        NOT NULL,
  client_secret_enc   text,
  dek_id              text,
  email_domains       citext[]    NOT NULL,
  jit_provisioning    boolean     NOT NULL DEFAULT true,
  default_role        text        NOT NULL DEFAULT 'analyst',
  scim_token_hash     bytea,
  enforce_sso_only    boolean     NOT NULL DEFAULT false,
  status              text        NOT NULL DEFAULT 'pending'
                                  CHECK (status IN ('pending','active','disabled')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_sso_workspace ON sso_configurations (workspace_id) WHERE status <> 'disabled';
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON sso_configurations
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- api_keys
-- ============================================================================
CREATE TABLE api_keys (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                text        NOT NULL,
  key_prefix          text        NOT NULL,
  key_hash            bytea       NOT NULL,
  permissions         text[]      NOT NULL,
  project_scope       uuid[],
  created_by          uuid        NOT NULL REFERENCES users(id),
  last_used_at        timestamptz,
  last_used_ip        inet,
  expires_at          timestamptz,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_api_keys_hash ON api_keys (key_hash);
CREATE INDEX ix_api_keys_ws ON api_keys (workspace_id) WHERE revoked_at IS NULL;

-- ============================================================================
-- support_grants — dual-control, self-approval impossible at the schema level
-- ============================================================================
CREATE TABLE support_grants (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by        uuid        NOT NULL REFERENCES users(id),
  approved_by         uuid        NOT NULL REFERENCES users(id),
  scope               text        NOT NULL CHECK (scope IN ('metadata','findings','full')),
  allow_write         boolean     NOT NULL DEFAULT false,
  justification       text        NOT NULL,
  ticket_ref          text        NOT NULL,
  expires_at          timestamptz NOT NULL,
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_support_dual_control CHECK (approved_by <> requested_by)
);
CREATE INDEX ix_support_grants_active ON support_grants (workspace_id, expires_at)
  WHERE revoked_at IS NULL;

-- ============================================================================
-- subscriptions
-- ============================================================================
CREATE TABLE subscriptions (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  plan_key               text        NOT NULL REFERENCES plans(key),
  billing_interval       text        NOT NULL CHECK (billing_interval IN ('monthly','annual')),
  stripe_customer_id     text        NOT NULL,
  stripe_subscription_id text        NOT NULL,
  status                 text        NOT NULL CHECK (status IN
                           ('trialing','active','past_due','canceled','incomplete','paused')),
  current_period_start   timestamptz NOT NULL,
  current_period_end     timestamptz NOT NULL,
  trial_ends_at          timestamptz,
  cancel_at_period_end   boolean     NOT NULL DEFAULT false,
  seats_purchased        integer     NOT NULL DEFAULT 1,
  projects_purchased     integer     NOT NULL DEFAULT 0,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_subscriptions_stripe ON subscriptions (stripe_subscription_id);
CREATE UNIQUE INDEX ux_subscriptions_active ON subscriptions (workspace_id)
  WHERE status IN ('trialing','active','past_due');
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- credit_wallets — high update churn: reduced fillfactor, aggressive vacuum
-- ============================================================================
CREATE TABLE credit_wallets (
  workspace_id             uuid        PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  included_balance         integer     NOT NULL DEFAULT 0,
  purchased_balance        integer     NOT NULL DEFAULT 0,
  reserved                 integer     NOT NULL DEFAULT 0,
  lifetime_granted         bigint      NOT NULL DEFAULT 0,
  lifetime_purchased       bigint      NOT NULL DEFAULT 0,
  lifetime_spent           bigint      NOT NULL DEFAULT 0,
  cycle_start              date        NOT NULL,
  cycle_end                date        NOT NULL,
  warned_at_25pct          timestamptz,
  warned_at_10pct          timestamptz,
  depleted_at              timestamptz,
  auto_topup_enabled       boolean     NOT NULL DEFAULT false,
  auto_topup_pack_key      text,
  auto_topup_threshold     integer,
  auto_topup_max_per_cycle integer,
  auto_topup_count_cycle   smallint    NOT NULL DEFAULT 0,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_wallet_nonneg   CHECK (included_balance >= 0 AND purchased_balance >= 0
                                       AND reserved >= 0),
  CONSTRAINT ck_wallet_reserved CHECK (reserved <= included_balance + purchased_balance),
  CONSTRAINT ck_autotopup_bounded CHECK (
    NOT auto_topup_enabled OR (auto_topup_pack_key IS NOT NULL
                               AND auto_topup_threshold > 0
                               AND auto_topup_max_per_cycle BETWEEN 1 AND 20))
)
WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON credit_wallets
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- credit_daily_counters — a separate, abuse-control mechanism from the wallet
-- ============================================================================
CREATE TABLE credit_daily_counters (
  workspace_id  uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  utc_date      date        NOT NULL,
  action_code   text        NOT NULL CHECK (action_code IN ('lookup','nlp_command')),
  used_count    integer     NOT NULL DEFAULT 0,
  limit_count   integer     NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, utc_date, action_code),
  CONSTRAINT ck_daily_nonneg CHECK (used_count >= 0)
);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON credit_daily_counters
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- credit_ledger — append-only, the billing source of truth
--
-- workspace_id REFERENCES workspaces(id) ON DELETE CASCADE — every other
-- workspace-scoped table in billing-and-credits.md carries this clause
-- literally; credit_ledger's original DDL snippet omitted it despite its own
-- prose stating the table "is cascade-deleted with its workspace," which only
-- a real FK can produce. Fixed at the source: schemas/billing-and-credits.md
-- now carries the clause too, so the reference and this migration agree.
--
-- KNOWN OPEN CONSTRAINT for whoever builds workspace hard-delete: Postgres
-- fires a table's own row triggers for cascade-originated deletes, so the
-- reject_update_delete trigger below currently blocks this cascade from ever
-- completing — deleting a workspace with any ledger history fails closed
-- today (see test/integration/identity-tenancy-billing.spec.ts). The
-- hard-delete sequence will need to explicitly bypass this trigger for that
-- one controlled, export-then-purge operation. Not this story's to solve —
-- see reports/STORY-007.md for the full reasoning.
-- ============================================================================
CREATE TABLE credit_ledger (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id        uuid,
  actor_id          uuid        REFERENCES users(id),
  actor_type        text        NOT NULL DEFAULT 'user'
                                CHECK (actor_type IN ('user','api_key','system')),
  entry_type        text        NOT NULL CHECK (entry_type IN
                      ('grant','purchase','reserve','commit','release','refund',
                       'expire','adjustment')),
  action_code       text        CHECK (action_code IN
                      ('lookup','manual_scan','nlp_command','aux_manual','prompt_activate','other')),
  credits           integer     NOT NULL,
  bucket            text        CHECK (bucket IN ('included','purchased')),
  included_after    integer     NOT NULL,
  purchased_after   integer     NOT NULL,
  reserved_after    integer     NOT NULL,
  reference_type    text,
  reference_id      uuid,
  idempotency_key   text        NOT NULL,
  unit_detail       jsonb,
  internal_cost_usd numeric(10,6),
  reason            text,
  occurred_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_credit_ledger_idem ON credit_ledger (workspace_id, entry_type, idempotency_key);
CREATE INDEX ix_credit_ledger_ws_time  ON credit_ledger (workspace_id, occurred_at DESC);
CREATE INDEX ix_credit_ledger_project  ON credit_ledger (workspace_id, project_id, occurred_at DESC);
CREATE INDEX ix_credit_ledger_ref      ON credit_ledger (reference_type, reference_id);
CREATE INDEX ix_credit_ledger_brin     ON credit_ledger USING brin (occurred_at);
CREATE TRIGGER reject_update_delete
  BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- ============================================================================
-- credit_packs — global catalog
-- ============================================================================
CREATE TABLE credit_packs (
  key             text        PRIMARY KEY,
  display_name    text        NOT NULL,
  credits         integer     NOT NULL,
  price_usd       numeric(12,2) NOT NULL,
  currency        char(3)     NOT NULL DEFAULT 'USD',
  stripe_price_id text,
  min_plan_key    text        REFERENCES plans(key),
  is_public       boolean     NOT NULL DEFAULT true,
  sort_order      smallint    NOT NULL DEFAULT 0
);

-- ============================================================================
-- credit_purchases
-- ============================================================================
CREATE TABLE credit_purchases (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  pack_key                 text        NOT NULL REFERENCES credit_packs(key),
  credits                  integer     NOT NULL,
  amount_usd               numeric(12,2) NOT NULL,
  source                   text        NOT NULL DEFAULT 'manual'
                                       CHECK (source IN ('manual','auto_topup','sales_grant')),
  stripe_payment_intent_id text,
  stripe_invoice_id        text,
  status                   text        NOT NULL DEFAULT 'pending'
                                       CHECK (status IN ('pending','succeeded','failed','refunded')),
  expires_at               timestamptz,
  purchased_by             uuid        REFERENCES users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_credit_purchases_pi ON credit_purchases (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE INDEX ix_credit_purchases_ws  ON credit_purchases (workspace_id, created_at DESC);
CREATE INDEX ix_credit_purchases_exp ON credit_purchases (expires_at) WHERE status = 'succeeded';
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON credit_purchases
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- subscription_addons
-- ============================================================================
CREATE TABLE subscription_addons (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id             uuid        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  kind                        text        NOT NULL CHECK (kind IN ('extra_project','extra_seat')),
  quantity                    integer     NOT NULL CHECK (quantity > 0),
  unit_price_usd              numeric(12,2) NOT NULL,
  stripe_subscription_item_id text        NOT NULL,
  active_from                 timestamptz NOT NULL DEFAULT now(),
  active_until                timestamptz,
  created_by                  uuid        REFERENCES users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_addons_active ON subscription_addons (workspace_id, kind)
  WHERE active_until IS NULL;
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON subscription_addons
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- usage_counters — non-credit tier caps only. High update churn like the
-- wallet: same fillfactor/vacuum tuning.
-- ============================================================================
CREATE TABLE usage_counters (
  workspace_id   uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  metric         text        NOT NULL CHECK (metric IN
                   ('pdf_exports','fair_use_captures','embed_tokens','arbiter_tokens')),
  period_start   date        NOT NULL,
  limit_value    bigint      NOT NULL,
  used_value     bigint      NOT NULL DEFAULT 0,
  reserved_value bigint      NOT NULL DEFAULT 0,
  billable       boolean     NOT NULL DEFAULT false,
  warned_at_80   timestamptz,
  warned_at_90   timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, metric, period_start),
  CONSTRAINT ck_usage_nonneg CHECK (used_value >= 0 AND reserved_value >= 0)
)
WITH (fillfactor = 70, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
CREATE TRIGGER touch_updated_at BEFORE UPDATE ON usage_counters
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ============================================================================
-- usage_ledger — internal cost attribution, distinct from credit_ledger.
-- workspace_id REFERENCES workspaces(id) ON DELETE CASCADE, same fix as
-- credit_ledger above and now reflected in schemas/billing-and-credits.md.
-- ============================================================================
CREATE TABLE usage_ledger (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id       uuid,
  metric           text        NOT NULL,
  quantity         integer     NOT NULL,
  unit_cost_usd    numeric(10,6),
  engine_key       text,
  source           text        NOT NULL CHECK (source IN
                     ('scheduled_run','manual_run','lookup','aux','optimizer','report','system')),
  credits_charged  integer     NOT NULL DEFAULT 0,
  credit_ledger_id uuid,
  reference_type   text,
  reference_id     uuid,
  cache_layer      text        CHECK (cache_layer IN ('live','l1','l2','l3')),
  occurred_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_usage_ledger_ws_time ON usage_ledger (workspace_id, occurred_at DESC);
CREATE INDEX ix_usage_ledger_project ON usage_ledger (workspace_id, project_id, occurred_at DESC);
CREATE INDEX ix_usage_ledger_brin    ON usage_ledger USING brin (occurred_at);

-- ============================================================================
-- invoices — a read model driven by provider webhooks
-- ============================================================================
CREATE TABLE invoices (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_invoice_id  text        NOT NULL,
  number             text,
  status             text        NOT NULL CHECK (status IN
                       ('draft','open','paid','uncollectible','void')),
  subtotal           numeric(12,2) NOT NULL,
  addon_amount       numeric(12,2) NOT NULL DEFAULT 0,
  credit_pack_amount numeric(12,2) NOT NULL DEFAULT 0,
  total              numeric(12,2) NOT NULL,
  currency           char(3)     NOT NULL DEFAULT 'USD',
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  hosted_invoice_url text,
  pdf_url            text,
  paid_at            timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_invoices_stripe ON invoices (stripe_invoice_id);
