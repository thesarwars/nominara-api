-- ============================================================================
-- STORY-143 AC7 — the audit chain's high-water mark.
--
-- security-and-tenancy.md §12: "A verifier job re-walks each chain daily and
-- pages on the first mismatch." The walk proves a chain is INTERNALLY
-- consistent. It cannot prove the chain is COMPLETE, because nothing outside
-- the chain remembers how long it was:
--
--   * delete the last k rows and the remainder verifies from genesis;
--   * delete every row and the workspace stops being discovered at all.
--
-- That is the tamper an attacker with table privileges actually performs (the
-- newest rows record what they just did), and it is the threat the chain
-- exists for. A mark is that memory: after each clean walk the verifier
-- appends `(max_seq, row_hash)` for the chain head, and the next walk fails if
-- the head went down, if the row at the marked seq no longer has that hash, or
-- if a marked chain has vanished with no tombstone.
--
-- ⚠ ONE APPEND-ONLY TABLE IS BOTH THE CURRENT MARK AND ITS HISTORY. The
-- current mark is the row with the greatest max_seq (rows only ever grow, so
-- that is also the newest); nothing is ever updated, so there is no state to
-- rewrite — only rows to add. `reason` says why a row exists:
--   verified  a clean verifier walk (written by the verifier);
--   rechain   an individual erasure rewrote content and appended its marker
--             row (STORY-020-E-9), so the head moved on purpose;
--   tombstone the workspace was hard-deleted on purpose, so its chain being
--             gone is expected (max_seq/row_hash are NULL — there is no head).
--
-- ⚠ THIS TABLE IS DELIBERATELY NOT A TENANT TABLE. It carries `workspace_id`
-- but is registered in GLOBAL_TABLES and is GRANT-protected exactly like
-- user_credentials: NO runtime role (app, worker, report, portal) has ANY
-- privilege on it. It is platform integrity state written only by the
-- verifier's and the erasure/deletion jobs' privileged (table-owner)
-- connection. A mark the application could update or delete would just move
-- the control to whoever can reach the mark. A tenant RLS policy would imply
-- the table is reachable and merely filtered — the weaker control, and one
-- that would also oblige the tenant-isolation suite to read it as nominara_app.
--
-- ⚠ NO FOREIGN KEY TO workspaces, ON PURPOSE. workspaces(id) ON DELETE CASCADE
-- would delete the tombstone together with the workspace it describes, and the
-- verifier would then flag the vanished chain it was meant to expect.
--
-- Defence in depth on the append-only rule: the reject_update_delete trigger
-- (the same app.reject_mutation() audit_log uses) refuses UPDATE and DELETE
-- even to the owner. Disabling it needs table ownership, as it does for
-- audit_log.
-- ============================================================================

CREATE TABLE audit_chain_marks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL,
  max_seq      bigint,
  row_hash     bytea,
  checked_at   timestamptz NOT NULL DEFAULT now(),
  reason       text        NOT NULL,
  CONSTRAINT ck_audit_chain_marks_reason CHECK (reason IN ('verified', 'rechain', 'tombstone')),
  -- A tombstone has no head; every other mark MUST have one, and a head hash is a sha256.
  CONSTRAINT ck_audit_chain_marks_shape CHECK (
    (reason = 'tombstone' AND max_seq IS NULL AND row_hash IS NULL)
    OR (reason <> 'tombstone' AND max_seq IS NOT NULL AND max_seq >= 1
        AND row_hash IS NOT NULL AND octet_length(row_hash) = 32)
  )
);

-- "The current mark for this workspace" is one index probe.
CREATE INDEX ix_audit_chain_marks_ws_seq ON audit_chain_marks (workspace_id, max_seq DESC NULLS LAST);
-- At most one tombstone per workspace, so recording one is idempotent under a retried deletion.
CREATE UNIQUE INDEX ux_audit_chain_marks_tombstone ON audit_chain_marks (workspace_id) WHERE reason = 'tombstone';

CREATE TRIGGER reject_update_delete
  BEFORE UPDATE OR DELETE ON audit_chain_marks
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

COMMENT ON TABLE audit_chain_marks IS
  'STORY-143 AC7 — append-only audit-chain high-water marks (verified / rechain / tombstone). Owner-only: no runtime role has any privilege. Global-classified; no FK to workspaces so a tombstone outlives its workspace.';

-- Written after the blanket grants (0005 + its default privileges) so it is not
-- overwritten by them. Owner-only: this is the control.
REVOKE ALL ON audit_chain_marks FROM nominara_app, nominara_worker, nominara_report, nominara_portal;
