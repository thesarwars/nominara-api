-- Rollback of 0212_projects_attribution_rolled_up_at. Loses only the marker; the next rollup run re-reads every ingested row as pending.
ALTER TABLE projects DROP COLUMN attribution_rolled_up_at;
