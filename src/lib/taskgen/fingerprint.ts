import { createHash } from "node:crypto";

/**
 * STORY-063 — the dedupe fingerprint of a rule-generated task: a sha256 over the rule, the project and the rule's own
 * scope (an engine key, a finding fingerprint, a domain). Fields are length-prefixed, so a delimiter inside one can never
 * forge another rule's fingerprint.
 *
 * Deliberately NOT used by the displacement and source-absence paths: those two share `authorityTaskFingerprint`
 * (displacement-recovery.ts) with the on-demand recovery plan, so a task made by the rollup and one made by a click for
 * the same domain are one task.
 */
export function taskFingerprint(ruleCode: string, projectId: string, scope: string): Buffer {
  const hash = createHash("sha256").update("taskgen\0");
  for (const part of [ruleCode, projectId, scope]) hash.update(`${String(part.length)}:${part}\0`);
  return hash.digest();
}
