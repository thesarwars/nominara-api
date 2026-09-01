-- STORY-069 rollback. Unwraps {value, live} back to the bare value and drops
-- the five deferred keys, returning plans.entitlements to migration 0002's
-- shape.
--
-- The live flags are lost, not archived — they are derived from the
-- reference's not-live table, so the up migration reconstructs them exactly.

UPDATE plans
   SET entitlements = (
         SELECT jsonb_object_agg(entry.key, entry.value -> 'value')
           FROM jsonb_each(plans.entitlements) AS entry
          WHERE entry.key <> ALL (ARRAY[
                  'integrations.slack',
                  'integrations.mcp',
                  'integrations.cms_connections_max',
                  'exports.bi_ports',
                  'sso.saml'
                ])
       )
 WHERE jsonb_typeof(entitlements -> 'projects.max') = 'object';

COMMENT ON COLUMN plans.entitlements IS NULL;
