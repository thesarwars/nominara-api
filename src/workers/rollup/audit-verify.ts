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
    const rows = await readWorkspaceChain(client, workspaceId);
    walked += 1;
    const mismatch = verifyChain(rows);
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
