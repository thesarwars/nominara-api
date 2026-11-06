import { StorageKeyError, workspacePrefix } from "./storage-keys.js";
import type { PrefixDeletingPort } from "./storage.port.js";

// STORY-180 r5 (owner decision 60 (b)) - the purge-side wrapper for workspace erasure. It takes the purged workspace id EXPLICITLY (the purge
// has no tenant context: it runs on the owner connection) and can only build THAT workspace's reports prefix `{env}/{workspace_id}/` in the
// reports bucket. The key builder validates the environment segment and the workspace id (a lowercase uuid), so `*`, `..`, an empty id or
// another workspace's prefix cannot be formed. It is NOT exported to feature code (nothing under src/modules imports it).
//
// STORY-182 adds the raw and crawl prefixes (`deleteWorkspaceObjectsEverywhere`) and the project-prefix callback `retention.ts` takes
// (`deleteProjectObjectPrefix`). Every call is `deletePrefix`, which removes every version and delete marker, so a re-run after a partial
// failure finishes the job.

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

const PROJECT_PREFIX_TAIL = /^projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/$/;

/**
 * STORY-182: the `deleteObjectPrefix` callback of `hardDeleteProject`. It accepts only `{env}/{workspace}/projects/{project}/` for the
 * configured environment (the shape `hardDeleteProject` builds) and deletes it in the raw bucket; anything else is refused.
 */
export async function deleteProjectObjectPrefix(port: PrefixDeletingPort, keyEnv: string, prefix: string): Promise<void> {
  const [env, workspaceId, ...rest] = prefix.split("/");
  if (env !== keyEnv || workspaceId === undefined) throw new StorageKeyError("project prefix is outside the configured environment");
  const workspaceRoot = workspacePrefix(keyEnv, workspaceId, "raw"); // validates the environment and the workspace id
  if (!prefix.startsWith(workspaceRoot) || !PROJECT_PREFIX_TAIL.test(prefix.slice(workspaceRoot.length)) || rest.length !== 3) {
    throw new StorageKeyError("not a project object prefix");
  }
  await port.deletePrefix("raw", prefix);
}
