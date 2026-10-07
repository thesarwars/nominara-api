-- STORY-076a — remove the seeded catalog rows, unless a purchase already
-- references one (the FK would refuse, and a bought pack must stay explicable).
DELETE FROM credit_packs p
 WHERE p.key IN ('starter_vault', 'agency_vault')
   AND NOT EXISTS (SELECT 1 FROM credit_purchases c WHERE c.pack_key = p.key);
