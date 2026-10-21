import { Inject, Injectable } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import { NotFoundError, ValidationFailedError } from "../../api/errors/domain-errors.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { currentTenantStore } from "../../tenancy/tenant-context.js";
import { defaultCheckDeps, runCheck, type CheckDeps } from "../../lib/verification/checkers.js";
import { applyCheckOutcome, type VerificationRow } from "../../lib/verification/transition.js";
import {
  instructionsFor,
  type VerificationFailure,
  type VerificationMethod,
  type VerificationState,
  type VerificationStatusResponse,
} from "../../../contracts/projects/index.js";

// STORY-048 — three ways to prove control of a domain, and the scope gate.
//
// THE GATE IS THE POINT. Without proof of control the AUX audit is a way to
// inspect and score any third-party site, including a competitor's. It gates
// SCOPE and never price: verification is free and takes minutes, so the nudge
// is "verify to audit more pages for the same price". A paywall would push
// customers onto the unverified path, which is the one we want used less.

export const CHECK_DEPS = Symbol("DOMAIN_VERIFICATION_CHECK_DEPS");

/** 128 bits, url-safe. Per DOMAIN — AC8: it does not transfer between domains or projects. */
function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

@Injectable()
export class DomainVerificationService {
  constructor(@Inject(CHECK_DEPS) private readonly checks: CheckDeps = defaultCheckDeps()) {}

  /**
   * AC1/AC2 — returns the nonce and instructions for one method.
   *
   * Idempotent (AC3): calling twice for the same domain and method returns the
   * SAME nonce rather than rotating it. Rotating would silently invalidate a
   * record the customer had already published, and they would have no way to
   * tell why a correct-looking record stopped working.
   */
  async start(projectId: string, method: VerificationMethod): Promise<VerificationState> {
    const client = currentTenantStore()!.client;
    const { workspaceId, domain } = await this.projectDomain(projectId);

    const existing = await client.query<VerificationRow>(
      `SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason
         FROM domain_verifications WHERE project_id = $1 AND domain = $2 AND method = $3`,
      [projectId, domain, method],
    );
    if (existing.rows.length > 0) return toState(existing.rows[0]!);

    const nonce = newNonce();
    const inserted = await client.query<VerificationRow>(
      `INSERT INTO domain_verifications (id, workspace_id, project_id, domain, method, nonce)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, domain, method, nonce, verified_at, last_checked_at, failure_reason`,
      [uuidV7(), workspaceId, projectId, domain, method, nonce],
    );
    return toState(inserted.rows[0]!);
  }

  /**
   * AC3 — re-runnable, recording the last attempt and any failure reason.
   *
   * AC7's downgrade lives here too: a domain that STOPS verifying loses full
   * scope and is told, rather than silently continuing at full scope (wrong)
   * or silently downgrading (confusing). The real case is a customer removing
   * a record during unrelated DNS work.
   */
  async check(projectId: string, method: VerificationMethod): Promise<VerificationState> {
    const client = currentTenantStore()!.client;
    const { workspaceId, domain } = await this.projectDomain(projectId);

    const found = await client.query<VerificationRow>(
      `SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason
         FROM domain_verifications WHERE project_id = $1 AND domain = $2 AND method = $3`,
      [projectId, domain, method],
    );
    if (found.rows.length === 0) {
      throw new ValidationFailedError({
        message: "start this verification method before checking it",
        details: { issues: [{ path: ["method"], message: "no verification in progress for this method" }] },
      });
    }

    const row = found.rows[0]!;
    // Captured BEFORE the network wait: `applyCheckOutcome` discards this outcome if a newer check committed meanwhile.
    const checkStartedAt = new Date();
    const outcome = await runCheck(method, domain, row.nonce, this.checks);
    const applied = await applyCheckOutcome(client, { workspaceId, projectId, domain, row, outcome, now: new Date(), checkStartedAt });
    return toState(applied.row);
  }

  /** AC5 — state per domain and per method, plus the resulting audit scope. */
  async status(projectId: string): Promise<VerificationStatusResponse> {
    const client = currentTenantStore()!.client;
    const { domain } = await this.projectDomain(projectId);

    const rows = await client.query<VerificationRow>(
      `SELECT id, domain, method, nonce, verified_at, last_checked_at, failure_reason
         FROM domain_verifications WHERE project_id = $1 AND domain = $2 ORDER BY method`,
      [projectId, domain],
    );
    const methods = rows.rows.map(toState);
    // ANY method verifying is enough — AC5: "a customer can verify by any one".
    const verified = methods.some((state) => state.verified);

    return { domain, verified, audit_scope: verified ? "full" : "public_surface", methods };
  }

  private async projectDomain(projectId: string): Promise<{ workspaceId: string; domain: string }> {
    const client = currentTenantStore()!.client;
    // No workspace predicate — RLS scopes the transaction (NFR-SEC-01).
    const result = await client.query<{ workspace_id: string; root_domain: string }>(
      "SELECT workspace_id, root_domain FROM projects WHERE id = $1 AND deleted_at IS NULL",
      [projectId],
    );
    if (result.rows.length === 0) throw new NotFoundError({ message: "no such project" });
    return { workspaceId: result.rows[0]!.workspace_id, domain: result.rows[0]!.root_domain };
  }
}

function toState(row: VerificationRow): VerificationState {
  const method = row.method as VerificationMethod;
  return {
    domain: row.domain,
    method,
    nonce: row.nonce,
    verified: row.verified_at !== null,
    verified_at: row.verified_at?.toISOString() ?? null,
    last_checked_at: row.last_checked_at?.toISOString() ?? null,
    failure_reason: row.failure_reason as VerificationFailure | null,
    instructions: instructionsFor(method, row.domain, row.nonce),
  };
}
