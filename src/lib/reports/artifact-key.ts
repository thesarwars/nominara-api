// STORY-180 round 5 - the states of `report_artifacts.object_key`, in one place.
//
// A stored artifact's key is the FULL object key (`{env}/{workspace_id}/{artifact_id}.{pdf|csv}`). Until the file is stored, and after
// it is gone, the column holds a marker instead (no schema change: the column is text and nothing parses it):
//
//   pending:<id>   the row is recorded; the upload has not been recorded yet
//   failed:<id>    the upload (or recording it) failed; the export answered an error and the object, if any, is being removed
//   purged:<id>    the retention sweep removed the object (expired link, or a stale pending/failed row)
//
// A marker is never a key: nothing presigns it, serves it or mails a link to it.
//
// QUARANTINE IS NOT A MARKER (round 7). A row whose stored key the retention sweep REFUSED as lying outside its workspace's prefix (a
// tenancy event) keeps its key untouched, as evidence, and is excluded from the sweep by `quarantined_at` (migration 0162).

export const PENDING_KEY_PREFIX = "pending:";
export const FAILED_KEY_PREFIX = "failed:";
export const PURGED_KEY_PREFIX = "purged:";

export const pendingKey = (id: string): string => `${PENDING_KEY_PREFIX}${id}`;
export const failedKey = (id: string): string => `${FAILED_KEY_PREFIX}${id}`;
export const purgedKey = (id: string): string => `${PURGED_KEY_PREFIX}${id}`;

/** True when `objectKey` names a stored object (is not one of the markers above). */
export function isStoredObjectKey(objectKey: string): boolean {
  return !objectKey.startsWith(PENDING_KEY_PREFIX) && !objectKey.startsWith(FAILED_KEY_PREFIX) && !objectKey.startsWith(PURGED_KEY_PREFIX);
}

/** The same test in SQL, for a column or alias named `col`. A literal, never built from input. */
export const storedKeySql = (col: string): string => `${col} !~ '^(pending|failed|purged):'`;
