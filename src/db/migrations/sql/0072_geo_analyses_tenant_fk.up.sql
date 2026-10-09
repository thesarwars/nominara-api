-- Audit (c-geo MAJOR) — make geo_analyses' project foreign key tenant-consistent.
-- Postgres evaluates FK checks without RLS, so the single-column FK from 0004
-- accepted workspace_id = attacker with project_id = victim (WITH CHECK passes on
-- the attacker's own workspace_id): an existence oracle for project ids, and a row
-- the victim's ON CONFLICT upsert hits but cannot see, which aborts the victim's
-- whole rollup.metric_daily transaction. A composite (workspace_id, id) FK binds
-- the reference to the row's own tenant; 0079 and 0081 are the precedent.
-- Every existing row was written from the project's own workspace_id (the only
-- writer, writeGeoAnalysis, reads it from projects under RLS), so none can violate
-- the new constraint.

ALTER TABLE projects ADD CONSTRAINT projects_workspace_id_id_key UNIQUE (workspace_id, id);

ALTER TABLE geo_analyses DROP CONSTRAINT geo_analyses_project_id_fkey;
ALTER TABLE geo_analyses
  ADD CONSTRAINT geo_analyses_project_fkey
    FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects (workspace_id, id) ON DELETE CASCADE;
