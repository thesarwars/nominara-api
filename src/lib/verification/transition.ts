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
  /** The row as the caller read it. */
  readonly row: VerificationRow;
  readonly outcome: CheckOutcome;
  readonly now: Date;
}

export async function applyCheckOutcome(client: ClientBase, input: ApplyCheckInput): Promise<AppliedTransition> {
  const { row, outcome } = input;
  const wasVerified = row.verified_at !== null;
  const reason: VerificationFailure | null = outcome.ok ? null : outcome.reason;

  const updated = await client.query<VerificationRow>(
    `UPDATE domain_verifications
        SET verified_at = $2, last_checked_at = $4, failure_reason = $3
      WHERE id = $1
      RETURNING id, domain, method, nonce, verified_at, last_checked_at, failure_reason`,
    // Cleared on failure, not left standing: AC7's whole point is that a domain which stops verifying stops
    // being verified. Keeping the old timestamp would leave full scope in place on evidence that no longer
    // holds. On success an existing verified time is kept: it is when control was FIRST proved.
    [row.id, outcome.ok ? (row.verified_at ?? input.now) : null, reason, input.now],
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

  const methodLost = wasVerified && !outcome.ok;
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
