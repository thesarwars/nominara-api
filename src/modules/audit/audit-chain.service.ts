import { Injectable } from "@nestjs/common";
import type { ClientBase } from "pg";
import {
  GENESIS_HASH,
  computeRowHash,
  type AuditActorType,
  type AuditRowContent,
  type AuditSeverity,
} from "../../lib/crypto/audit-chain.js";
import { safeActorIp } from "../../lib/crypto/actor-ip.js";
import { redactState } from "../../lib/crypto/redact.js";

// STORY-020 — security-and-tenancy.md §12. Runs on the SAME context-carrying
// transaction as the mutation it audits (caller — AuditInterceptor — is
// responsible for that); this file only owns the chain arithmetic and the
// redact-before-write step, never opens or closes a transaction itself.

export interface AppendAuditRowInput {
  readonly workspaceId: string;
  readonly actorType: AuditActorType;
  readonly actorId: string | null;
  readonly actorIp: string | null;
  readonly actorUa: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly beforeState: unknown;
  readonly afterState: unknown;
  readonly requestId: string;
  readonly supportGrantId: string | null;
  readonly severity: AuditSeverity;
}

function toJsonbParam(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

@Injectable()
export class AuditChainService {
  /**
   * Appends one row to `input.workspaceId`'s chain. The advisory xact lock
   * (auto-released at COMMIT/ROLLBACK) serializes concurrent appends to the
   * SAME workspace so two in-flight requests never read the same tail and
   * fork the chain; it is keyed on workspace_id so unrelated tenants never
   * contend with each other (per-tenant chaining, not global).
   */
  async append(client: ClientBase, input: AppendAuditRowInput): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.workspaceId]);

    const tail = await client.query<{ row_hash: Buffer }>(
      "SELECT row_hash FROM audit_log WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1",
      [input.workspaceId],
    );
    const prevHash: Buffer = tail.rows[0]?.row_hash ?? GENESIS_HASH;

    // Redacted BEFORE the hash is computed — redaction covers content, so a
    // verifier re-walking the chain later recomputes the SAME hash from the
    // SAME (already-redacted) stored content (AC: "redacted before the row
    // is written, never after").
    const content: AuditRowContent = {
      workspace_id: input.workspaceId,
      occurred_at: new Date().toISOString(),
      actor_type: input.actorType,
      actor_id: input.actorId,
      // Validated BEFORE the hash, for the same reason redactState runs before
      // it: the verifier recomputes from the stored content, so anything that
      // changes on the way into the column must change before the hash sees
      // it. See lib/crypto/actor-ip.ts.
      actor_ip: safeActorIp(input.actorIp),
      actor_ua: input.actorUa,
      action: input.action,
      resource_type: input.resourceType,
      resource_id: input.resourceId,
      before_state: redactState(input.beforeState),
      after_state: redactState(input.afterState),
      request_id: input.requestId,
      support_grant_id: input.supportGrantId,
      severity: input.severity,
    };
    const rowHash = computeRowHash(prevHash, content);

    await client.query(
      `INSERT INTO audit_log
         (workspace_id, occurred_at, actor_type, actor_id, actor_ip, actor_ua, action, resource_type,
          resource_id, before_state, after_state, request_id, support_grant_id, severity, prev_hash, row_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        content.workspace_id,
        content.occurred_at,
        content.actor_type,
        content.actor_id,
        content.actor_ip,
        content.actor_ua,
        content.action,
        content.resource_type,
        content.resource_id,
        toJsonbParam(content.before_state),
        toJsonbParam(content.after_state),
        content.request_id,
        content.support_grant_id,
        content.severity,
        prevHash,
        rowHash,
      ],
    );
  }
}
