-- STORY-054 AC1 / aux-and-geo-analysis.md section 10 (owner decision 2026-10-13): unknown domains are classified heuristically
-- and "queued for curation". The queue is a flag on source_domains, not a table: `class_source = 'heuristic'` means the class
-- was assigned by the fallback (URL patterns, or `other`) rather than read from the curated list. Operators query the flag;
-- the source-index refresh sets it on every upsert.
-- EXPAND phase: one column with a constant default (metadata-only). Existing rows read 'heuristic' until their next
-- refresh sets the true value, which errs toward reviewing a domain rather than trusting an unverified class.
ALTER TABLE source_domains
  ADD COLUMN class_source text NOT NULL DEFAULT 'heuristic' CONSTRAINT ck_source_domains_class_source CHECK (class_source IN ('curated', 'heuristic'));
CREATE INDEX ix_source_domains_curation ON source_domains (workspace_id, last_seen_at DESC) WHERE class_source = 'heuristic';
