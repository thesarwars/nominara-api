import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import {
  GENESIS_HASH,
  RECHAINED_MARKER_ACTION,
  verifyChainStep,
  type AuditChainRow,
  type ChainMismatch,
} from "../../lib/crypto/audit-chain.js";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import { LoggingPagingNotifier } from "../../modules/audit/adapters/logging-paging-notifier.js";
import {
  CHAIN_CHUNK_ROWS,
  chainAnchorBefore,
  lastRechainSeq,
  readChainChunk,
  listAuditedWorkspaceIds,
} from "../../modules/audit/audit-log-reader.js";
import type { PagingNotifier } from "../../modules/audit/ports/paging-notifier.js";

// STORY-020 — security-and-tenancy.md §12: "A verifier job re-walks each
// chain daily and pages on the first mismatch." Cross-tenant discovery
// (listAuditedWorkspaceIds has no workspace filter of its own) needs the
// same privileged connection contract as retention.ts's own cross-tenant
// discovery functions — see that file's PRIVILEGE CONTRACT comment.

export interface VerifyAllChainsResult {
  /** The first mismatch, kept for callers that only want "is anything wrong". */
  readonly mismatch: (ChainMismatch & { readonly workspaceId: string }) | null;
  /** Every workspace with a mismatch — one finding each, never more. */
  readonly mismatches: readonly (ChainMismatch & { readonly workspaceId: string })[];
  /** How many chains this run actually walked, and how many it set out to. */
  readonly walked: number;
  readonly discovered: number;
}

export class VerifierBlindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerifierBlindError";
  }
}

/**
 * ⚠ MAKES BLINDNESS LOUD, because the failure this control has is silence.
 *
 * `audit_log` carries FORCE ROW LEVEL SECURITY and its only policy is
 * `FOR ALL TO nominara_app, nominara_worker, nominara_report`. FORCE means it
 * applies to the table OWNER too, so the ONLY way to read the whole estate is
 * a role that bypasses RLS — superuser, or `BYPASSRLS`. Through anything else
 * `SELECT DISTINCT workspace_id FROM audit_log` returns nothing, the verifier
 * walks zero chains, and the run reports a clean estate, successfully, every
 * night. A review reproduced exactly that by pointing `DATABASE_URL` at
 * `nominara_app`: "audit chains verified: no mismatch", byte-identical to a
 * genuinely clean run.
 *
 * ⚠ AND THE OBVIOUS GUARD DOES NOT WORK — the first version of this compared
 * the audited-workspace count against `SELECT count(*) FROM workspaces`, which
 * is read through the SAME blind connection and is ALSO tenant-scoped. A blind
 * role sees zero workspaces too, so "0 audited and 0 existing" looked like an
 * empty estate and the guard stayed quiet. Its own test caught it.
 *
 * So the check is on the PRIVILEGE, not on any row count: can this role see
 * past row-level security at all. That is the property the verifier actually
 * depends on, it is true or false regardless of how much data exists, and it
 * cannot itself be hidden by the thing it is checking for.
 */
export async function assertVerifierCanSee(client: ClientBase): Promise<void> {
  const result = await client.query<{ can_see: boolean; who: string }>(
    "SELECT (rolsuper OR rolbypassrls) AS can_see, rolname AS who FROM pg_roles WHERE rolname = current_user",
  );
  const row = result.rows[0];
  if (row?.can_see === true) return;
  throw new VerifierBlindError(
    `the audit verifier is connected as "${row?.who ?? "unknown"}", which neither bypasses row-level security nor is a superuser — ` +
      "audit_log carries FORCE ROW LEVEL SECURITY, so this role sees an empty table and any clean report from it would be a lie",
  );
}

/**
 * Verifies one workspace's chain WITHOUT reading it into memory.
 *
 * ⚠ THE OLD WALK WAS AN OUTAGE WAITING FOR SCALE, and STORY-143 is what armed
 * it. `readWorkspaceChain` pulled an entire chain in one array — measured by
 * review at ~1.35 KB per row and 4.7 µs per row of UNINTERRUPTED event-loop
 * block, so ~2M rows in one workspace is ~2.7 GB of heap and ~9 s during which
 * this process answers nothing. Past BullMQ's 30 s lock duration the other
 * eight queues in the rollup group are declared stalled and `audit.verify`
 * itself lands in the dead-letter queue looking like a broken verifier —
 * precisely the outcome its own design notes were written to avoid. Nothing
 * prunes `audit_log` but a workspace hard delete, so this only ever grows.
 *
 * Three changes, and the order matters:
 *
 * 1. The strict zone's start is found with ONE aggregate instead of a
 *    full-chain scan. `verifyChain` finds the last rechaining marker by
 *    walking everything; a chunked walk must know it up front.
 * 2. The LENIENT ZONE IS NEVER READ. Every pre-marker row exists in the old
 *    loop only to hand its `row_hash` to the next iteration, and the only one
 *    that survives is the last. `chainAnchorBefore` fetches exactly that row.
 *    On a long-lived workspace this skips most of the chain.
 * 3. The strict zone is walked in keyset chunks, awaiting between them, so
 *    the loop yields to the event loop instead of blocking it.
 *
 * The per-row rules are `verifyChainStep`, shared with `verifyChain` rather
 * than restated — two implementations of "is this row's hash right" is how one
 * of them ends up quietly wrong.
 */
export async function verifyWorkspaceChain(
  client: ClientBase,
  workspaceId: string,
  /**
   * ⚠ A TEST SEAM THAT CHANGES NO BEHAVIOUR, which is the point of having it.
   * The chunk size must not affect the verdict — that invariant IS the risk in
   * a chunked rewrite, because the classic way to get this wrong is to lose
   * `expectedPrevHash` across a boundary and then find a tamper only when it
   * happens to land mid-chunk. Testing sizes 1, 2, 3 and 7 against the
   * in-memory walk exercises every boundary position over a short chain;
   * reproducing that at the production default would mean building thousands
   * of rows to prove the same property.
   */
  chunkRows: number = CHAIN_CHUNK_ROWS,
): Promise<ChainMismatch | null> {
  // ⚠ `LIMIT 0` WOULD READ AN EMPTY CHUNK AND CALL THE CHAIN CLEAN. The loop
  // below treats an empty chunk as "end of chain", which is right for a walk
  // that has reached the end and wrong for one that was never allowed to
  // start. Conflating "found nothing" with "nothing is wrong" is the exact
  // mistake STORY-143 paid for once already, on this same control.
  if (!Number.isInteger(chunkRows) || chunkRows < 1) {
    throw new RangeError(`chain walk chunk size must be a positive integer, got ${String(chunkRows)}`);
  }

  // ⚠ ONE SNAPSHOT, BECAUSE THE OLD WALK HAD ONE AND THE EQUIVALENCE ARGUMENT
  // DEPENDS ON IT. `readWorkspaceChain` was a single statement, so it saw one
  // consistent state; this walk is 2 + N statements, and on a bare connection
  // every one of them takes its own READ COMMITTED snapshot. A review
  // reproduced the consequence: let a legitimate GDPR erasure commit between
  // the marker lookup and the first chunk — `retention.ts` rewrites content
  // without rehashing and appends a rechaining marker, atomically — and this
  // walk reports `hash_mismatch` on a chain that `verifyChain` calls clean.
  //
  // The handler turns that into an `UnrecoverableError`, a dead-letter entry
  // and the estate's "tamper detected" signal, for an ordinary erasure that
  // happened to overlap the nightly window. Alarm fatigue on the one control
  // whose failure mode is silence. (That dead-letter entry was itself missing
  // until STORY-154 — see `willBullmqRetry` in lib/queue/dead-letter.ts. The
  // snapshot argument below is unaffected: it is about not raising a false
  // alarm, and it held while the alarm could not be raised at all.)
  //
  // REPEATABLE READ rather than a lock: the walk is read-only, so the only
  // cost is holding xmin for one workspace's read, which is what the single
  // query cost anyway. The false-CLEAN direction was checked separately and is
  // not reachable — `AuditChainService.append` holds an advisory xact lock per
  // workspace, so `seq` order is commit order and keyset cannot skip a row
  // that commits late.
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  try {
    return await walkChain(client, workspaceId, chunkRows);
  } finally {
    await client.query("COMMIT");
  }
}

async function walkChain(client: ClientBase, workspaceId: string, chunkRows: number): Promise<ChainMismatch | null> {
  const markerSeq = await lastRechainSeq(client, workspaceId, RECHAINED_MARKER_ACTION);

  // Where strict verification begins, and what it begins from.
  let expectedPrevHash = GENESIS_HASH;
  let afterSeq: string | null = null;
  if (markerSeq !== null) {
    const anchor = await chainAnchorBefore(client, workspaceId, markerSeq);
    // A marker that IS the first row leaves the anchor at genesis, matching
    // `verifyChain`'s `lastRechainedIndex === 0` case exactly.
    if (anchor !== null) expectedPrevHash = anchor;
    afterSeq = (BigInt(markerSeq) - 1n).toString();
  }

  for (;;) {
    const chunk: AuditChainRow[] = await readChainChunk(client, workspaceId, afterSeq, chunkRows);
    if (chunk.length === 0) return null;

    for (const row of chunk) {
      const step = verifyChainStep(expectedPrevHash, row);
      if (!step.ok) return step.mismatch;
      expectedPrevHash = step.nextExpected;
    }

    afterSeq = chunk[chunk.length - 1]!.seq;
  }
}

/**
 * Walks EVERY workspace's chain, pages once per workspace that has a
 * mismatch, and reports how much of the estate it got through.
 *
 * ⚠ IT USED TO STOP AT THE FIRST MISMATCH ESTATE-WIDE, and a review showed
 * what that meant once this runs unattended: after any single un-remediated
 * mismatch, every workspace after it in an unordered discovery is never
 * verified again — not that night, and not any night, until somebody fixes
 * the first one. Reproduced with two tampered workspaces: one found, the
 * second never read.
 *
 * §12's "pages on the first mismatch" is about not spamming a pager with
 * every row of a broken chain. It is not an instruction to abandon the
 * estate. So: first mismatch PER WORKSPACE, and the walk continues.
 */
export async function verifyAllChains(
  client: ClientBase,
  notifier: PagingNotifier,
  workspaceIds?: readonly string[],
): Promise<VerifyAllChainsResult> {
  // Before discovery, not after: a blind role's empty result is exactly what
  // must not be mistaken for a clean estate.
  if (workspaceIds === undefined) {
    await assertVerifierCanSee(client);
  }
  const ids = workspaceIds ?? (await listAuditedWorkspaceIds(client));

  const mismatches: (ChainMismatch & { workspaceId: string })[] = [];
  let walked = 0;
  for (const workspaceId of ids) {
    walked += 1;
    const mismatch = await verifyWorkspaceChain(client, workspaceId);
    if (mismatch) {
      await notifier.page({ workspaceId, seq: mismatch.seq, reason: mismatch.reason });
      mismatches.push({ ...mismatch, workspaceId });
    }
  }

  return { mismatch: mismatches[0] ?? null, mismatches, walked, discovered: ids.length };
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
