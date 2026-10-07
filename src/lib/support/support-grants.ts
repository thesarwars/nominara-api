import type { ClientBase } from "pg";
import {
  SUPPORT_GRANT_MAX_TTL_MINUTES,
  supportGrantCreateInputSchema,
  type SupportGrantCreateInput,
} from "../../../contracts/trust/access-grant.schema.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { incrementCounter } from "../telemetry/metrics.js";

// NEW-D-5 — security-and-tenancy.md §11. The ONLY code that writes
// `support_grants`, and it is reached from an operator's shell, not a route.
//
// ⚠ IF THIS FILE EVER BECOMES A NEST PROVIDER, THE SAFETY PROPERTY IS GONE.
// A Nest provider here would put grant creation in the injector, which a
// request can reach. src/modules/trust/trust.spec.ts asserts that the CLI is
// the sole importer and that no decorator appears here.
//
// Both functions expect to run inside `withTenantContext` for the grant's
// workspace; RLS is what keeps one workspace's grant out of another's reach.

/** Inserts the grant and its audit row on the caller's transaction: both commit or neither does. */
export async function grantSupportAccess(tx: ClientBase, raw: SupportGrantCreateInput): Promise<{ id: string; expires_at: string }> {
  // Re-validated here, not trusted from the caller: TTL <= 4 h is enforced by the function that writes.
  const input = supportGrantCreateInputSchema.parse(raw);
  if (input.ttl_minutes > SUPPORT_GRANT_MAX_TTL_MINUTES) throw new Error("support grant TTL exceeds 4 hours");

  // expires_at from the database clock: an operator's skewed laptop cannot lengthen a grant.
  const inserted = await tx.query<{ id: string; expires_at: Date }>(
    `INSERT INTO support_grants (workspace_id, requested_by, approved_by, scope, allow_write, justification, ticket_ref, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8::int))
     RETURNING id, expires_at`,
    [input.workspace_id, input.requested_by, input.approved_by, input.scope, input.allow_write, input.justification, input.ticket_ref, input.ttl_minutes],
  );
  const row = inserted.rows[0]!;
  await new AuditChainService().append(tx, {
    workspaceId: input.workspace_id,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: `operator:${input.operator}`,
    action: "support.grant_created",
    resourceType: "support_grant",
    resourceId: row.id,
    beforeState: null,
    afterState: {
      scope: input.scope,
      allow_write: input.allow_write,
      ticket_ref: input.ticket_ref,
      justification: input.justification,
      ttl_minutes: input.ttl_minutes,
      expires_at: row.expires_at.toISOString(),
      requested_by: input.requested_by,
      approved_by: input.approved_by,
      operator: input.operator,
    },
    requestId: input.ticket_ref,
    supportGrantId: null,
    severity: "warning",
  });
  incrementCounter("nominara_support_grants_changed_total", { outcome: "granted" });
  return { id: row.id, expires_at: row.expires_at.toISOString() };
}

export interface RevokeSupportAccessInput {
  readonly workspaceId: string;
  readonly grantId: string;
  readonly operator: string;
}

/** Idempotent: an unknown, foreign-workspace or already-revoked grant is `revoked: false` and writes nothing. */
export async function revokeSupportAccess(tx: ClientBase, input: RevokeSupportAccessInput): Promise<{ revoked: boolean }> {
  const updated = await tx.query<{ id: string; scope: string; ticket_ref: string }>(
    `UPDATE support_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING id, scope, ticket_ref`,
    [input.grantId],
  );
  const row = updated.rows[0];
  if (row === undefined) {
    incrementCounter("nominara_support_grants_changed_total", { outcome: "revoke_noop" });
    return { revoked: false };
  }
  await new AuditChainService().append(tx, {
    workspaceId: input.workspaceId,
    actorType: "system",
    actorId: SYSTEM_ACTOR_ID,
    actorIp: null,
    actorUa: `operator:${input.operator}`,
    action: "support.grant_revoked",
    resourceType: "support_grant",
    resourceId: row.id,
    beforeState: { scope: row.scope, ticket_ref: row.ticket_ref },
    afterState: { revoked: true, operator: input.operator },
    requestId: row.ticket_ref,
    supportGrantId: null,
    severity: "notice",
  });
  incrementCounter("nominara_support_grants_changed_total", { outcome: "revoked" });
  return { revoked: true };
}
