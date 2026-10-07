-- NEW-C-8 (STORY-051 subset) — the seven crawler_access rules, AUX-R-001..007
-- (aux-and-geo-analysis.md §2). Σ W = 0.30+0.08+0.12+0.06+0.24+0.12+0.08 = 1.000
-- (NFR-AUX-03); the catalog loader re-asserts it on load.
--
-- aux_rule_catalog is GLOBAL (no workspace_id), so no RLS. The demo seed
-- (STORY-169) may already have inserted AUX-R-001 under its own rule_version
-- '1.0.0'; this migration takes that row over (ON CONFLICT DO UPDATE) so the
-- catalog holds one real definition. The seed's own insert is DO NOTHING, so
-- it never overwrites this one back.
--
-- rule_version '2026.10.1' is the version findings record (NFR-AUX-02).
-- `thresholds` carries the numbers the evaluators in src/lib/aux/site-files.ts
-- implement; an integration test pins the two together.
INSERT INTO aux_rule_catalog
  (code, category, title, description, rationale, severity_default, weight, auto_fixable, thresholds, task_threshold, rule_version)
VALUES
  ('AUX-R-001', 'crawler_access', 'AI crawlers are blocked by robots.txt',
   'robots.txt disallows a named AI crawler (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended, Bytespider, CCBot, meta-externalagent) from the pages you track.',
   'An AI engine that is not allowed to fetch a page cannot cite it, however good the content is.',
   'critical', 0.30, true, '{"critical_when":"root_disallow","agents":8}'::jsonb, 'critical', '2026.10.1'),
  ('AUX-R-002', 'crawler_access', 'AI crawlers inherit a restrictive wildcard rule',
   'robots.txt has a restrictive User-agent: * rule and does not name any AI crawler, so AI crawlers inherit the restriction.',
   'AI engines that fall back to the wildcard rule are excluded from pages you meant to be citable.',
   'medium', 0.08, true, '{}'::jsonb, 'high', '2026.10.1'),
  ('AUX-R-003', 'crawler_access', 'robots.txt is unreachable or malformed',
   'robots.txt returns an error status, exceeds 500 KB, or contains a directive that cannot be parsed.',
   'Crawlers treat an unreadable robots.txt unpredictably, so AI engines may skip or mis-crawl your site.',
   'high', 0.12, false, '{"max_bytes":512000,"min_unparseable":1}'::jsonb, 'high', '2026.10.1'),
  ('AUX-R-004', 'crawler_access', 'llms.txt is missing or invalid',
   'There is no /llms.txt or /.well-known/llms.txt, or the file does not follow the llms.txt format.',
   'AI engines that read llms.txt cannot find your canonical summary and links, so they describe you from whatever they scrape.',
   'low', 0.06, true, '{"absent_severity":"low","invalid_severity":"medium"}'::jsonb, 'medium', '2026.10.1'),
  ('AUX-R-005', 'crawler_access', 'Your edge blocks AI crawlers that browsers can reach',
   'An AI user agent receives 403, 429 or a challenge from the CDN or WAF while a browser user agent receives 200.',
   'The site looks fine to people and to robots.txt, but AI engines are turned away at the door, so they never see or cite your pages.',
   'critical', 0.24, false, '{}'::jsonb, 'critical', '2026.10.1'),
  ('AUX-R-006', 'crawler_access', 'Pages tell AI engines not to use them',
   'X-Robots-Tag or a robots meta tag contains noai, noimageai or noarchive on a tracked page.',
   'AI engines that honour these directives will not use or cite the page in their answers.',
   'high', 0.12, true, '{}'::jsonb, 'high', '2026.10.1'),
  ('AUX-R-007', 'crawler_access', 'Your sitemap is missing or out of date',
   'There is no sitemap, a sitemap declared in robots.txt returns 404, or more than half its entries have a lastmod older than 180 days.',
   'AI crawlers use the sitemap to find pages and judge freshness, so a missing or stale one makes new content slower to be found and cited.',
   'medium', 0.08, true, '{"stale_days":180,"stale_ratio":0.5}'::jsonb, 'medium', '2026.10.1')
ON CONFLICT (code) DO UPDATE SET
  category          = EXCLUDED.category,
  title             = EXCLUDED.title,
  description       = EXCLUDED.description,
  rationale         = EXCLUDED.rationale,
  severity_default  = EXCLUDED.severity_default,
  weight            = EXCLUDED.weight,
  auto_fixable      = EXCLUDED.auto_fixable,
  thresholds        = EXCLUDED.thresholds,
  task_threshold    = EXCLUDED.task_threshold,
  rule_version      = EXCLUDED.rule_version;
