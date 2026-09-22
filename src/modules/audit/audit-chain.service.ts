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

/** A real user agent is well under this; see the note beside `actor_ua` below. */
const MAX_ACTOR_UA_LENGTH = 512;

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
    // ⚠ EVERY FIELD POSTGRES REWRITES, CANONICALISED BEFORE THE HASH SEES IT.
    // STORY-149, widened by its own review.
    //
    // The verifier recomputes each row's hash from the STORED content
    // (src/modules/audit/audit-log-reader.ts), so any column whose type
    // rewrites its input produces a row whose hash can never be recomputed —
    // a permanent `hash_mismatch` that the daily verifier reports as tampering
    // against that TENANT, with nothing able to repair it.
    //
    // `actor_ip` was the field STORY-148's review named. It was not the class.
    // `workspace_id`, `actor_id`, `resource_id` and `support_grant_id` are all
    // `uuid`, so Postgres lowercases them — and `UUID_PATTERN` in
    // audit.interceptor.ts is case-INSENSITIVE while no `ParseUUIDPipe` exists
    // anywhere in this repository. So an uppercase uuid in a URL path reached
    // here verbatim, and ANY authenticated member could break their own
    // workspace's chain by typing the path in capitals. No relayed header, no
    // `TRUST_PROXY_HOPS`, nothing to configure — that one was live.
    //
    // ⚠ AND THE LOCK IS KEYED ON THE CANONICAL ID, WHICH IS NOT COSMETIC.
    // `hashtextextended` is a hash of the STRING, so the two spellings of one
    // workspace produced two different lock keys and did not serialize against
    // each other at all — the chain could FORK on `prev_hash` as well as break
    // on `row_hash`. `POST /v1/workspaces/{id}/switch` passes its raw path
    // param as both the workspace id and the resource id, so that path hit
    // every one of these at once.
    //
    // ⚠ ASKING POSTGRES IS THE POINT. These are the same casts the columns
    // themselves apply, so the value hashed is the value stored is the value
    // read back — correct by construction rather than by two implementations
    // agreeing. A Node-side canonicaliser would be a second implementation to
    // keep in step forever, and drift is precisely the bug.
    //
    // ⚠ THE LOCK STAYS ITS OWN ROUND TRIP'S WORTH OF ORDERING. Evaluation
    // order inside one target list is unspecified, so the tail read must be a
    // SEPARATE statement to be certainly sequenced after the lock is granted.
    // It is the same three statements the append always made.
    const canonical = await client.query<{
      workspace_id: string;
      actor_id: string | null;
      resource_id: string | null;
      support_grant_id: string | null;
      actor_ip: string | null;
    }>(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0)) AS chain_lock,
              $1::uuid::text AS workspace_id,
              $2::uuid::text AS actor_id,
              $3::uuid::text AS resource_id,
              $4::uuid::text AS support_grant_id,
              host($5::inet)  AS actor_ip`,
      [
        input.workspaceId,
        input.actorId,
        input.resourceId,
        input.supportGrantId,
        // `$5::inet` on a non-address raises 22P02, and this statement runs
        // inside the MUTATION's transaction — so an uncastable value fails the
        // whole request and writes no audit row at all. See lib/crypto/actor-ip.ts.
        safeActorIp(input.actorIp),
      ],
    );
    const ids = canonical.rows[0]!;

    const tail = await client.query<{ row_hash: Buffer }>(
      "SELECT row_hash FROM audit_log WHERE workspace_id = $1 ORDER BY seq DESC LIMIT 1",
      [ids.workspace_id],
    );
    const prevHash: Buffer = tail.rows[0]?.row_hash ?? GENESIS_HASH;

    // Redacted BEFORE the hash is computed — redaction covers content, so a
    // verifier re-walking the chain later recomputes the SAME hash from the
    // SAME (already-redacted) stored content (AC: "redacted before the row
    // is written, never after").
    const content: AuditRowContent = {
      workspace_id: ids.workspace_id,
      occurred_at: new Date().toISOString(),
      actor_type: input.actorType,
      actor_id: ids.actor_id,
      // Canonical BEFORE the hash, for the same reason redactState runs before
      // it: the verifier recomputes from the STORED content, so anything that
      // changes on the way into the column must change before the hash sees it.
      actor_ip: ids.actor_ip,
      // ⚠ BOUNDED. `actor_ua` is `text` with no cap at any layer, and it is
      // caller-chosen on every audited mutation into an append-only table that
      // is pruned only by workspace hard delete — roughly 16KB a request, held
      // forever. A real user agent is under 256 characters; 512 keeps every
      // honest one whole. Truncating is lossy, and unbounded growth of an
      // immutable table at a caller's discretion is worse.
      actor_ua: input.actorUa === null ? null : input.actorUa.slice(0, MAX_ACTOR_UA_LENGTH),
      action: input.action,
      resource_type: input.resourceType,
      resource_id: ids.resource_id,
      // ⚠ `?? null` IS LOad-BEARING, not defensive noise.
      // `canonicalizeAuditContent` DROPS an undefined key, while
      // `toJsonbParam` writes SQL NULL — which the reader presents as `null`,
      // key PRESENT. So an undefined state hashed one shape and read back
      // another: the same asymmetry as the `uuid` columns, in a third place.
      // Every call site passes explicit null today, but `toJsonbParam`'s own
      // existence advertises undefined as expected input and the field is
      // typed `unknown`; one future caller would poison a chain silently.
      before_state: redactState(input.beforeState) ?? null,
      after_state: redactState(input.afterState) ?? null,
      request_id: input.requestId,
      support_grant_id: ids.support_grant_id,
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
