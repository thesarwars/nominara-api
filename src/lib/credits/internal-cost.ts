import type { ClientBase } from "pg";

// STORY-073 AC9 - what serving a debit cost US, read from `usage_ledger` at the moment the debit commits.
//
// `credit_ledger` is append-only, so the figure can be written ONLY on the commit entry itself: it is the sum of
// the `usage_ledger` rows that already name the same run when the commit is written. A pure SELECT in the caller's
// transaction - no network call, nothing written here, and the value rides the single INSERT of the commit entry, so
// it cannot be written twice (a replayed commit is refused by `ux_credit_ledger_idem` and takes the value with it).
//
// ⚠ NULL IS "NOT MEASURED" AND 0 IS "MEASURED, AND IT COST NOTHING". With no usage row to sum - or only rows whose
// unit cost is unknown - this returns null. It never returns a zero it did not measure: a flat-priced run is committed
// when it is ACCEPTED, before its cells are captured, so at that moment nothing is measured yet, and a recorded 0
// would read as "this run was free to serve" in a table that cannot be corrected.
//
// ROUND 3 - THE LINK. For exactly that flat-priced case the cost arrives AFTER the commit, so it cannot ride the commit's
// column. Each cost row is instead LINKED to the run's commit entry as it is recorded (`usage_ledger.credit_ledger_id`,
// set by `commitEntryIdFor`; NULL when the reference has no commit - a free scheduled run - and never across workspaces).
// `credit_ledger` is not touched. An entry's REALISED cost is therefore two disjoint parts:
//   - `credit_ledger.internal_cost_usd`: the unlinked rows that already existed when the commit was written
//     (`measuredInternalCostUsd` sums only rows with no link, so a later commit for the same reference cannot re-count);
//   - SUM(quantity * unit_cost_usd) of the rows linked to the entry, recorded after it.
// `REALISED_INTERNAL_COST_SQL` is that sum and is the only way a reader should compute it. NULL when neither part measured
// anything; a measured zero stays "0.000000".

/**
 * The reference types differ between the two ledgers for a capture run: the customer-facing debit says `run`, the
 * operating-cost rows (`recordUsageCost`) say `capture_run`. Every other type (`tool_run`, `aux_audit`) is the same.
 */
function usageReferenceType(creditReferenceType: string): string {
  return creditReferenceType === "run" ? "capture_run" : creditReferenceType;
}

export async function measuredInternalCostUsd(
  tx: ClientBase,
  workspaceId: string,
  referenceType: string | undefined,
  referenceId: string | undefined,
): Promise<string | null> {
  if (referenceType === undefined || referenceId === undefined) return null;
  const result = await tx.query<{ usd: string | null }>(
    `SELECT sum(quantity * unit_cost_usd)::numeric(10,6)::text AS usd
       FROM usage_ledger
      WHERE workspace_id = $1 AND reference_type = $2 AND reference_id = $3 AND unit_cost_usd IS NOT NULL
        AND credit_ledger_id IS NULL`,
    [workspaceId, usageReferenceType(referenceType), referenceId],
  );
  return result.rows[0]?.usd ?? null;
}

/**
 * The id of the COMMIT entry a cost row for this reference belongs to, or null when the reference has none (a free
 * scheduled run, a 0-credit run, a run not yet accepted). A SELECT in the caller's transaction, scoped to the workspace so
 * a reference id that another workspace also holds can never be linked across. `usageReferenceType` is the usage ledger's
 * vocabulary (`capture_run`, `tool_run`, `aux_audit`).
 */
export async function commitEntryIdFor(tx: ClientBase, workspaceId: string, usageRefType: string, referenceId: string): Promise<string | null> {
  const creditType = usageRefType === "capture_run" ? "run" : usageRefType;
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM credit_ledger
      WHERE workspace_id = $1 AND entry_type = 'commit' AND reference_type = $2 AND reference_id = $3
      ORDER BY seq LIMIT 1`,
    [workspaceId, creditType, referenceId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * The realised internal cost of the ledger row aliased `e`, as a `numeric(10,6)::text` (see the header). Requires
 * `LEFT JOIN LATERAL (SELECT sum(...) AS usd ...) linked ON true` - use `REALISED_INTERNAL_COST_JOIN`.
 */
export const REALISED_INTERNAL_COST_JOIN = `LEFT JOIN LATERAL (
        SELECT sum(u.quantity * u.unit_cost_usd) AS usd
          FROM usage_ledger u
         WHERE u.credit_ledger_id = e.id AND u.workspace_id = e.workspace_id AND u.unit_cost_usd IS NOT NULL) linked ON true`;
export const REALISED_INTERNAL_COST_SQL = `(CASE WHEN linked.usd IS NULL AND e.internal_cost_usd IS NULL THEN NULL
        ELSE (COALESCE(linked.usd, 0) + COALESCE(e.internal_cost_usd, 0))::numeric(10,6)::text END)`;

/** One entry's realised internal cost (the reader function; the list and the export use the same SQL as a join). */
export async function realisedInternalCostUsd(tx: ClientBase, ledgerEntryId: string): Promise<string | null> {
  const result = await tx.query<{ usd: string | null }>(
    `SELECT ${REALISED_INTERNAL_COST_SQL} AS usd FROM credit_ledger e ${REALISED_INTERNAL_COST_JOIN} WHERE e.id = $1`,
    [ledgerEntryId],
  );
  return result.rows[0]?.usd ?? null;
}
