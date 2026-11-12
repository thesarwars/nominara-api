-- STORY-191 / decision 99(c) - rollback of 0197_name_match_verdicts. LOSSY: the model's verdicts are forgotten. A2 disambiguation risk then falls back
-- to the v1 case heuristic on read (which is pure), and the next judge run would ask the model again; nothing else reads this table.
DROP TABLE IF EXISTS name_match_verdicts;
