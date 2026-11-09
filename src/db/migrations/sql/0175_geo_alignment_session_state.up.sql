-- 0175_geo_alignment_session_state: STORY-192 (owner decision 80, migrations 0175-0177 reserved for the alignment surface). Expand-only: four
-- nullable-or-defaulted columns on geo_alignments, no data movement.
--
--   analysis_state / analysis_reason  where the session is. A session is OPENED by the request (row at 'pending'), then advanced by the
--       geo.analyze job as vectors arrive. 'stale' = opened under an embedding model that is no longer the provider's (the corpus and
--       the chunks it waits for would never be embedded: embed.batch filters by the provider's model); 'failed' = the page could not be
--       fetched or the vectors did not arrive in time. The reason is a short code, never an address or page text. Nothing but 'ready'
--       may be shown as a result (the payload contract refuses coverage, recommendations and a projection for any other state).
--   draft_state / draft_recompute_due_at  the DEBOUNCE STATE of the draft recompute. Each PATCH of the draft pushes draft_recompute_due_at
--       forward and queues a delayed job; a job acts only once the column is due and clears it, so a burst of edits is one recompute over
--       the LAST text, and a redelivered or superseded job finds nothing due and does nothing. NULL draft_state = no draft was ever saved.
--       Kept in the row (not in the queue or the cache) so the answer survives a Valkey flush and the state is one statement from RLS.
--
-- THE DEFAULT IS 'ready', and the request that opens a session says 'pending' EXPLICITLY. A session that exists before this migration, or that the
-- STORY-059 library inserts itself (no request, no job), was analysed synchronously by its caller: nothing is waiting for it, so 'pending' would be
-- false for every one of them. Only the request path creates a row that a job will advance, and it is the one place that names the state.
ALTER TABLE geo_alignments
  ADD COLUMN analysis_state text NOT NULL DEFAULT 'ready',
  ADD COLUMN analysis_reason text,
  ADD COLUMN draft_state text,
  ADD COLUMN draft_recompute_due_at timestamptz;

ALTER TABLE geo_alignments
  ADD CONSTRAINT ck_ga_analysis_state CHECK (analysis_state IN ('pending', 'ready', 'stale', 'failed')),
  ADD CONSTRAINT ck_ga_analysis_reason CHECK (analysis_reason IS NULL OR analysis_reason ~ '^[a-z0-9_:.-]{1,80}$'),
  ADD CONSTRAINT ck_ga_draft_state CHECK (draft_state IS NULL OR draft_state IN ('pending', 'ready', 'failed')),
  ADD CONSTRAINT ck_ga_draft_due CHECK (draft_recompute_due_at IS NULL OR draft_state = 'pending');
