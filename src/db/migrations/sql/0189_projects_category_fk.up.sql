-- STORY-189 AC2 — projects.category_slug is constrained to the taxonomy.
--
-- NOT VALID, deliberately: the constraint is enforced for every new row and for any UPDATE that changes category_slug, but the rows already
-- in the table are NOT checked, so a value outside the taxonomy that predates it is kept, never dropped, and the migration cannot fail on
-- populated data. ("An existing value outside it is reported, not dropped.") The report is the NOTICE below: how many projects hold one.
-- A later contract-phase migration can VALIDATE the constraint once those rows have been moved into the taxonomy.
--
-- OPERATOR NOTE: the count reads `projects`, which is FORCE ROW LEVEL SECURITY. It is complete only on a migration identity that bypasses RLS
-- (a superuser, as the other migrations that read tenant tables assume); on any other it reports 0.
ALTER TABLE projects
  ADD CONSTRAINT fk_projects_category FOREIGN KEY (category_slug) REFERENCES business_categories (slug) NOT VALID;

DO $$
DECLARE
  v_projects integer;
  v_slugs    integer;
BEGIN
  SELECT count(*), count(DISTINCT p.category_slug) INTO v_projects, v_slugs
    FROM projects p
   WHERE p.category_slug IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM business_categories c WHERE c.slug = p.category_slug);
  IF v_projects > 0 THEN
    RAISE NOTICE '0189: % project(s) hold % distinct category_slug value(s) outside the taxonomy; kept, not dropped (fk_projects_category is NOT VALID)', v_projects, v_slugs;
  END IF;
END $$;
