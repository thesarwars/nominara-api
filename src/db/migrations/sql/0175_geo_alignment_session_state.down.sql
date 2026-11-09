-- Rollback of 0175_geo_alignment_session_state. The session state and the debounce marker are derived from the vectors and the draft that
-- remain, so dropping them loses no customer content.
ALTER TABLE geo_alignments
  DROP CONSTRAINT ck_ga_draft_due,
  DROP CONSTRAINT ck_ga_draft_state,
  DROP CONSTRAINT ck_ga_analysis_reason,
  DROP CONSTRAINT ck_ga_analysis_state,
  DROP COLUMN draft_recompute_due_at,
  DROP COLUMN draft_state,
  DROP COLUMN analysis_reason,
  DROP COLUMN analysis_state;
