import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { ENGINE_UNAVAILABLE_SKIP_CODES } from "../engines/capture-engine-gate.js";
import { blockedStatusSql } from "../rollup/aggregate-day.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { refundCredits } from "./balance.js";
import { refundableDebitFor } from "./undo.js";

// STORY-031 — OWNER DECISION 2026-10-26 (10): "credits for cells skipped by engine quota/outage during a paid manual deep scan
// are refunded (credit ledger: dangerous area; refund is a compensating ledger entry, never an edit)."
//
// AN EXCEPTION TO SCANFIX D2's RULE, AND ONLY THAT. run-settlement.ts keeps the reference's rule for everything else: a run that
// delivered nothing is refunded in full at finalisation, and a partial run is otherwise charged in full - a cell that REACHED the
// vendor and failed (rate limited, timed out, the quota-hitting call itself) is still the customer's. What this adds is the
// share of the flat price for cells the platform NEVER SENT because the engine was unavailable: `blocked` rows carrying one of
// ENGINE_UNAVAILABLE_SKIP_CODES (`quota_exhausted` from a quota-opened breaker, `engine_degraded` past EC-06 stage 5).
//
// THE ARITHMETIC. A deep scan has one flat price over the run's planned cells, so the refund is that price's share for the
// skipped cells, computed ONCE over the whole run and ROUNDED DOWN: floor(credits x skipped / planned). Credits go back to the
// bucket they came from, the expiring one first (the debit drew included-first; refunding to purchased first would turn
// expiring credits durable - the exploit undo.ts records), never more than the debit took from either bucket.
//
// WHEN. Only on a TERMINAL `partial` run (cells skip on a terminal run, so the count can no longer move) that was MANUAL and
// carries a debit. A `failed` run delivered nothing and already had the full refund; a scheduled run has no debit.
//
// IDEMPOTENT, three ways: the run row is locked FOR UPDATE, so two settlers serialise; any refund already referencing the run
// (this one, the full nothing-captured refund, an undo) ends it (`alreadyRefunded`); and each bucket's entry carries
// `<debit key>:engine_skip:<bucket>`, which `ux_credit_ledger_idem` refuses a second time (refundCredits reports applied: false).
//
// NO NETWORK I/O. This takes a client and nothing else - no cache, no queue, no publisher - and its caller (the engine-skip
// refund sweep) runs it in a tenant transaction of its own that does nothing but this. The ledger write never shares a
// transaction with a vendor call, an object PUT or an enqueue (ADR-0003, NFR-ARCH-04).
//
// AUDITED on the workspace's hash chain, in the same transaction: a refund with no audit row rolls back with it.

const logger = new Logger("credits.engine-skip-refund");

/** The audit action of an engine-skip refund. `billing.` namespace: listed under the billing category. */
export const ENGINE_SKIP_REFUND_AUDIT_ACTION = "billing.run_refunded_engine_unavailable";

export interface EngineSkipRefundInput {
  readonly workspaceId: string;
  readonly runId: string;
}

export interface EngineSkipRefundOutcome {
  readonly refunded: number;
  readonly skippedCells: number;
  /**
   * True when the debit was made before the wallet's CURRENT cycle began, i.e. the refund lands after a cycle roll (normally it
   * lands within the hour; this takes repeated sweep failures). STORY-031 review fix - DISCLOSED, NOT CHANGED: the included share
   * still goes back to `included`, into the new cycle, although the original included credits lapsed at the roll. Owner decision
   * 10 says the credits are refunded; withholding them, or sending them to the durable bucket (the undo.ts exploit), would each be
   * a new policy, so the case is reported (here, logged, counted) for the owner to rule on.
   */
  readonly debitBeforeCurrentCycle: boolean;
}

const NOTHING: EngineSkipRefundOutcome = { refunded: 0, skippedCells: 0, debitBeforeCurrentCycle: false };

/** Must run inside the run's tenant transaction (RLS scopes every statement), in a transaction that does no network I/O. */
export async function settleEngineSkippedCells(tx: ClientBase, input: EngineSkipRefundInput): Promise<EngineSkipRefundOutcome> {
  const run = await tx.query<{ status: string; trigger: string; planned_cells: number }>(
    "SELECT status, trigger, planned_cells FROM capture_runs WHERE id = $1 FOR UPDATE",
    [input.runId],
  );
  const row = run.rows[0];
  if (row === undefined || row.status !== "partial" || row.trigger !== "manual" || row.planned_cells <= 0) return NOTHING;

  const skipped = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM answer_captures WHERE run_id = $1 AND ${blockedStatusSql("status")} AND error_code = ANY($2::text[])`,
    [input.runId, [...ENGINE_UNAVAILABLE_SKIP_CODES]],
  );
  const skippedCells = Math.min(Number(skipped.rows[0]?.n ?? 0), row.planned_cells);
  if (skippedCells === 0) return NOTHING;
  const partial = { skippedCells, debitBeforeCurrentCycle: false };

  const debit = await refundableDebitFor(tx, input.workspaceId, input.runId);
  if (debit === null || debit.credits === 0 || debit.alreadyRefunded) return { refunded: 0, ...partial };

  const amount = Math.floor((debit.credits * skippedCells) / row.planned_cells);
  if (amount === 0) return { refunded: 0, ...partial };
  const toIncluded = Math.min(amount, debit.fromIncluded);
  const toPurchased = Math.min(amount - toIncluded, debit.fromPurchased);

  let refunded = 0;
  for (const [bucket, credits] of [
    ["included", toIncluded],
    ["purchased", toPurchased],
  ] as const) {
    if (credits === 0) continue;
    const outcome = await refundCredits(
      tx,
      {
        workspaceId: input.workspaceId,
        idempotencyKey: `${debit.idempotencyKey}:engine_skip:${bucket}`,
        actorId: null,
        actorType: "system",
        referenceType: "run",
        referenceId: input.runId,
      },
      bucket,
      credits,
    );
    if (outcome.applied) refunded += credits;
  }
  if (refunded === 0) return { refunded: 0, ...partial };

  // `cycle_start` is a UTC date (credit_wallets); the debit is the run's commit entry refundableDebitFor found.
  const crossed = await tx.query<{ before: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM credit_ledger c JOIN credit_wallets w ON w.workspace_id = c.workspace_id
        WHERE c.workspace_id = $1 AND c.entry_type = 'commit' AND c.reference_type = 'run' AND c.reference_id = $2
          AND c.idempotency_key = $3 AND c.occurred_at < (w.cycle_start::timestamp AT TIME ZONE 'UTC')) AS before`,
    [input.workspaceId, input.runId, debit.idempotencyKey],
  );
  const debitBeforeCurrentCycle = crossed.rows[0]?.before === true;
  if (debitBeforeCurrentCycle) {
    incrementCounter("nominara_credits_engine_skip_refund_after_cycle_roll_total", {});
    logger.warn({ event: "credits.engine_skip_refund.after_cycle_roll", workspace_id: input.workspaceId, run_id: input.runId, credits: refunded });
  }

  await new AuditChainService().append(tx, {
    workspaceId: input.workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: "worker:capture.engine_skip_refund",
    action: ENGINE_SKIP_REFUND_AUDIT_ACTION,
    resourceType: "capture_run",
    resourceId: input.runId,
    beforeState: { charged: debit.credits },
    afterState: { refunded, skipped_cells: skippedCells, planned_cells: row.planned_cells, reasons: [...ENGINE_UNAVAILABLE_SKIP_CODES] },
    requestId: `engine_skip_refund:${input.runId}`,
    supportGrantId: null,
    severity: "info",
  });
  incrementCounter("nominara_credits_run_refunded_total", { reason: "engine_unavailable" });
  logger.log({ event: "credits.run.refunded", workspace_id: input.workspaceId, run_id: input.runId, credits: refunded, reason: "engine_unavailable", skipped_cells: skippedCells });
  return { refunded, skippedCells, debitBeforeCurrentCycle };
}
