-- STORY-068 — alert catalog, notifications and email digests. EXPAND-ONLY: two new tenant tables and four new nullable
-- columns; nothing existing is altered, renamed or dropped.
--
--   notifications.event_key       AC11 — dispatch is idempotent by event key. A partial UNIQUE index over
--                                 (workspace_id, event_key), so a retried job's INSERT ... ON CONFLICT DO NOTHING writes
--                                 nothing. NULL for the producers that still INSERT ad hoc (domain verification,
--                                 portal.first_view, report.skipped_cap): they keep working unchanged.
--   notification_reads            AC8 — read state is PER USER. One row per (notification, reader). A workspace-wide row
--                                 read by one member stays unread for the rest. `notifications.read_at` is left in place
--                                 (contract phase later); nothing reads it any more.
--   notification_emails           AC9 / AC10 / AC12 — the email outbox, the ONE send path for notification email: an
--                                 immediate email for a critical notification (`kind='immediate'`, one row per
--                                 recipient) and one digest per recipient per period (`kind='digest'`). An empty digest
--                                 is recorded as `skipped_empty` and never sent. (workspace_id, user_id, dedupe_key) is
--                                 the idempotency key, so a retried job records and sends nothing twice. The rendered
--                                 subject and body are stored; the ADDRESS is not (it is read live at send time).
--   workspace_members.digest_cadence  OWNER DECISION 2026-10-23 — each member's own digest cadence. NULL is "the role's
--                                 default": weekly for owner/admin/manager, off for analyst/viewer.
--   usage_counters.warned_at_95   OWNER DECISION 2026-10-23 — quota warnings at 80% AND 95% (scoring-models.md §15
--                                 `quota_threshold`). `warned_at_90` stays (expand phase) and is no longer written.
--
-- Both new tables are tenant-scoped and NOT portal-readable; their policies ship here (POLICY_IN_OWN_MIGRATION, the
-- 0074 / 0125 / 0134 precedent). Rows go with the workspace, the notification and the user (ON DELETE CASCADE).

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_key text CHECK (event_key IS NULL OR event_key <> '');
CREATE UNIQUE INDEX IF NOT EXISTS ux_notifications_event_key ON notifications (workspace_id, event_key) WHERE event_key IS NOT NULL;
-- The alert cooldown read: the latest notification of one kind for one project.
CREATE INDEX IF NOT EXISTS ix_notifications_kind_recent ON notifications (workspace_id, project_id, kind, created_at DESC);

ALTER TABLE workspace_members ADD COLUMN IF NOT EXISTS digest_cadence text CHECK (digest_cadence IS NULL OR digest_cadence IN ('off', 'daily', 'weekly'));

ALTER TABLE usage_counters ADD COLUMN IF NOT EXISTS warned_at_95 timestamptz;

CREATE TABLE notification_reads (
  workspace_id    uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  notification_id uuid        NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id         uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);
CREATE INDEX ix_notification_reads_user ON notification_reads (workspace_id, user_id);

COMMENT ON TABLE notification_reads IS
  'STORY-068 AC8 — per-user read receipts for notifications. Tenant-scoped; not portal-readable.';

CREATE TABLE notification_emails (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id            uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind               text        NOT NULL CHECK (kind IN ('immediate', 'digest')),
  dedupe_key         text        NOT NULL CHECK (dedupe_key <> ''),
  notification_id    uuid        REFERENCES notifications(id) ON DELETE CASCADE,
  cadence            text        CHECK (cadence IN ('daily', 'weekly')),
  period_start       timestamptz,
  period_end         timestamptz,
  notification_count integer     NOT NULL DEFAULT 0 CHECK (notification_count >= 0),
  status             text        NOT NULL CHECK (status IN ('pending', 'sent', 'skipped_empty')),
  subject            text,
  text_body          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  sent_at            timestamptz,
  CONSTRAINT ux_notification_emails_dedupe UNIQUE (workspace_id, user_id, dedupe_key),
  CONSTRAINT ck_notification_emails_shape CHECK (
    (kind = 'immediate' AND notification_id IS NOT NULL AND cadence IS NULL)
    OR (kind = 'digest' AND notification_id IS NULL AND cadence IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_end > period_start)),
  -- A row that will be sent carries what it sends; an empty digest carries nothing and is never sent.
  CONSTRAINT ck_notification_emails_body CHECK (
    (status = 'skipped_empty' AND kind = 'digest' AND notification_count = 0 AND sent_at IS NULL)
    OR (status <> 'skipped_empty' AND subject IS NOT NULL AND text_body IS NOT NULL)),
  CONSTRAINT ck_notification_emails_sent CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
-- The relay read: what is still unsent.
CREATE INDEX ix_notification_emails_pending ON notification_emails (created_at) WHERE status = 'pending';

COMMENT ON TABLE notification_emails IS
  'STORY-068 — the notification email outbox (immediate critical email and coalesced digests), sent by notify.dispatch. Tenant-scoped; not portal-readable.';

ALTER TABLE notification_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_reads FORCE  ROW LEVEL SECURITY;
ALTER TABLE notification_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_emails FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notification_reads' AND policyname = 'ws_isolation_notification_reads'
  ) THEN
    CREATE POLICY ws_isolation_notification_reads ON notification_reads
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'notification_emails' AND policyname = 'ws_isolation_notification_emails'
  ) THEN
    CREATE POLICY ws_isolation_notification_emails ON notification_emails
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
