-- NEW-C-4 / STORY-054 — `project_source_index.brand_present_on_domain`
-- becomes NULLABLE, and gains `verified_at`.
--
-- Presence on a domain is verified by fetching the cited URL and matching
-- (scoring-models.md §5), never assumed. With NOT NULL DEFAULT false the
-- column could not say "not yet verified" and every unverified domain read as
-- an asserted absence. NULL now means unverified; the index recompute leaves
-- it NULL until the verification worker (NEW-C-15) writes true/false and a
-- verified_at. Existing rows keep their value and receive no verified_at.
ALTER TABLE project_source_index ALTER COLUMN brand_present_on_domain DROP DEFAULT;
ALTER TABLE project_source_index ALTER COLUMN brand_present_on_domain DROP NOT NULL;
ALTER TABLE project_source_index ADD COLUMN verified_at timestamptz;
