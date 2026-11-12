-- STORY-188 rollback: touch `updated_at` on every update again, as 0003 created it.
CREATE OR REPLACE TRIGGER touch_updated_at
  BEFORE UPDATE ON topic_clusters
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
