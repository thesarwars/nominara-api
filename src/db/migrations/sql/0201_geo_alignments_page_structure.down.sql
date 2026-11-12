-- STORY-060 S3 / decision 99(k) - rollback of 0201. LOSSY: the stored page-structure summaries are forgotten; the structure-match gap is then not assessed
-- (no cluster has a page) until sessions read their pages again.
ALTER TABLE geo_alignments DROP COLUMN IF EXISTS page_structure;
