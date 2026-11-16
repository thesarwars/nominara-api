-- Rollback of 0213_mention_facts_in_link. Loses only the flag; a re-parse writes it again.
ALTER TABLE mention_facts DROP COLUMN in_link;
