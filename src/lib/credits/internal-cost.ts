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
      WHERE workspace_id = $1 AND reference_type = $2 AND reference_id = $3 AND unit_cost_usd IS NOT NULL`,
    [workspaceId, usageReferenceType(referenceType), referenceId],
  );
  return result.rows[0]?.usd ?? null;
}
