-- NEW-C-4 audit — expand phase, additive only.
--
-- is_competitor_owned: "competitor" is a per-PROJECT fact, but source_domains
-- is shared by every project in a workspace, so the override cannot live there
-- (the last recompute would win). source_domains keeps the domain's own class
-- and seedability; this flag overrides both for one project's index rows.
--
-- scoring_version: context_weight and gap_severity are formula output. A
-- recompute replaces every row, so without a stamp a formula or threshold
-- change would rewrite history untraceably. DEFAULT 'v1' matches
-- SCORING_VERSION, so rows already written are correctly labelled.
ALTER TABLE project_source_index ADD COLUMN is_competitor_owned boolean NOT NULL DEFAULT false;
ALTER TABLE project_source_index ADD COLUMN scoring_version text NOT NULL DEFAULT 'v1';
