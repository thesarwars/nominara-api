-- STORY-120 rollback. Returns the ledger to the state 0005 left it in: no
-- runtime role holds any privilege on the _migrations schema.
--
-- Readiness goes back to answering 503 for every environment once this is
-- applied — which is the pre-STORY-120 behaviour, and is asserted as such by
-- test/integration/readiness-as-runtime-role.spec.ts scenario 6 rather than
-- left as a claim.

REVOKE SELECT ON _migrations.applied FROM nominara_app;
REVOKE USAGE ON SCHEMA _migrations FROM nominara_app;
