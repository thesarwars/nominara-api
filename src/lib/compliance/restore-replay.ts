import type { ClientBase } from "pg";
import type { PurgeJournalEntry } from "../../../contracts/compliance/index.js";
import { cascadeDeleteWorkspace } from "../../workers/rollup/retention.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { PurgeJournal, replayPurgeJournal, type ReplayResult } from "./purge-journal.js";

// STORY-111 / NFR-CMP-08, NFR-SEC-15 - "every restore re-applies purges recorded after the snapshot timestamp before accepting traffic".
//
// `reapplyPurgeEntry` is the idempotent apply for one journal entry on a restored database: purging a subject that is already absent
// succeeds and changes nothing. It does NOT export first: the export was written when the purge originally ran, and the data being
// deleted again is the restored copy of what was already purged. It does not touch object storage either, which a database restore
// does not resurrect.
//
// `reapplyPurgesAfterRestore` is the gate: the process that restores calls it and REFUSES to accept traffic unless `failed` is empty.

export async function reapplyPurgeEntry(privilegedClient: ClientBase, entry: PurgeJournalEntry): Promise<void> {
  if (entry.scope === "workspace") {
    await cascadeDeleteWorkspace(privilegedClient, entry.workspace_id);
    return;
  }
  await withTenantContext(privilegedClient, { workspaceId: entry.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    await tx.query("DELETE FROM citation_facts WHERE project_id = $1", [entry.scope_id]);
    await tx.query("DELETE FROM mention_facts WHERE project_id = $1", [entry.scope_id]);
    await tx.query("DELETE FROM answer_captures WHERE project_id = $1", [entry.scope_id]);
    await tx.query("DELETE FROM projects WHERE id = $1", [entry.scope_id]);
  });
}

export async function reapplyPurgesAfterRestore(privilegedClient: ClientBase, journal: PurgeJournal, snapshotAt: Date): Promise<ReplayResult> {
  const result = await replayPurgeJournal(journal, snapshotAt, (entry) => reapplyPurgeEntry(privilegedClient, entry));
  incrementCounter("nominara_retention_restore_replayed_total", { outcome: result.failed.length === 0 ? "clean" : "failed" });
  return result;
}
