import { Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";
import { uuidV7 } from "../ids/uuidv7.js";
import { incrementCounter } from "../telemetry/metrics.js";
import { runCheck, type CheckDeps, type CheckOutcome } from "./checkers.js";
import { applyCheckOutcome, lockProject, type VerificationRow } from "./transition.js";
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
// computed first and applied after.
//
// RACES. `applyCheckOutcome` takes the row `FOR UPDATE` and works out the prior state itself, so whichever of
// this sweep and a manual check commits first, the loss notifies exactly once. `DomainVerificationService.check`
// takes no row lock before its network wait; the lock inside the transition is what makes it safe. NOTE it is NOT
// KAD-06-compliant: the request path runs `runCheck` inside the request's own ambient tenant transaction, so that
// transaction IS open across the DNS/HTTPS wait (pre-existing on main; follow-up: check before the transaction, apply in
// a short one, or move it to the queue). Only THIS worker path keeps every transaction closed during a check. An
// outcome computed BEFORE a newer check committed is discarded, on both paths (`checkStartedAt`).
//
// OUR OUTAGE IS NOT THEIR ABSENCE, FOR A WHILE. A failure of OUR resolver (`inconclusive`), by ANY method, records the
// attempt and changes nothing else: no scope change, no notification, no audit row. Without this one resolver outage at
// 02:20 UTC would de-verify every DNS-verified domain in the fleet. It is BOUNDED (AC7): the first inconclusive result
// starts `inconclusive_since`, and INCONCLUSIVE_GRACE_MS later (`transition.ts`) the method is lost through the ordinary
// path, so a domain that stopped verifying cannot keep full scope for ever behind a failure that never clears.

const logger = new Logger("domain.reverify");

/** A candidate whose row no longer exists when its nonce is read. */
const GONE = Symbol("gone");

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
  /** Checks that could not reach a verdict (our resolver/network): scope untouched until the grace window ends, re-checked next run. */
  readonly inconclusive: number;
  /** Rows that were deleted between discovery and the check: skipped, neither a verdict nor an outage. */
  readonly gone: number;
}

interface Candidate {
  readonly id: string;
  readonly workspace_id: string;
  readonly project_id: string;
  readonly domain: string;
  readonly method: VerificationMethod;
}

/** Previously-verified methods for a live project's CURRENT domain, longest-unchecked first. Pending methods are not due: there is nothing to lose. */
async function dueCandidates(owner: ClientBase, now: Date, limit: number): Promise<Candidate[]> {
  const cutoff = new Date(now.getTime() - MIN_RECHECK_INTERVAL_MS);
  const result = await owner.query<Candidate>(
    // No nonce here: a proof-of-control secret is not read across tenants on the owner connection. It is re-read
    // under RLS in the row's own tenant context (`readNonce`).
    `SELECT dv.id, dv.workspace_id, dv.project_id, dv.domain, dv.method
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
  let inconclusive = 0;
  let gone = 0;
  for (let start = 0; start < candidates.length; start += CHECK_CONCURRENCY) {
    const chunk = candidates.slice(start, start + CHECK_CONCURRENCY);
    // No transaction is open here: this is the external wait. Outcomes are only as fresh as this instant.
    const checkStartedAt = deps.now();
    // allSettled: one check that throws must not abandon the run (oldest-checked-first ordering would then starve
    // every other domain on every retry and every later day).
    const outcomes = await Promise.allSettled(
      chunk.map(async (candidate): Promise<CheckOutcome | typeof GONE> => {
        // A short tenant transaction, closed before the network wait.
        const nonce = await readNonce(pool, candidate);
        if (nonce === null) return GONE; // row gone: nothing to check and nothing to apply, and not a resolver outage
        return runCheck(candidate.method, candidate.domain, nonce, deps.checks);
      }),
    );
    for (const [index, candidate] of chunk.entries()) {
      try {
        const settled = outcomes[index]!;
        if (settled.status === "rejected") throw settled.reason;
        const outcome = settled.value;
        if (outcome === GONE) {
          gone += 1;
          incrementCounter("nominara_domain_reverify_checked_total", { outcome: "gone" });
          continue;
        }
        const isInconclusive = !outcome.ok && outcome.inconclusive === true;
        if (isInconclusive) inconclusive += 1;
        if (await applyOne(pool, candidate, outcome, checkStartedAt)) lost += 1;
        incrementCounter("nominara_domain_reverify_checked_total", {
          outcome: outcome.ok ? "verified" : isInconclusive ? "inconclusive" : "failed",
        });
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

  return { status: failed === 0 ? "complete" : "partial", checked: candidates.length, lost, failed, inconclusive, gone };
}

/** The row's nonce, read as `nominara_app` inside its own workspace context (RLS live). null = the row is gone. */
async function readNonce(pool: Pool, candidate: Candidate): Promise<string | null> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId: candidate.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      const found = await tx.query<{ nonce: string }>("SELECT nonce FROM domain_verifications WHERE id = $1", [candidate.id]);
      return found.rows[0]?.nonce ?? null;
    });
  } finally {
    client.release();
  }
}

/** Applies one outcome in the row's own tenant context. Returns true when the method stopped verifying. */
async function applyOne(
  pool: Pool,
  candidate: Candidate,
  outcome: CheckOutcome,
  checkStartedAt: Date,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    return await withTenantContext(client, { workspaceId: candidate.workspace_id, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      // The project first, then the row: the same order as `applyCheckOutcome`, so no pair of writers can deadlock.
      await lockProject(tx, candidate.project_id);
      // RLS scopes this; no workspace predicate. Locked, so a concurrent manual check serialises with us and
      // the loss is detected exactly once. A row gone or already unverified is simply not ours to change.
      const locked = await tx.query<VerificationRow>(
        `SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason
           FROM domain_verifications WHERE id = $1 FOR UPDATE`,
        [candidate.id],
      );
      const row = locked.rows[0];
      if (row === undefined) return false;
      // A newer check (a manual one) committed while ours was in flight: its evidence is fresher than ours.
      if (row.last_checked_at !== null && row.last_checked_at.getTime() > checkStartedAt.getTime()) return false;
      const applied = await applyCheckOutcome(tx, {
        workspaceId: candidate.workspace_id,
        projectId: candidate.project_id,
        domain: candidate.domain,
        row,
        outcome,
        // The time of THIS check, not of the run's start: a 500-row run can take tens of minutes, and a manual check
        // that committed in between must not be moved backwards past by our write. (An inconclusive outcome is
        // handled inside the transition: attempt recorded, scope kept, no notification, no audit row.)
        now: checkStartedAt,
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
