-- ============================================================================
-- Batch 19 (STORY-020 follow-up) - the incremental audit export's watermark.
--
-- The nightly `audit.export` wrote every chain in full every night into 7-year Object Lock storage, so storage grew by the whole estate nightly.
-- It now exports, per workspace chain, only the rows after the last exported row. This table is the memory of how far each chain has been exported.
--
-- Append-only, like audit_chain_marks: nothing is updated, so there is no state to rewrite. A run adds rows in TWO PHASES, both one row per
-- chain it exports and both carrying the run's `run_id`:
--   phase 'intent'   - written BEFORE either object is made durable (the objects' hashes are known by then: the bytes are spooled).
--   phase 'recorded' - written AFTER both objects are durable, in one transaction. ONLY these rows are watermarks.
-- The current watermark of a chain is its newest 'recorded' row, by `seq` (an identity, so the order is total; exported_at is the transaction's
-- now() and the same for every row of a run, and a uuid is random, so neither can break a tie). `from_seq` is the exclusive start of that
-- increment (0 = from genesis, which is the first run and a chain that an erasure rewrote), `object_sha256` and `manifest_sha256` are the SHA-256 of
-- the data object and the manifest object the run wrote.
--
-- ONE VERIFIABLE CHAIN. The newest 'recorded' row's manifest_sha256 is the `previousManifestSha256` the next manifest carries, so a removed or
-- replaced object shows as a break. An 'intent' with no later 'recorded' run is an UNRECORDED run: its objects were written but the recording
-- failed, or the upload failed. Linking to it would break the chain when the objects are not there, so the next manifest links to the last
-- recorded run and LISTS the unrecorded runs explicitly (`incremental.unrecordedRuns`). The watermark never moved for them, so their rows are
-- in the next export: an orphan object is a duplicate, never a gap, and never an unaccounted-for object in the evidence store.
--
-- THE WATERMARK MOVES ONLY AFTER BOTH OBJECTS ARE DURABLE. A crash between the upload and the 'recorded' insert re-exports the same rows next
-- night: a duplicate, never a gap.
--
-- DELIBERATELY NOT A TENANT TABLE, exactly as audit_chain_marks: it carries workspace_id but is a GLOBAL table, owner-only, no runtime role has any
-- privilege, no RLS, and NO FK to workspaces (a hard-deleted workspace's chain was already exported; the watermark describes that object).
-- It holds hashes and sequence numbers only - no audit content, no PII.
-- ============================================================================

CREATE TABLE audit_export_watermarks (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint      GENERATED ALWAYS AS IDENTITY,
  run_id          uuid        NOT NULL,
  phase           text        NOT NULL,
  previous_manifest_sha256 bytea,
  workspace_id    uuid        NOT NULL,
  from_seq        bigint      NOT NULL,
  max_seq         bigint      NOT NULL,
  row_hash        bytea       NOT NULL,
  object_sha256   bytea       NOT NULL,
  manifest_sha256 bytea       NOT NULL,
  exported_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_audit_export_watermarks_phase CHECK (phase IN ('intent', 'recorded')),
  CONSTRAINT ck_audit_export_watermarks_previous CHECK (previous_manifest_sha256 IS NULL OR octet_length(previous_manifest_sha256) = 32),
  CONSTRAINT ck_audit_export_watermarks_range CHECK (from_seq >= 0 AND max_seq > from_seq),
  CONSTRAINT ck_audit_export_watermarks_hashes CHECK (
    octet_length(row_hash) = 32 AND octet_length(object_sha256) = 32 AND octet_length(manifest_sha256) = 32
  )
);

-- "The current watermark for this chain" and "the latest recorded manifest" are one index probe each; "the unrecorded runs" scans the intents.
CREATE UNIQUE INDEX ux_audit_export_watermarks_seq ON audit_export_watermarks (seq);
CREATE INDEX ix_audit_export_watermarks_ws_seq ON audit_export_watermarks (workspace_id, seq DESC) WHERE phase = 'recorded';
CREATE INDEX ix_audit_export_watermarks_recorded_seq ON audit_export_watermarks (seq DESC) WHERE phase = 'recorded';
CREATE INDEX ix_audit_export_watermarks_run ON audit_export_watermarks (run_id);

CREATE TRIGGER reject_update_delete
  BEFORE UPDATE OR DELETE ON audit_export_watermarks
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

COMMENT ON TABLE audit_export_watermarks IS
  'Batch 19 - append-only per-chain watermark of the incremental audit export (which seq was exported, and the hashes of the objects that hold it), in two phases: intent before the upload, recorded after. Owner-only: no runtime role has any privilege. Global-classified; no FK to workspaces.';

-- Written after the blanket grants (0005 + its default privileges) so it is not overwritten by them. Owner-only: this is the control.
REVOKE ALL ON audit_export_watermarks FROM nominara_app, nominara_worker, nominara_report, nominara_portal;
