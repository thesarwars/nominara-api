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

    // The chain tail AND the actor's address, in one statement.
    //
    // ⚠ `host()` IS WHY THIS IS CORRECT RATHER THAN CAREFUL. STORY-149.
    //
    // `actor_ip` is `inet`, so Postgres rewrites what it stores — and the
    // verifier reads the row back with `host(actor_ip)`
    // (src/modules/audit/audit-log-reader.ts). Hashing the string a CALLER
    // sent therefore hashes something the row can never present again:
    // '2001:0DB8::0001' comes back '2001:db8::1' and that workspace's chain
    // reports `hash_mismatch` from then on, permanently, with no way to
    // repair it. STORY-148 made that reachable by relaying the caller's
    // X-Forwarded-For chain.
    //
    // Normalising in Node was the obvious reach and the wrong one: no Node
    // API agrees with `host()` — WHATWG's URL parser turns '::ffff:127.0.0.1'
    // into '::ffff:7f00:1', breaking the common case to fix the rare one — so
    // any hand-rolled canonicaliser is a second implementation that must be
    // kept in step with Postgres forever. Asking Postgres is not a
    // round-trip we pay for: it folds into the tail read that was already
    // here, and it is the SAME FUNCTION the verifier uses, which is the whole
    // property. `host()` is idempotent and strict, so a null stays null and a
    // canonical address is returned unchanged.
    //
    // `safeActorIp` still runs first and still matters: `$2::inet` on a
    // non-address raises 22P02, and this statement is inside the MUTATION's
    // transaction, so an uncastable value would fail the request rather than
    // the audit row. The two halves compose — one makes the cast safe, the
    // other makes the hash agree with the read.
    const head = await client.query<{ row_hash: Buffer | null; actor_ip: string | null }>(
      `SELECT (SELECT row_hash FROM audit_log WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1) AS row_hash,
              host($2::inet) AS actor_ip`,
      [input.workspaceId, safeActorIp(input.actorIp)],
    );
    const prevHash: Buffer = head.rows[0]?.row_hash ?? GENESIS_HASH;

    // Redacted BEFORE the hash is computed — redaction covers content, so a
    // verifier re-walking the chain later recomputes the SAME hash from the
    // SAME (already-redacted) stored content (AC: "redacted before the row
    // is written, never after").
    const content: AuditRowContent = {
      workspace_id: input.workspaceId,
      occurred_at: new Date().toISOString(),
      actor_type: input.actorType,
      actor_id: input.actorId,
      // Canonical BEFORE the hash, for the same reason redactState runs before
      // it: the verifier recomputes from the STORED content, so anything that
      // changes on the way into the column must change before the hash sees
      // it. See the `host()` note above and lib/crypto/actor-ip.ts.
      actor_ip: head.rows[0]?.actor_ip ?? null,
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
