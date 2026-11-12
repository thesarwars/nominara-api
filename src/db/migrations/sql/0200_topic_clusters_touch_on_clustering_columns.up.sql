-- STORY-188 - the rollup now refreshes the denormalised performance columns of `topic_clusters` every day. `touch_updated_at` fired on
-- EVERY update, so each refresh would have moved `updated_at`, and the clustering sweep reads `min(updated_at)` per project as "the time
-- of the last clustering" (the weekly recompute trigger, and `arrived` = prompts updated after it). A daily refresh would have made the
-- weekly trigger never due and hidden new prompts from the >= 10% trigger.
--
-- The trigger is narrowed to the columns clustering and a rename write: the label and its source, the centroid and its model, the member
-- count and the commercial intent. The performance columns (visibility_score, authority_rank, leader_entity_id, gap_priority,
-- achievability, computed_at) are DELIBERATELY not in the list: refreshing them is not re-clustering. EXPAND-ONLY: no column, no data, no
-- DROP; CREATE OR REPLACE TRIGGER swaps the definition in place. Owner-reserved number: decision 99 (2026-11-12), "0200 spare".
CREATE OR REPLACE TRIGGER touch_updated_at
  BEFORE UPDATE OF label, label_source, centroid, embedding_model, prompt_count, commercial_intent ON topic_clusters
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
