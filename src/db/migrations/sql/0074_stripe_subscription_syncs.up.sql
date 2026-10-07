-- NEW-D-2 checkpoint-1 — stale-fetch marks for Stripe reconciliation (STORY-075 AC4).
--
-- One row per (workspace, Stripe subscription): the instant, taken from THIS
-- database's clock, at which the Stripe fetch behind the newest reconciliation
-- of that subscription STARTED. Inside the workspace-locked transaction the
-- webhook handler skips a write whose fetch started before it, so a fetch taken
-- before a newer event's commit can never put an older state back.
--
-- Why a table and not 0049's subscriptions.provider_synced_at: that column can
-- only describe the subscription the row CURRENTLY tracks. A cancelled
-- subscription the row never adopted (created -> deleted racing on a free
-- workspace) left no mark at all, so the held `active` fetch then committed and
-- resurrected it, with a pro-rata grant. A mark must exist whether or not the
-- row adopts the subscription. 0049's column is left in place (contract phase).
--
-- Tenant-scoped, NOT portal-readable. The policy ships in this migration (see
-- POLICY_IN_OWN_MIGRATION), the 0051 precedent.
CREATE TABLE stripe_subscription_syncs (
  workspace_id           uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_subscription_id text        NOT NULL CHECK (stripe_subscription_id <> ''),
  fetch_started_at       timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, stripe_subscription_id)
);

COMMENT ON TABLE stripe_subscription_syncs IS
  'NEW-D-2 checkpoint-1 — latest Stripe fetch start per (workspace, subscription); orders stale webhook fetches. Tenant-scoped; not portal-readable.';

ALTER TABLE stripe_subscription_syncs ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_subscription_syncs FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'stripe_subscription_syncs' AND policyname = 'ws_isolation_stripe_subscription_syncs'
  ) THEN
    CREATE POLICY ws_isolation_stripe_subscription_syncs ON stripe_subscription_syncs
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
