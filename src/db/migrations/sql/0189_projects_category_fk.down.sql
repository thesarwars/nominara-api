-- STORY-189 — rollback of 0189_projects_category_fk. Drops the constraint; no data changes.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS fk_projects_category;
