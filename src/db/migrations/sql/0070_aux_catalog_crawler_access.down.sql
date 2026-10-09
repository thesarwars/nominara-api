-- NEW-C-8 — remove the crawler_access rules this migration wrote. A rule an
-- aux_finding already references (FK aux_findings.rule_code) stays: deleting it
-- would either fail or cascade away customer findings. The demo seed re-inserts
-- AUX-R-001 itself when it runs.
DELETE FROM aux_rule_catalog c
 WHERE c.code IN ('AUX-R-001','AUX-R-002','AUX-R-003','AUX-R-004','AUX-R-005','AUX-R-006','AUX-R-007')
   AND NOT EXISTS (SELECT 1 FROM aux_findings f WHERE f.rule_code = c.code);
