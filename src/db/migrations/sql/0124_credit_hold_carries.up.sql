-- STORY-072 AC13 — the credits a reservation carries across a billing-cycle roll (owner decision 2026-10-15,
-- option B "keep the hold").
--
-- At a roll the included bucket is reset to the plan grant, EXCEPT the part of it that backs a hold still open at
-- that moment: min(included_balance, reserved) credits stay in the bucket with their holds, so the customer pays an
-- in-flight action once, from the cycle it started in. This table says WHICH hold keeps how much, because
-- `credit_wallets.reserved` is an aggregate and a hold taken after the roll must never consume or expire an older
-- hold's carry.
--
--   * a commit of a carried hold is paid from its carry first;
--   * when the hold settles (commit or release) whatever its carry still holds is EXPIRED, under the ledger key
--     `hold_carry:<attempt>:<idempotency_key>`;
--   * `settled_at` is set in the same statement, so a carry expires at most once.
--
-- The rows are DERIVED state, not an independent record: the same split is recomputed from the ledger by the nightly
-- replay (`verifyWorkspaceWallet`), which compares the two and pages on a difference. The table only exists so the
-- commit statement does not have to re-walk the ledger.
--
-- Expand-only: a new table, nothing existing is altered. Tenant-scoped, NOT portal-readable; the policy ships in this
-- migration (POLICY_IN_OWN_MIGRATION, the 0074 precedent).
CREATE TABLE credit_hold_carries (
  workspace_id       uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- The hold: the reserve entry's (idempotency_key, attempt). No FK to credit_ledger (its unique index spans the
  -- entry type as well); the replay is what ties the two together.
  idempotency_key    text        NOT NULL CHECK (idempotency_key <> ''),
  attempt            integer     NOT NULL CHECK (attempt >= 1),
  credits            integer     NOT NULL CHECK (credits >= 0),
  -- The roll (`cycle_roll:<date>`) that last assigned this carry.
  rolled_cycle_start date        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  settled_at         timestamptz,
  PRIMARY KEY (workspace_id, idempotency_key, attempt)
);

-- The commit statement asks "how much is carried in total" for one workspace.
CREATE INDEX ix_credit_hold_carries_open ON credit_hold_carries (workspace_id) WHERE settled_at IS NULL;

COMMENT ON TABLE credit_hold_carries IS
  'STORY-072 AC13 — per-hold carry across a cycle roll (option B). Derived from the ledger and re-verified by replay. Tenant-scoped; not portal-readable.';

ALTER TABLE credit_hold_carries ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_hold_carries FORCE  ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'credit_hold_carries' AND policyname = 'ws_isolation_credit_hold_carries'
  ) THEN
    CREATE POLICY ws_isolation_credit_hold_carries ON credit_hold_carries
      FOR ALL TO nominara_app, nominara_worker, nominara_report
      USING      (workspace_id = app.current_workspace())
      WITH CHECK (workspace_id = app.current_workspace());
  END IF;
END $$;
