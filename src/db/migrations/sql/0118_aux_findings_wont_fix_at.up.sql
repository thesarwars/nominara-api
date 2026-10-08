-- NEW-C-10 (aux-and-geo-analysis.md §3): a will-not-fix finding re-surfaces for review after 180 days, so the moment it was
-- set will-not-fix must be recorded. `updated_at` cannot serve: it moves on every re-detection by the crawl.audit handler.
-- EXPAND phase: one nullable column, no default, no backfill. Rows set will-not-fix before this migration keep NULL,
-- which the API reads as "no re-surface date known" rather than guessing one.
ALTER TABLE aux_findings ADD COLUMN wont_fix_at timestamptz;
