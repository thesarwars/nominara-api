ALTER TABLE geo_analyses DROP CONSTRAINT geo_analyses_project_fkey;
ALTER TABLE geo_analyses
  ADD CONSTRAINT geo_analyses_project_id_fkey
    FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE CASCADE;
ALTER TABLE projects DROP CONSTRAINT projects_workspace_id_id_key;
