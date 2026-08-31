-- STORY-032 AC8 — the L3 content-hash short-circuit needs to know whether the
-- project's ALIAS SET has changed since a capture was parsed.
--
-- tracking-engine.md §6: "If content_hash matches this cell's previous
-- result, copy the prior parse output wholesale and skip entity matching,
-- arbitration, and embedding. Recomputed only if normalizer_version,
-- scoring_version, or the project's alias set changed."
--
-- Two of those three invalidators are already on the row —
-- `normalizer_version` and `scoring_version`. The third had nowhere to live,
-- and without it L3 cannot be decided correctly: the short-circuit would copy
-- a parse output produced against yesterday's aliases, and a competitor added
-- this morning would never appear in a cell whose answer had not changed.
-- That is the same failure §6 forbids for an L2 reuse, arriving by a
-- different route — and it is invisible, because the row looks complete.
--
-- A FINGERPRINT RATHER THAN A TIMESTAMP. Comparing against `projects.updated_at`
-- would recompute on every unrelated project edit (a renamed project, a
-- changed root URL), which is the safe direction but wasteful at exactly the
-- scale this cache exists to protect. It would also miss `competitors`
-- entirely, which lives in its own table and is just as much part of the
-- alias set. A hash of the actual inputs changes when, and only when, they do.
--
-- Nullable, because every row written before this migration has no
-- fingerprint and must not be treated as if it matched one. A NULL is read as
-- "unknown, therefore recompute" — the fail-safe direction: recomputing a
-- parse costs money, and skipping one that was needed costs correctness.

ALTER TABLE answer_captures ADD COLUMN IF NOT EXISTS alias_fingerprint bytea;

COMMENT ON COLUMN answer_captures.alias_fingerprint IS
  'STORY-032 — sha256 of the project alias set at parse time. NULL means unknown, which forces an L3 recompute.';
