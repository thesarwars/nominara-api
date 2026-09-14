-- STORY-042 — `metric_daily.sentiment_score` becomes nullable.
--
-- ⚠ A SCHEMA / SPECIFICATION CONFLICT, resolved in the specification's favour.
--
-- `scoring-models.md` §6 is unconditional: "When no mentions exist in the
-- window the score is `null`, rendered '—', NEVER 50" (`NFR-ANL-04`), and
-- "a neutral-looking number for 'no data' is a lie."
--
-- The column was `NOT NULL DEFAULT 0`, and §14's own rollup SQL computes
--
--     50 * ((agg.sent_weighted / NULLIF(agg.prominence_sum, 0)) + 1)
--
-- which is NULL whenever a day has no mentions — so the reference's own
-- statement violates the reference's own column on the first quiet day. The
-- insert would fail outright.
--
-- Coalescing was the alternative and is worse than the crash. On a 0–100
-- sentiment scale, 0 is not "no data" — it is MAXIMALLY NEGATIVE. A project
-- with a day of captures and no mentions would render as the worst possible
-- sentiment, which is a stronger lie than the 50 §6 already forbids.
--
-- `rendering_quality` on this same table is ALREADY nullable for exactly this
-- reason, and STORY-042's AC8 says so out loud: "Rendering quality is null
-- when there were no mentions, never zero." The two metrics have identical
-- semantics here; only one of them had the column to express it.
--
-- Dropping NOT NULL is additive-safe — the guard rejects a NOT NULL ADD, not
-- a drop — and no existing row changes.
ALTER TABLE metric_daily ALTER COLUMN sentiment_score DROP NOT NULL;
ALTER TABLE metric_daily ALTER COLUMN sentiment_score DROP DEFAULT;

COMMENT ON COLUMN metric_daily.sentiment_score IS
  'NULL when the day had no mentions — never 0, which on a 0-100 scale reads as maximally negative (scoring-models.md §6, NFR-ANL-04).';
