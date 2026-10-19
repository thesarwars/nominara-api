import { Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { uuidV7 } from "../ids/uuidv7.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { runCheck, type CheckDeps, type CheckOutcome } from "./checkers.js";
import { applyCheckOutcome, type VerificationRow } from "./transition.js";
import type { VerificationMethod } from "../../../contracts/projects/index.js";

// STORY-048 AC7 — the periodic re-verification: find every verified domain that is due, check it WITHOUT any
// transaction open, then apply the outcome inside that one tenant's context as the runtime role.
//
// WHY TWO CONNECTIONS. Discovery has to look across every tenant, so it reads on the owner connection (as
// `identity.sweep_unverified` does). The write does not: it goes through `withTenantContext` on a pooled
// connection as `nominara_app`, so RLS is live and a loss in workspace A can only ever touch A.
//
// WHY THE CHECK IS OUTSIDE THE TRANSACTION. A DNS lookup or an HTTPS fetch of a customer's site can take
// seconds; no handler holds a transaction open across an await on an external service (KAD-06). The outcome is
// computed first and applied after, and `applyCheckOutcome` re-reads the row `FOR UPDATE` so a manual check
// racing this one cannot make a loss notify twice.

const logger = new Logger("domain.reverify");

/** A domain checked more recently than this is not re-checked: the daily tick is idempotent under redelivery. */
export const MIN_RECHECK_INTERVAL_MS = 20 * 60 * 60 * 1000;
/** Bounds one run. The oldest-checked go first, so the remainder is picked up by the next run, not starved. */
export const DEFAULT_BATCH_SIZE = 500;
/** How many domains are checked at once. The apply step is serial. */
const CHECK_CONCURRENCY = 5;

export interface ReverifyDeps {
  readonly checks: CheckDeps;
  readonly now: () => Date;
  readonly batchSize?: number;
}

export interface ReverifyResult {
  readonly status: "complete" | "partial";
  readonly checked: number;
  readonly lost: number;
  readonly failed: number;
}

interface Candidate {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly domain: string;
  readonly method: VerificationMethod;
  readonly nonce: string;
}

/** Previously-verified methods for a live project's CURRENT domain, longest-unchecked first. Pending methods are not due: there is nothing to lose. */
async function dueCandidates(owner: ClientBase, now: Date, limit: number): Promise<Candidate[]> {
  const cutoff = new Date(now.getTime() - MIN_RECHECK_INTERVAL_MS);
  const result = await owner.query<Candidate>(
    `SELECT dv.id, dv.workspace_id, dv.project_id, dv.domain, dv.method, dv.nonce
       FROM domain_verifications dv
       JOIN projects p ON p.id = dv.project_id AND p.deleted_at IS NULL AND p.root_domain = dv.domain
      WHERE dv.verified_at IS NOT NULL
        AND (dv.last_checked_at IS NULL OR dv.last_checked_at < $1)
      ORDER BY dv.last_checked_at ASC NULLS FIRST, dv.id
      LIMIT $2`,
    [cutoff, limit],
  );
  return result.rows;
}

export async function runDomainReverification(owner: ClientBase, pool: Pool, deps: ReverifyDeps): Promise<ReverifyResult> {
  const now = deps.now();
  const candidates = await dueCandidates(owner, now, deps.batchSize ?? DEFAULT_BATCH_SIZE);

  let lost = 0;
  let failed = 0;
  for (let start = 0; start < candidates.length; start += CHECK_CONCURRENCY) {
    const chunk = candidates.slice(start, start + CHECK_CONCURRENCY);
    // No transaction is open here: this is the external wait.
    const outcomes = await Promise.all(
      chunk.map(async (candidate): Promise<CheckOutcome> => runCheck(candidate.method, candidate.domain, candidate.nonce, deps.checks)),
    );
    for (const [index, candidate] of chunk.entries()) {
      try {
        if (await applyOne(pool, candidate, outcomes[index]!, now)) lost += 1;
        incrementCounter("nominara_domain_reverify_checked_total", { outcome: outcomes[index]!.ok ? "verified" : "failed" });
      } catch (error) {
        failed += 1;
        incrementCounter("nominara_domain_reverify_failures_total");
        // IDs only — never the domain, the nonce or the workspace name. The write rolled back whole, so the row
        // is still due and the next run retries it.
        logger.error({
          event: "domain.reverify.apply_failed",
          workspace_id: candidate.workspace_id,
          project_id: candidate.project_id,
          error: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  return { status: failed === 0 ? "complete" : "partial", checked: candidates.length, lost, failed };
}

/** Applies one outcome in the row's own tenant context. Returns true when the method stopped verifying. */
async function applyOne(pool: Pool, candidate: Candidate, outcome: CheckOutcome, now: Date): Promise<boolean> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId: candidate.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      // RLS scopes this; no workspace predicate. Locked, so a concurrent manual check serialises with us and
      // the loss is detected exactly once. A row gone or already unverified is simply not ours to change.
      const locked = await tx.query<VerificationRow>(
        `SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason
           FROM domain_verifications WHERE id = $1 FOR UPDATE`,
        [candidate.id],
      );
      const row = locked.rows[0];
      if (row === undefined) return false;

      const applied = await applyCheckOutcome(tx, {
        workspaceId: candidate.workspace_id,
        projectId: candidate.project_id,
        domain: candidate.domain,
        row,
        outcome,
        now,
      });
      if (applied.methodLost) {
        // AC10 — the controller's @Audit does not exist on a worker path, so the row is written here, on the
        // SAME chained writer and INSIDE the transaction: a state change with no audit row rolls back.
        await new AuditChainService().append(tx, {
          workspaceId: candidate.workspace_id,
          actorType: "system",
          actorId: SYSTEM_ACTOR_ID,
          actorIp: null,
          actorUa: "worker:domain.reverify",
          action: "project.domain_verification_lost",
          resourceType: "project",
          resourceId: candidate.project_id,
          beforeState: { method: candidate.method, verified: true },
          afterState: { method: candidate.method, verified: false, reason: applied.row.failure_reason, scope_lost: applied.scopeLost },
          requestId: `domain.reverify:${uuidV7()}`,
          supportGrantId: null,
          severity: "warning",
        });
      }
      return applied.methodLost;
    });
  } finally {
    client.release();
  }
}
