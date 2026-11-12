-- STORY-191 fix round / decision 99(l) - rollback of 0202_name_match_judge_usage. LOSSY: the month's meter is forgotten, so a workspace's cap starts again from zero.
DROP TABLE IF EXISTS name_match_judge_usage;
