-- STORY-033 rollback. Without the trigger a cadence change goes unrecorded,
-- so a chart crossing the change date reads the frequency shift as a movement
-- in the measurement. Milestones already written stay — they are a record of
-- something that happened, not state this trigger owns.

DROP TRIGGER IF EXISTS record_cadence_change ON projects;
DROP FUNCTION IF EXISTS app.record_cadence_change();
