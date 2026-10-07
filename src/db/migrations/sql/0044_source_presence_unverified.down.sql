-- Reverse of 0044.
--
-- THE BACKFILL IS LOSSY: restoring NOT NULL needs a value for every
-- unverified row (NULL), and the only one available is `false`, which asserts
-- the brand is absent from a domain nobody has checked. Rolling back
-- re-introduces that defect by definition; verified_at is discarded.
UPDATE project_source_index SET brand_present_on_domain = false WHERE brand_present_on_domain IS NULL;
ALTER TABLE project_source_index DROP COLUMN verified_at;
ALTER TABLE project_source_index ALTER COLUMN brand_present_on_domain SET DEFAULT false;
ALTER TABLE project_source_index ALTER COLUMN brand_present_on_domain SET NOT NULL;
