-- STORY-189 — rollback of 0188_category_peers. Drops the curated peer list (re-seedable from 0188's up).
DROP TABLE IF EXISTS category_peers;
