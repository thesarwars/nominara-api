-- 0165_legal_holds_purge_runs: STORY-111. EXPAND-ONLY: two new tables, nothing existing is altered.
--
-- legal_holds (data-model.md section 7 "Legal hold", NFR-CMP-10): the ONLY exemption from any purge. A named workspace or project is
-- skipped by every purge until the hold expires or is released. Without a mechanism the first litigation request is served by someone
-- disabling the purge job, which silently suspends retention for every tenant and leaves no record.
--   * TWO-PERSON: requested_by and approved_by are both required and must differ (CHECK).
--   * A stated reason and an EXPIRY are required; a hold with no end is refused (CHECK expires_at > created_at).
--   * An expired hold needs no one to release it: "active" is the predicate (released_at IS NULL AND expires_at > now()), so the
--     subject is back on its normal purge schedule the instant the hold lapses. The sweep (releaseExpiredHolds) records the release.
--   * Audited: placing and releasing a hold each write an audit_log row in the held workspace's chain (src/lib/compliance/legal-hold.ts).
-- workspace_id is carried for the audit write and is deliberately NOT a foreign key: a hold must not be deletable by a cascade.
--
-- purge_runs (NFR-CMP-05, STORY-111 "purges are idempotent, batched, and their outcomes recorded per run"): one row per purge cycle with
-- counts only. A cycle that purged nothing is still a row, so "the purge ran and found nothing" is distinguishable from "the purge did not run".
--
-- Both are PLATFORM state written by the retention job's owner connection, in the class of audit_chain_marks: GLOBAL-classified (no RLS)
-- and granted to NO runtime role.
CREATE TABLE legal_holds (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text        NOT NULL CHECK (scope IN ('project', 'workspace')),
  scope_id      uuid        NOT NULL,
  workspace_id  uuid        NOT NULL,
  reason        text        NOT NULL CHECK (char_length(btrim(reason)) >= 10),
  requested_by  uuid        NOT NULL REFERENCES users(id),
  approved_by   uuid        NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  released_at   timestamptz,
  release_reason text       CHECK (release_reason IN ('expired', 'manual')),
  CONSTRAINT ck_legal_holds_two_person CHECK (requested_by <> approved_by),
  CONSTRAINT ck_legal_holds_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_legal_holds_release CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
CREATE INDEX ix_legal_holds_active ON legal_holds (scope, scope_id) WHERE released_at IS NULL;

CREATE TABLE purge_runs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at         timestamptz NOT NULL,
  finished_at        timestamptz NOT NULL,
  projects_purged    integer     NOT NULL CHECK (projects_purged >= 0),
  workspaces_purged  integer     NOT NULL CHECK (workspaces_purged >= 0),
  skipped_export_lock integer    NOT NULL CHECK (skipped_export_lock >= 0),
  skipped_legal_hold integer     NOT NULL CHECK (skipped_legal_hold >= 0),
  failed             integer     NOT NULL CHECK (failed >= 0),
  status             text        NOT NULL CHECK (status IN ('ok', 'partial')),
  CONSTRAINT ck_purge_runs_time CHECK (finished_at >= started_at)
);
CREATE INDEX ix_purge_runs_started ON purge_runs (started_at DESC);

-- subject_erasure_queue (owner decision 68b): an individual erasure requested while a legal hold covers a workspace of the subject is QUEUED here
-- and run when the hold lapses or is released. One pending row per subject; request_id is the id the audit trail and the operator already hold.
-- Holds ids and a status only: no email, no name. Same owner-only class as legal_holds.
CREATE TABLE subject_erasure_queue (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id           uuid        NOT NULL UNIQUE,
  user_id              uuid        REFERENCES users(id),
  requested_by         uuid        REFERENCES users(id),
  held_workspace_count integer     NOT NULL CHECK (held_workspace_count > 0),
  status               text        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'blocked')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  CONSTRAINT ck_subject_erasure_queue_finished CHECK ((status = 'pending') = (finished_at IS NULL)),
  -- An executed row has erased its subject: it keeps the request id and the outcome, never the subject's (or the requester's) id, so the
  -- request id on the surviving audit rows cannot be joined back to an erased user.
  CONSTRAINT ck_subject_erasure_queue_subject CHECK (user_id IS NOT NULL OR status = 'executed')
);
CREATE UNIQUE INDEX ux_subject_erasure_queue_pending ON subject_erasure_queue (user_id) WHERE status = 'pending';

COMMENT ON TABLE legal_holds IS
  'STORY-111 - the only exemption from a purge. Two distinct people, a reason, an expiry; the purge skips and reports held subjects. Owner-only; global-classified.';
COMMENT ON TABLE subject_erasure_queue IS
  'STORY-111 (decision 68b) - individual erasures deferred by a legal hold. Owner-only; global-classified.';
COMMENT ON TABLE purge_runs IS
  'STORY-111 - one row of counts per purge cycle. Owner-only; global-classified.';

REVOKE ALL ON legal_holds, purge_runs, subject_erasure_queue FROM nominara_app, nominara_worker, nominara_report, nominara_portal;
