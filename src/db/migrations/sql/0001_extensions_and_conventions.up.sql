CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;

CREATE SCHEMA IF NOT EXISTS app;

-- Attach to every mutable table (BEFORE trigger — mutates the row):
--   CREATE TRIGGER touch_updated_at BEFORE UPDATE ON <table>
--   FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE OR REPLACE FUNCTION app.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Guard for size-bounded jsonb columns (tool_runs.result_json and similar).
-- AFTER trigger — pure validation, does not mutate the row; RETURN NULL is
-- the correct idiom here because a row-level AFTER trigger's return value is
-- ignored, and RAISE EXCEPTION is what actually rejects the write.
-- Attach with the column name and byte limit as trigger arguments:
--   CREATE TRIGGER guard_<column>_size AFTER INSERT OR UPDATE ON <table>
--   FOR EACH ROW EXECUTE FUNCTION app.assert_jsonb_size('<column>', '<max_bytes>');
CREATE OR REPLACE FUNCTION app.assert_jsonb_size()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  col text := TG_ARGV[0];
  max_bytes int := TG_ARGV[1]::int;
  val jsonb;
  sz int;
BEGIN
  EXECUTE format('SELECT ($1).%I', col) INTO val USING NEW;
  sz := octet_length(COALESCE(val::text, ''));
  IF sz > max_bytes THEN
    RAISE EXCEPTION 'jsonb column %.% is % bytes, exceeding the % byte limit',
      TG_TABLE_NAME, col, sz, max_bytes USING ERRCODE = '22001';
  END IF;
  RETURN NULL;
END;
$$;
