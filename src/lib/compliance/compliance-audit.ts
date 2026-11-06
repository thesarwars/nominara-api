import { randomUUID } from "node:crypto";
import type { ClientBase } from "pg";
import type { AuditActorType, AuditSeverity } from "../crypto/audit-chain.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";

// STORY-111 - one place the compliance mechanics write their audit rows (legal holds, subject requests). They run on an owner connection
// OUTSIDE any request, in the caller's transaction or autocommit; the hash chain is the same one every other writer extends.

const chain = new AuditChainService();

export interface ComplianceAuditInput {
  readonly workspaceId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  /** Identifiers and closed vocabulary only. Never customer content, never an address or a name. */
  readonly afterState: Record<string, unknown>;
  readonly severity?: AuditSeverity;
  readonly requestId?: string;
}

export async function appendComplianceAudit(client: ClientBase, input: ComplianceAuditInput): Promise<void> {
  await chain.append(client, {
    workspaceId: input.workspaceId,
    actorType: input.actorType,
    actorId: input.actorId,
    actorIp: null,
    actorUa: null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    beforeState: null,
    afterState: input.afterState,
    requestId: input.requestId ?? `compliance-${randomUUID()}`,
    supportGrantId: null,
    severity: input.severity ?? "notice",
  });
}
