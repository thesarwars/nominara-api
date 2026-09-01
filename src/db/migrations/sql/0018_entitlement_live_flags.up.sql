-- STORY-069 AC1 — every entitlement key carries a live flag.
--
-- plans-and-entitlements.md §2 has two tables. The first is the matrix that
-- migration 0002 seeded. The second, "Entitlement keys that are not live in
-- v1", exists "so the plan shape is settled before the features land" and is
-- explicit that those keys "are not launch claims and must render nowhere".
--
-- WHY A FLAG PER KEY RATHER THAN A LIST OF UNBUILT FEATURES.
-- `whitelabel.custom_domain` is in BOTH tables: a real matrix row, `true` on
-- Business and Enterprise, and simultaneously not live ("live at launch + 30
-- days"). So a key can carry a genuinely granted value and still not be live.
-- A separate list would have to be consulted by every consumer and would be
-- forgotten by one of them; a flag on the value cannot be read without being
-- seen.
--
-- Shape: {"projects.max": 3} becomes {"projects.max": {"value": 3, "live": true}}.
--
-- Expand-only (KAD-16): this rewrites the seeded rows in place and adds the
-- five deferred keys. No column is dropped and no NOT NULL is added.

-- Guard: transform only rows still in the old shape, so re-running this
-- against an already-migrated database cannot double-wrap a value into
-- {"value": {"value": 3, "live": true}, "live": true}.
UPDATE plans
   SET entitlements = (
         SELECT jsonb_object_agg(
                  entry.key,
                  jsonb_build_object(
                    'value', entry.value,
                    'live', entry.key <> ALL (ARRAY[
                      'integrations.slack',
                      'integrations.mcp',
                      'integrations.cms_connections_max',
                      'exports.bi_ports',
                      'sso.saml',
                      'whitelabel.custom_domain'
                    ])
                  )
                )
           FROM jsonb_each(plans.entitlements) AS entry
       )
 WHERE jsonb_typeof(entitlements -> 'projects.max') <> 'object';

-- The five keys that have no matrix row at all. They carry a null value
-- rather than an invented one: the reference gives them no per-tier figure,
-- and `null` already means "not applicable for that tier" in this seed's
-- encoding, which is what an unbuilt feature is. The flag is what stops them
-- rendering.
UPDATE plans
   SET entitlements = entitlements || jsonb_build_object(
         'integrations.slack', jsonb_build_object('value', null, 'live', false),
         'integrations.mcp', jsonb_build_object('value', null, 'live', false),
         'integrations.cms_connections_max', jsonb_build_object('value', null, 'live', false),
         'exports.bi_ports', jsonb_build_object('value', null, 'live', false),
         'sso.saml', jsonb_build_object('value', null, 'live', false)
       );

COMMENT ON COLUMN plans.entitlements IS
  'STORY-069 — {key: {value, live}}. `live` is false for a key that exists so the plan shape is settled but that must render nowhere (plans-and-entitlements.md §2).';
