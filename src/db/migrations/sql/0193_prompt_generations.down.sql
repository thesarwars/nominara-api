-- STORY-045 / decision 95(a) - rollback of 0193_prompt_generations. LOSSY: the record of past generation passes (their request, their
-- rejected[] report and their failures) is forgotten. The prompts a pass wrote live in tracked_prompts and are untouched; a pass still
-- pending is simply never settled, and the endpoint that read it does not exist at the migration this rolls back to.
DROP TABLE IF EXISTS prompt_generations;
