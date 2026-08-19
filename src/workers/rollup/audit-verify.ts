import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { verifyChain, type ChainMismatch } from "../../lib/crypto/audit-chain.js";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import { LoggingPagingNotifier } from "../../modules/audit/adapters/logging-paging-notifier.js";
import { listAuditedWorkspaceIds, readWorkspaceChain } from "../../modules/audit/audit-log-reader.js";
import type { PagingNotifier } from "../../modules/audit/ports/paging-notifier.js";

// STORY-020 — security-and-tenancy.md §12: "A verifier job re-walks each
// chain daily and pages on the first mismatch." Cross-tenant discovery
// (listAuditedWorkspaceIds has no workspace filter of its own) needs the
// same privileged connection contract as retention.ts's own cross-tenant
// discovery functions — see that file's PRIVILEGE CONTRACT comment.

export interface VerifyAllChainsResult {
  readonly mismatch: (ChainMismatch & { readonly workspaceId: string }) | null;
}

/**
 * Walks each workspace's chain in turn and stops at the FIRST mismatch
 * found — pages exactly once, per the AC's "pages on the first mismatch",
 * rather than exhaustively reporting every workspace's own first mismatch
 * in a single run.
 */
export async function verifyAllChains(
  client: ClientBase,
  notifier: PagingNotifier,
  workspaceIds?: readonly string[],
): Promise<VerifyAllChainsResult> {
  const ids = workspaceIds ?? (await listAuditedWorkspaceIds(client));
  for (const workspaceId of ids) {
    const rows = await readWorkspaceChain(client, workspaceId);
    const mismatch = verifyChain(rows);
    if (mismatch) {
      await notifier.page({ workspaceId, seq: mismatch.seq, reason: mismatch.reason });
      return { mismatch: { ...mismatch, workspaceId } };
    }
  }
  return { mismatch: null };
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    const notifier = new LoggingPagingNotifier();
    const result = await verifyAllChains(client, notifier);
    console.log(JSON.stringify(result, null, 2));
    if (result.mismatch !== null) {
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
