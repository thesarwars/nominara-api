-- STORY-077 — owner decision 2026-10-23 (2): the downgrade pause/resume email is RETRIED on failure and never sent twice.
--
-- The plan writer (the Stripe webhook's cut-over, or the operator CLI plan:set) records each email here INSIDE its own
-- transaction, so a rolled-back change records nothing, and enqueues one signed tenant job (`billing.downgrade_notice`)
-- per row after the commit. The worker sends the row with no transaction open (ADR-0003) and sets `sent_at`.
--
--   * (workspace_id, request_id, kind) is the idempotency key: `request_id` is the Stripe event id or the operator's
--     ticket, so a redelivered event records nothing new and sends nothing twice;
--   * `sent_at IS NULL` is the outbox: a row whose job failed past its retries, or was never enqueued, stays visible;
--   * the address, subject and body are stored as rendered at the cut-over (the job payload carries the id only).
--
-- Expand-only: a new table, nothing existing is altered. Tenant-scoped, NOT portal-readable; the policy ships in this
-- migration (POLICY_IN_OWN_MIGRATION, the 0074 / 0125 precedent). Rows go with the workspace (ON DELETE CASCADE).
CREATE TABLE downgrade_notices (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id   text        NOT NULL CHECK (request_id <> ''),
  kind         text        NOT NULL CHECK (kind IN ('paused', 'resumed')),
  recipient    text        NOT NULL CHECK (recipient <> ''),
  subject      text        NOT NULL,
  text_body    text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  CONSTRAINT ux_downgrade_notices_request UNIQUE (workspace_id, request_id, kind)
);

-- The outbox read: what is still unsent, per workspace.
CREATE INDEX ix_downgrade_notices_unsent ON downgrade_notices (workspace_id) WHERE sent_at IS NULL;

COMMENT ON TABLE downgrade_notices IS
  'STORY-077 (owner 2026-10-23) — downgrade pause/resume emails recorded with the plan change and sent by the billing.downgrade_notice job. Tenant-scoped; not portal-readable.';

ALTER TABLE downgrade_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE downgrade_notices FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'downgrade_notices' AND policyname = 'ws_isolation_downgrade_notices'
  ) THEN
    CREATE POLICY ws_isolation_downgrade_notices ON downgrade_notices
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
