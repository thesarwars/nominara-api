-- Undo 0123. The curation flag is derived on every refresh, so dropping it loses nothing that cannot be recomputed.
DROP INDEX ix_source_domains_curation;
ALTER TABLE source_domains DROP COLUMN class_source;
