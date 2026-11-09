import { relativeKeyFromStored, workspacePrefix } from "./storage-keys.js";
import type { PrefixDeletingPort } from "./storage.port.js";

// STORY-180 r5 (owner decision 60 (b)) - the purge-side wrapper for workspace erasure. It takes the purged workspace id EXPLICITLY (the purge
// has no tenant context: it runs on the owner connection) and can only build THAT workspace's reports prefix `{env}/{workspace_id}/` in the
// reports bucket. The key builder validates the environment segment and the workspace id (a lowercase uuid), so `*`, `..`, an empty id or
// another workspace's prefix cannot be formed. It is NOT exported to feature code (nothing under src/modules imports it).
//
// STORY-182 adds the raw and crawl prefixes (`deleteWorkspaceObjectsEverywhere`). Every call is `deletePrefix`, which removes every version
// and delete marker, so a re-run after a partial failure finishes the job. There is deliberately NO project-level deleter: no writer keys
// raw objects by project, so a project prefix would delete nothing and report success.

/** Deletes every version and delete marker of `workspaceId`'s report files. Returns how many were removed. */
export async function deleteWorkspaceReports(port: PrefixDeletingPort, keyEnv: string, workspaceId: string): Promise<number> {
  return port.deletePrefix("reports", workspacePrefix(keyEnv, workspaceId, "reports"));
}

/**
 * STORY-182: deletes every version of the workspace's objects in all three namespaces (reports, raw, crawl). A failure on one prefix does
 * not stop the others (the fewest possible objects are left behind); the FIRST failure is then raised, so the caller records it and a
 * re-run (idempotent) finishes the job. Returns how many versions and markers were removed.
 */
export async function deleteWorkspaceObjectsEverywhere(port: PrefixDeletingPort, keyEnv: string, workspaceId: string): Promise<number> {
  // Built up front: a malformed id or environment throws before anything is deleted.
  const targets = [
    ["reports", workspacePrefix(keyEnv, workspaceId, "reports")],
    ["raw", workspacePrefix(keyEnv, workspaceId, "raw")],
    ["raw", workspacePrefix(keyEnv, workspaceId, "crawl")],
  ] as const;
  let removed = 0;
  let failure: { error: unknown } | undefined;
  for (const [bucket, prefix] of targets) {
    try {
      removed += await port.deletePrefix(bucket, prefix);
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== undefined) throw failure.error;
  return removed;
}

/**
 * STORY-182 (decision 69(b)): deletes, in the raw bucket, every version of the given `answer_captures.raw_object_key` values of a purged
 * PROJECT. The caller collected them before the cascade (the rows that held them are gone). Each key must lie inside THIS workspace's own
 * raw prefix (`relativeKeyFromStored`); a key that does not (another workspace, another environment, a traversal) is never deleted, the valid
 * keys still are, and the call then fails so the gap is recorded. Returns how many versions and markers were removed.
 */
export async function deleteProjectRawObjects(port: PrefixDeletingPort, keyEnv: string, workspaceId: string, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const valid: string[] = [];
  let invalid: unknown;
  let invalidCount = 0;
  for (const key of new Set(keys)) {
    try {
      relativeKeyFromStored(keyEnv, workspaceId, "raw", key);
      valid.push(key);
    } catch (error) {
      invalid ??= error;
      invalidCount += 1;
    }
  }
  // A malformed workspace id or environment invalidates every key: nothing is deleted.
  if (valid.length === 0 && invalid !== undefined) throw invalid;
  const removed = await port.deleteKeys("raw", valid);
  if (invalid !== undefined) throw new Error(`${String(invalidCount)} stored raw object key(s) lie outside the workspace prefix and were not deleted`);
  return removed;
}
