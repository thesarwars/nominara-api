-- STORY-060 S3 / owner decision 99(k) (2026-11-12) - EXPAND-ONLY: one nullable column, nothing existing is altered.
--
-- The structure-match gap (FR-GEO-A3c) needs to know, per prompt cluster, whether the brand's page for that cluster has a table or a spec list. The page is
-- the cluster's alignment target URL, and the alignment session already holds its HTML when it opens (the STORY-059 fetch, outside any transaction). That
-- session now also builds the STORY-050 document model from the same HTML and writes the summary here, with NO new fetching:
--
--   page_structure  jsonb  { "tables": n, "lists": { "ordered": n, "unordered": n, "definition": n } } (contracts/analytics/geo-page-structure.schema.ts),
--                          summed over the page's content blocks. NULL = the page was never read for structure (a session that predates this column).
--
-- `loadStructureInput` reads the latest summary per cluster. No new table, no index (read through the existing project index), RLS unchanged.
ALTER TABLE geo_alignments ADD COLUMN IF NOT EXISTS page_structure jsonb;

COMMENT ON COLUMN geo_alignments.page_structure IS
  'STORY-060 S3 / decision 99k - the document model''s tables and list counts for the target page, written by the alignment session that fetched it. NULL = not read.';
