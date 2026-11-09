-- STORY-189 — rollback of 0187_business_categories. Drops the seeded taxonomy; 0188 and 0189 (which reference it) must already be rolled back.
DROP TABLE IF EXISTS business_categories;
