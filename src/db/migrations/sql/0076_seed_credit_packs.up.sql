-- STORY-076a — the launch credit-pack catalog (expand phase, additive).
--
-- `credit_packs` is a GLOBAL catalog (no workspace_id, no RLS). The spec
-- defines no pack values; these are the owner-approved ones: starter_vault
-- (1,000 credits, $15) for every tier and agency_vault (5,000 credits, $50)
-- from `growth`. `ON CONFLICT DO NOTHING`: a catalog row an operator already
-- tuned is never overwritten by a re-run.
INSERT INTO credit_packs (key, display_name, credits, price_usd, currency, min_plan_key, is_public, sort_order) VALUES
  ('starter_vault', 'Starter Vault', 1000, 15.00, 'USD', NULL,     true, 10),
  ('agency_vault',  'Agency Vault',  5000, 50.00, 'USD', 'growth', true, 20)
ON CONFLICT (key) DO NOTHING;
