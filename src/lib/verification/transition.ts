import { Logger } from "@nestjs/common";
import type { ClientBase } from "pg";
import { uuidV7 } from "../ids/uuidv7.js";
import type { CheckOutcome } from "./checkers.js";
import type { VerificationFailure } from "../../../contracts/projects/index.js";

// STORY-048 AC3/AC5/AC7 — the state transition a verification check causes, shared by the request path
// (`DomainVerificationService.check`) and the periodic worker (`domain.reverify`), so a domain stops
// verifying in exactly one way however it was discovered.
//
// THE CALLER OWNS THE TRANSACTION AND ITS TENANT CONTEXT. Nothing here opens one, and nothing here makes a
// network call: the check outcome is an INPUT, computed before the transaction began (KAD-06).

const logger = new Logger("domain.verification");

/**
 * How long a verified method may stay INCONCLUSIVE (our resolver could not answer) before it is treated as lost.
 * OWNER DECISION 2026-10-22; 7 days is the proposal recorded in the STORY-048 carry note, not a reference number.
 * The window runs from the first inconclusive result of an unbroken run (`domain_verifications.inconclusive_since`) and
 * ends when `now - inconclusive_since >= INCONCLUSIVE_GRACE_MS`, so with a daily sweep the loss lands on the run at day 7.
 * A conclusive result of either kind clears it. Clock source: `now` is the checking process's clock (see `checkStartedAt`);
 * skew between the API and worker hosts moves the end of a 7-day window by the skew, which is far below the sweep's
 * 24-hour granularity.
 */
export const INCONCLUSIVE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface VerificationRow {
  id: string;
  domain: string;
  method: string;
  nonce: string;
  verified_at: Date | null;
  last_checked_at: Date | null;
  failure_reason: string | null;
}

export interface AppliedTransition {
  readonly row: VerificationRow;
  /** This method went from verified to not verified. */
  readonly methodLost: boolean;
  /** NO method verifies the domain any more: full scope is gone and the customer is told. */
  readonly scopeLost: boolean;
}

export interface ApplyCheckInput {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly domain: string;
  /** The row as the caller read it: identifies it; its `verified_at` is NOT trusted (see the lock in `applyCheckOutcome`). */
  readonly row: VerificationRow;
  readonly outcome: CheckOutcome;
  readonly now: Date;
  /**
   * When the check that produced `outcome` BEGAN (captured before its network wait). If a newer check committed in
   * between, the locked row's `last_checked_at` is later than this and the outcome is discarded: older evidence must
   * not overwrite a loss (or a success) a fresher check already recorded. Absent = no freshness guard.
   */
  readonly checkStartedAt?: Date;
}

/**
 * Serialises every transition of one project's verification state. Two methods of the same project each lock only
 * their own row, so without this a pair of concurrent losses can each read the OTHER as still verified, and the last
 * writer leaves `projects.domain_verified_at` set with every method unverified and nobody notified. Always taken
 * BEFORE any `domain_verifications` row lock, by every caller, so the order is the same everywhere (no deadlock).
 */
export async function lockProject(client: ClientBase, projectId: string): Promise<void> {
  await client.query("SELECT 1 FROM projects WHERE id = $1 FOR UPDATE", [projectId]);
}

export async function applyCheckOutcome(client: ClientBase, input: ApplyCheckInput): Promise<AppliedTransition> {
  const { row, outcome } = input;
  await lockProject(client, input.projectId);
  // The prior state is read HERE, under a row lock held to the end of the caller's transaction, never taken from
  // the caller's copy: that copy may have been read before a network wait during which another writer (the daily
  // sweep, a second manual check) committed a loss, and trusting it would notify that loss twice.
  const prior = await client.query<VerificationRow & { inconclusive_since: Date | null }>(
    "SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason, inconclusive_since FROM domain_verifications WHERE id = $1 FOR UPDATE",
    [row.id],
  );
  const locked = prior.rows[0];
  if (
    locked !== undefined &&
    input.checkStartedAt !== undefined &&
    locked.last_checked_at !== null &&
    locked.last_checked_at.getTime() > input.checkStartedAt.getTime()
  ) {
    // Stale evidence: a newer check already committed. Change nothing and notify nobody.
    return { row: locked, methodLost: false, scopeLost: false };
  }
  const priorVerifiedAt = locked?.verified_at ?? null;
  const wasVerified = priorVerifiedAt !== null;
  const reason: VerificationFailure | null = outcome.ok ? null : outcome.reason;
  // OUR outage is not their absence, for whichever caller found it (the daily sweep OR a manual re-check): record the
  // attempt and the reason, but keep `verified_at` and do not notify... for a BOUNDED time. The first inconclusive
  // result of an unbroken run starts a clock (`inconclusive_since`); once INCONCLUSIVE_GRACE_MS has elapsed with no
  // conclusive result the method is treated as lost, through the same path as any other loss (AC7).
  const inconclusiveRaw = !outcome.ok && outcome.inconclusive === true;
  // Only a method that is verified has anything to lose, so only it carries a clock.
  const since = inconclusiveRaw && wasVerified ? (locked?.inconclusive_since ?? input.now) : null;
  const graceExpired = since !== null && input.now.getTime() - since.getTime() >= INCONCLUSIVE_GRACE_MS;
  const inconclusive = inconclusiveRaw && !graceExpired;

  const updated = await client.query<VerificationRow>(
    `UPDATE domain_verifications
        SET verified_at = $2, last_checked_at = $4, failure_reason = $3, inconclusive_since = $5
      WHERE id = $1
      RETURNING id, domain, method, nonce, verified_at, last_checked_at, failure_reason`,
    // Cleared on failure, not left standing: AC7's whole point is that a domain which stops verifying stops
    // being verified. Keeping the old timestamp would leave full scope in place on evidence that no longer
    // holds. On success an existing verified time is kept: it is when control was FIRST proved. The inconclusive
    // clock is kept while the result stays inconclusive and cleared by every other outcome (including the loss that
    // its expiry causes).
    [
      row.id,
      outcome.ok ? (priorVerifiedAt ?? input.now) : inconclusive ? priorVerifiedAt : null,
      reason,
      input.now,
      inconclusive ? since : null,
    ],
  );

  // `projects.domain_verified_at` mirrors "any method currently verified". Denormalised deliberately: the
  // audit tool reads the project row it already has, and a scope check that needs a join is a scope check
  // somebody will be tempted to skip.
  const any = await client.query<{ verified_at: Date | null }>(
    "SELECT max(verified_at) AS verified_at FROM domain_verifications WHERE project_id = $1 AND domain = $2",
    [input.projectId, input.domain],
  );
  const stillVerified = any.rows[0]?.verified_at ?? null;
  await client.query("UPDATE projects SET domain_verified_at = $2, updated_at = now() WHERE id = $1", [input.projectId, stillVerified]);

  const methodLost = wasVerified && !outcome.ok && !inconclusive;
  // Scenario 10 — and only on an actual transition: a check that fails twice must not notify twice. And only
  // when the scope really went: the message says audits are limited to public-surface scope, which is false
  // while another method still verifies the domain.
  const scopeLost = methodLost && stillVerified === null;
  if (scopeLost) {
    await client.query(
      `INSERT INTO notifications (id, workspace_id, project_id, kind, severity, title, body, payload)
       VALUES ($1,$2,$3,'domain.verification_lost','warning',$4,$5,$6)`,
      [
        uuidV7(),
        input.workspaceId,
        input.projectId,
        `${input.domain} is no longer verified`,
        `Audits of ${input.domain} are limited to public-surface scope until it verifies again. Every rule that could not run is named on the audit itself.`,
        JSON.stringify({ domain: input.domain, reason }),
      ],
    );
    // IDs and the failure reason only — never the domain or the nonce.
    logger.warn({ event: "domain.verification_lost", workspace_id: input.workspaceId, project_id: input.projectId, reason });
  }

  return { row: updated.rows[0]!, methodLost, scopeLost };
}
