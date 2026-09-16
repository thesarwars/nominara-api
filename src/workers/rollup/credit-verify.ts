import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import {
  listReconcilableWorkspaceIds,
  replayOrderingAvailable,
  verifyWorkspaceWallet,
  type WalletMismatch,
} from "../../lib/credits/replay.js";
import { LoggingWalletPagingNotifier } from "../../modules/credits/adapters/logging-wallet-paging-notifier.js";
import type { WalletPagingNotifier } from "../../modules/credits/ports/wallet-paging-notifier.js";

// STORY-073 — `NFR-CRD-03`: "A nightly job asserts equality and pages on
// mismatch." Same shape as `audit-verify.ts`: a plain, exported,
// dependency-free function over a privileged client, plus a `main()` that
// the scheduler runs and that sets `process.exitCode`.
//
// ⚠ IT CANNOT CORRECT ANYTHING, BY CONSTRUCTION AND ON PURPOSE. There is no
// import of `adjustCredits` here, no UPDATE, no compensating entry — and
// `test/unit/credits/credit-verify.spec.ts` asserts the absence of the
// import rather than trusting that nobody adds one. §6 rule 4: "an
// unreconcilable discrepancy is resolved by a human-authored `adjustment`
// entry with a reason. The system never silently rewrites a balance."
//
// The temptation is real and worth naming, because the one-line fix is
// obvious once you are holding both numbers: set the wallet to what the
// ledger replays to and move on. That hides the defect that caused the
// divergence, and produces a balance with a correction nobody authored and
// nobody can explain to the customer whose money it is.

export class ReplayOrderingUnavailableError extends Error {
  constructor() {
    super(
      "credit_ledger has no `seq` column: migration 0023 is not applied. Replay would have to order by " +
        "`occurred_at`, which is transaction-start time rather than wallet order, and would page on " +
        "concurrent movements that cost nobody a credit. Refusing to run rather than crying wolf.",
    );
    this.name = "ReplayOrderingUnavailableError";
  }
}

export interface VerifyAllWalletsResult {
  readonly checked: number;
  readonly mismatch: WalletMismatch | null;
}

/**
 * Verify each workspace's wallet against its ledger, stopping at the FIRST
 * mismatch.
 *
 * Stopping rather than sweeping matches `audit-verify.ts` and the AC's own
 * wording, and it is the right behaviour for a page: the second mismatch
 * does not make the first more urgent, and a page carrying forty workspaces
 * is a page nobody can act on at 3am. The run is nightly, so the next one
 * finds the next problem once this one is resolved.
 */
export async function verifyAllWallets(
  client: ClientBase,
  notifier: WalletPagingNotifier,
  workspaceIds?: readonly string[],
): Promise<VerifyAllWalletsResult> {
  if (!(await replayOrderingAvailable(client))) throw new ReplayOrderingUnavailableError();

  const ids = workspaceIds ?? (await listReconcilableWorkspaceIds(client));
  let checked = 0;
  for (const workspaceId of ids) {
    const mismatch = await verifyWorkspaceWallet(client, workspaceId);
    checked += 1;
    if (mismatch !== null) {
      await notifier.page(mismatch);
      return { checked, mismatch };
    }
  }
  return { checked, mismatch: null };
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    const result = await verifyAllWallets(client, new LoggingWalletPagingNotifier());
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
