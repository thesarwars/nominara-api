-- STORY-070 AC4 — "Failure releases the reservation idempotently by job
-- identifier, so a retried compensation does not over-release."
--
-- WHY A ROW PER RESERVATION, RATHER THAN A COLUMN ON usage_counters.
-- `usage_counters` holds three aggregates — limit, used, reserved — and an
-- aggregate cannot say WHO reserved what. Release without that is a naked
-- decrement, and a naked decrement is not idempotent: a compensation that is
-- retried (a worker crash between the release and its acknowledgement, a
-- queue redelivery) subtracts twice, the counter drifts low, and the customer
-- silently gets more than their cap. The story calls this out by name.
--
-- The `state` column is what carries the idempotency, and it is in the
-- release's WHERE clause rather than in application code: the second release
-- of one job matches no row, so it decrements nothing. Same shape as the
-- reservation's own sufficiency test — the condition and the effect are one
-- statement, never a read followed by a write.
--
-- THE COMPOSITE FOREIGN KEY IS LOAD-BEARING. A reservation can only exist
-- against a counter row that exists, so a release can never decrement a
-- counter that was never incremented, and a period rollover that removes a
-- counter cannot leave reservations pointing at nothing.
--
-- `job_id` is text rather than uuid deliberately: the identifiers that will
-- key these are a capture run id (uuidv7), a BullMQ job id (a string), and an
-- Idempotency-Key (an opaque client string, api-specification.md §1). Forcing
-- them into a uuid would mean hashing two of the three, and a hashed
-- identifier cannot be traced back to the job it compensated.

CREATE TABLE usage_reservations (
  workspace_id  uuid        NOT NULL,
  metric        text        NOT NULL,
  job_id        text        NOT NULL CHECK (length(job_id) BETWEEN 1 AND 255),
  period_start  date        NOT NULL,
  quantity      bigint      NOT NULL CHECK (quantity > 0),
  state         text        NOT NULL DEFAULT 'reserved'
                            CHECK (state IN ('reserved','committed','released')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  settled_at    timestamptz,
  PRIMARY KEY (workspace_id, metric, job_id),
  CONSTRAINT fk_usage_reservations_counter
    FOREIGN KEY (workspace_id, metric, period_start)
    REFERENCES usage_counters (workspace_id, metric, period_start) ON DELETE CASCADE,
  -- A settled reservation has a settlement time and an open one does not.
  -- Without this, a row could read 'released' with no record of when, which is
  -- exactly the state a reconciler would have to guess about.
  CONSTRAINT ck_usage_reservations_settled
    CHECK ((state = 'reserved') = (settled_at IS NULL))
);

-- The reconciler's index (NFR-CRD-04's shape, for tier caps rather than the
-- wallet): find reservations still open past their expected settlement.
CREATE INDEX ix_usage_reservations_open ON usage_reservations (workspace_id, created_at)
  WHERE state = 'reserved';

COMMENT ON TABLE usage_reservations IS
  'STORY-070 AC4 — one row per outstanding tier-cap reservation, so commit and release are idempotent by job identifier.';

-- Tenant table: the same policy shape src/db/rls/generate.ts produces for
-- every other workspace_id-carrying table (migration 0006). Written here
-- rather than left to the next regeneration because a tenant table without a
-- policy is a cross-tenant read for as long as it takes someone to notice.
ALTER TABLE usage_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_reservations FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'usage_reservations' AND policyname = 'ws_isolation_usage_reservations'
  ) THEN
    CREATE POLICY ws_isolation_usage_reservations ON usage_reservations
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
