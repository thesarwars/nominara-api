-- STORY-067 — the verification scheduler. EXPAND-ONLY: one new table, nothing existing is altered.
--
-- Completing a task schedules re-measurement at two horizons (+48 h, +14 d by default; product-spec FR-AP-05). One row per
-- (milestone, horizon) is that schedule: a durable, queryable record rather than a delayed queue job, because the schedule has to
-- be CANCELLED (a reopened task, a paused or deleted project) and a job already handed to Redis cannot be called back. A cancelled
-- row is kept, with its reason, so "why did this task never report an impact" has an answer. The hourly capture sweep reads the due
-- rows and enqueues; the `capture.plan` handler turns a due row into a `verification` capture run (charged nothing) scoped to the
-- task's prompt cluster; the sweep then settles it, and at the long horizon writes `milestones.measured_impact`.
--
--   horizon            'short' (+48 h) | 'long' (+14 d: the horizon the impact is computed at).
--   due_at             completion instant + the horizon, fixed AT SCHEDULING so a later config change does not move a pending row.
--   prompt_cluster_id  the task's cluster at scheduling; NULL = the task has no cluster, so the row captures nothing (a cheap,
--                      targeted run is the point) and the long horizon still computes its impact from the regular rollups.
--   status / outcome / cancel_reason / run_id   see contracts/tasks/task-verification.schema.ts.
--
-- Tenant-scoped, NOT portal-readable. The policy ships in this migration (POLICY_IN_OWN_MIGRATION, the 0134 precedent).
CREATE TABLE task_verifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id        uuid        NOT NULL REFERENCES projects(id)   ON DELETE CASCADE,
  task_id           uuid        NOT NULL REFERENCES tasks(id)      ON DELETE CASCADE,
  milestone_id      uuid        NOT NULL REFERENCES milestones(id) ON DELETE CASCADE,
  horizon           text        NOT NULL CHECK (horizon IN ('short', 'long')),
  due_at            timestamptz NOT NULL,
  prompt_cluster_id uuid,
  status            text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'canceled')),
  outcome           text        CHECK (outcome IN ('captured', 'no_capture', 'measured', 'insufficient_sample')),
  cancel_reason     text        CHECK (cancel_reason IN ('task_reopened', 'task_deleted', 'project_paused', 'project_deleted')),
  run_id            uuid        REFERENCES capture_runs(id) ON DELETE SET NULL,
  settled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ux_task_verifications_milestone_horizon UNIQUE (milestone_id, horizon),
  CONSTRAINT ck_task_verifications_outcome CHECK ((status = 'done') = (outcome IS NOT NULL)),
  CONSTRAINT ck_task_verifications_cancel CHECK ((status = 'canceled') = (cancel_reason IS NOT NULL))
);

-- The sweep's work lists: what is due, and what is running and awaits settling.
CREATE INDEX ix_task_verifications_due     ON task_verifications (due_at) WHERE status = 'pending';
CREATE INDEX ix_task_verifications_running ON task_verifications (created_at) WHERE status = 'running';
-- Cancelling by task (a reopen) and by project (a pause or delete).
CREATE INDEX ix_task_verifications_task    ON task_verifications (task_id) WHERE status IN ('pending', 'running');
CREATE INDEX ix_task_verifications_project ON task_verifications (project_id) WHERE status IN ('pending', 'running');

COMMENT ON TABLE task_verifications IS
  'STORY-067 — the +48h / +14d re-measurement schedule of a completed task. Cancelled rows are kept with their reason. Tenant-scoped; not portal-readable.';

ALTER TABLE task_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_verifications FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'task_verifications' AND policyname = 'ws_isolation_task_verifications'
  ) THEN
    CREATE POLICY ws_isolation_task_verifications ON task_verifications
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
