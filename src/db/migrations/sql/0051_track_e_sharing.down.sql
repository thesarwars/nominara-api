-- NEW-E-1 rollback. Restores the prior constraints. Tab values map back
-- (growth_map/matrix -> tracking), NULL colours are backfilled with the old
-- defaults; the history table did not exist before this migration.
DROP TABLE IF EXISTS scheduled_report_deliveries;

ALTER TABLE share_tokens DROP CONSTRAINT IF EXISTS share_tokens_scope_tabs_check;
UPDATE share_tokens
   SET scope_tabs = ARRAY(
         SELECT DISTINCT CASE WHEN x IN ('growth_map', 'matrix') THEN 'tracking' ELSE x END
           FROM unnest(scope_tabs) AS x
          ORDER BY 1
       )
 WHERE scope_tabs && ARRAY['growth_map', 'matrix'];
ALTER TABLE share_tokens ADD CONSTRAINT share_tokens_scope_tabs_check
  CHECK (scope_tabs <@ ARRAY['overview','tracking','sources','aux','tasks']);

UPDATE brand_themes SET color_primary = '#4f46e5' WHERE color_primary IS NULL;
UPDATE brand_themes SET color_accent  = '#0ea5e9' WHERE color_accent  IS NULL;
UPDATE brand_themes SET color_bg      = '#ffffff' WHERE color_bg      IS NULL;
UPDATE brand_themes SET color_fg      = '#0f172a' WHERE color_fg      IS NULL;
ALTER TABLE brand_themes ALTER COLUMN color_primary SET DEFAULT '#4f46e5';
ALTER TABLE brand_themes ALTER COLUMN color_primary SET NOT NULL;
ALTER TABLE brand_themes ALTER COLUMN color_accent  SET DEFAULT '#0ea5e9';
ALTER TABLE brand_themes ALTER COLUMN color_accent  SET NOT NULL;
ALTER TABLE brand_themes ALTER COLUMN color_bg      SET DEFAULT '#ffffff';
ALTER TABLE brand_themes ALTER COLUMN color_bg      SET NOT NULL;
ALTER TABLE brand_themes ALTER COLUMN color_fg      SET DEFAULT '#0f172a';
ALTER TABLE brand_themes ALTER COLUMN color_fg      SET NOT NULL;
