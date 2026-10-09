-- Undo 0118. Findings keep their status and reason; only the will-not-fix timestamp is dropped.
ALTER TABLE aux_findings DROP COLUMN wont_fix_at;
