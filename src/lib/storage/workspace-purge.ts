import { workspacePrefix } from "./storage-keys.js";
import type { PrefixDeletingPort } from "./storage.port.js";

// STORY-180 r5 (owner decision 60 (b)) - the purge-side wrapper for workspace erasure. It takes the purged workspace id EXPLICITLY (the purge
// has no tenant context: it runs on the owner connection) and can only build THAT workspace's reports prefix `{env}/{workspace_id}/` in the
// reports bucket. The key builder validates the environment segment and the workspace id (a lowercase uuid), so `*`, `..`, an empty id or
// another workspace's prefix cannot be formed. It is NOT exported to feature code (nothing under src/modules imports it).
//
// Scope: the REPORTS bucket only. The raw and crawl prefixes of the same workspace are STORY-182's (its AC covers all three); the port and
// `workspacePrefix` already support them, so that story adds two calls here.

/** Deletes every version and delete marker of `workspaceId`'s report files. Returns how many were removed. */
export async function deleteWorkspaceReports(port: PrefixDeletingPort, keyEnv: string, workspaceId: string): Promise<number> {
  return port.deletePrefix("reports", workspacePrefix(keyEnv, workspaceId, "reports"));
}
