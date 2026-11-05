-- AUXLIVE-3 review round 3 (STORY-194 AC5) - an immutable record of what a manual audit was ASKED for.
--
-- The replay of POST /projects/{id}/aux-audits compares a retry with the original request. It used to compare against aux_audits.scope and
-- aux_audits.target_urls, but crawl.audit overwrites both once the audit runs (scope becomes the scope verification decided; target_urls becomes
-- the site files plus the pages crawled), so a retry after the job ran got 409 instead of the original answer. request_hash is written once, at
-- insert, by the producer: sha256 of (project, requested scope, requested target_urls). Nothing updates it.
--
-- Expand only: one nullable column, no default, no rewrite. NULL on every audit that is not a manual one (onboarding, scheduled, post-fix have no
-- caller request) and on any manual audit created before this column existed (none has reached production: the route is new in this branch).
ALTER TABLE aux_audits ADD COLUMN request_hash text;

COMMENT ON COLUMN aux_audits.request_hash IS
  'AUXLIVE-3 - sha256 hex of the manual audit request (project, requested scope, requested target_urls), written once at insert and never updated; the Idempotency-Key replay compares against it. NULL for non-manual audits.';
