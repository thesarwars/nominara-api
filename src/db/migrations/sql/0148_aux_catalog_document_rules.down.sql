-- LOSSY DOWN. A row a finding references (for example AUX-R-021) is kept with its 0148 definition and rule_version, not rolled back.
-- Demo-seed rows (rule_version 1.0.0) that 0148 took over are deleted when unreferenced and NOT restored: re-run the demo seed after a down.
-- Reverses 0148. Findings may reference these rule rows (aux_findings.rule_code), so the delete is guarded: a database that has
-- recorded findings under them keeps the rows, and AUX-R-006 returns to its 0070 definition either way.
DELETE FROM aux_rule_catalog c
 WHERE c.code BETWEEN 'AUX-R-008' AND 'AUX-R-034'
   AND NOT EXISTS (SELECT 1 FROM aux_findings f WHERE f.rule_code = c.code);
UPDATE aux_rule_catalog SET thresholds = '{}'::jsonb, rule_version = '2026.10.1' WHERE code = 'AUX-R-006';
