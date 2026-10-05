import { ConflictException, Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { generateInvitationToken, hashInvitationToken, INVITATION_TTL_MS } from "../../lib/auth/invitation-token.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { InvitationInvalidException } from "../../tenancy/errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { currentTenantStore, withTenantContext } from "../../tenancy/tenant-context.js";
import type { AuditRequestMeta } from "./workspaces.service.js";
import type { CreateInvitationRequest, InvitationResponse, MemberResponse } from "./dto/index.js";

// STORY-021-E-6/E-7 — invitation lifecycle. The create/list paths are
// ordinary workspace-scoped routes (the inviter already has a live
// membership in the target workspace) and run on the ambient transaction;
// accept is @SkipTenantContext() (the invitee has no membership yet) and
// opens its own transaction (E-12).

interface InvitationRow {
  id: string;
  workspace_id: string;
  email: string;
  role: string;
  project_scope: string[] | null;
  expires_at: Date;
  created_at: Date;
}

interface MemberRow {
  id: string;
  user_id: string;
  role: string;
  project_scope: string[] | null;
  status: string;
  joined_at: Date;
  last_active_at: Date | null;
}

const INVITATION_COLUMNS = "id, workspace_id, email, role, project_scope, expires_at, created_at";
const MEMBER_COLUMNS = "id, user_id, role, project_scope, status, joined_at, last_active_at";

function toInvitationResponse(row: InvitationRow, token?: string): InvitationResponse {
  return {
    id: row.id,
    workspace_id: row.workspace_id,
    email: row.email,
    role: row.role as InvitationResponse["role"],
    project_scope: row.project_scope ?? null,
    expires_at: row.expires_at.toISOString(),
    created_at: row.created_at.toISOString(),
    ...(token !== undefined ? { token } : {}),
  };
}

function toMemberResponse(row: MemberRow): MemberResponse {
  return {
    id: row.id,
    user_id: row.user_id,
    role: row.role as MemberResponse["role"],
    project_scope: row.project_scope ?? null,
    status: row.status as MemberResponse["status"],
    joined_at: row.joined_at.toISOString(),
    last_active_at: row.last_active_at ? row.last_active_at.toISOString() : null,
  };
}

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly auditChain: AuditChainService,
  ) {}

  /**
   * STORY-021 AC9/E-6/E-7/AC "one pending invitation per address" — never
   * queries `users` (E-7: nothing to branch timing on). Re-inviting the
   * same address supersedes the existing pending row (revoke-then-insert,
   * one transaction) rather than colliding with ux_invitations_pending.
   */
  async create(workspaceId: string, actorId: string, input: CreateInvitationRequest): Promise<InvitationResponse> {
    const client = currentTenantStore()!.client;

    await client.query(
      `UPDATE workspace_invitations
       SET revoked_at = now()
       WHERE workspace_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [workspaceId, input.email],
    );

    const rawToken = generateInvitationToken();
    const tokenHash = hashInvitationToken(rawToken);
    const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);

    const result = await client.query<InvitationRow>(
      `INSERT INTO workspace_invitations
         (id, workspace_id, email, role, project_scope, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${INVITATION_COLUMNS}`,
      [uuidV7(), workspaceId, input.email, input.role, input.project_scope ?? null, tokenHash, actorId, expiresAt],
    );

    return toInvitationResponse(result.rows[0]!, rawToken);
  }

  /**
   * STORY-021 AC "one pending invitation per address" — lists outstanding
   * (not yet accepted or revoked) invitations.
   *
   * STORY-117 — cursor-paginated (`NFR-API-03`), newest first as before. The
   * sort key is `(created_at, id)`: re-inviting an address revokes and
   * re-inserts in ONE transaction, so two rows here can share `created_at` to
   * the microsecond, and a cursor keyed on the timestamp alone would drop or
   * repeat one of them at a page boundary.
   */
  async list(workspaceId: string, pagination: PaginationRequest): Promise<Page<InvitationResponse>> {
    const after = pagination.cursor === undefined ? undefined : decodeCursor(pagination.cursor, 2);
    const client = currentTenantStore()!.client;
    const result = await client.query<InvitationRow & { created_at_key: string }>(
      `SELECT ${INVITATION_COLUMNS}, created_at::text AS created_at_key
       FROM workspace_invitations
       WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [workspaceId, after?.[0] ?? null, after?.[1] ?? null, pagination.limit + 1],
    );
    return pageFrom(
      result.rows,
      pagination.limit,
      (row) => toInvitationResponse(row),
      (row) => [row.created_at_key, row.id],
    );
  }

  /**
   * STORY-021 AC10/E-12 + STORY-172 — POST /workspaces/{id}/invitations/accept.
   * @SkipTenantContext(): the invitee is not yet a member of `workspaceId`,
   * so this opens its own transaction rather than reusing an ambient one.
   * The URL's `:id` IS the workspace the token must belong to — a token
   * that belongs to a different workspace simply matches zero rows here,
   * which is both "unknown token" and "wrong workspace" collapsed into the
   * same uniform refusal (E-7's enumeration-surface requirement extends
   * naturally to this path). Never touches `subscriptions`/`credit_wallets`
   * — the invitee's own entitlement is untouched (AC).
   *
   * STORY-172 — the token is a bearer secret, so possession of it is NOT
   * enough: the claim is bound, inside the one atomic UPDATE, to the acceptor's
   * VERIFIED email. Three things follow and must stay true:
   *
   *  1. A mismatch is a zero-row UPDATE, i.e. byte-identical to an unknown /
   *     expired / revoked / used token (same exception, same single statement),
   *     so it neither leaks that the token was real nor consumes it — the
   *     invited person can still accept within the TTL.
   *  2. "Verified" is `users.email_verified_at IS NOT NULL`, never
   *     `status = 'active'`: a passkey registration promotes status without
   *     anyone proving they control the address.
   *  3. Email comparison is `users.email = i.email`; both columns are citext,
   *     so it is case-insensitive without a second normaliser. (OTP/OAuth
   *     store users.email via normalizeEmail; the invite stores it as typed.)
   *
   * An already-active member is refused with a 409 AFTER the claim, by
   * throwing so the transaction rolls the claim back (token unconsumed). That
   * distinct response is safe only because the email-bound claim above means
   * the only caller who can reach it is the invited, verified person.
   */
  async accept(workspaceId: string, userId: string, rawToken: string, meta: AuditRequestMeta): Promise<MemberResponse> {
    const tokenHash = hashInvitationToken(rawToken);
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: userId }, async (tx) => {
        const claimed = await tx.query<{ role: string; project_scope: string[] | null; invited_by: string }>(
          `UPDATE workspace_invitations AS i
           SET accepted_at = now(), accepted_user_id = $1
           WHERE i.workspace_id = $2 AND i.token_hash = $3
             AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
             AND EXISTS (
               SELECT 1 FROM users u
               WHERE u.id = $1 AND u.email = i.email
                 AND u.email_verified_at IS NOT NULL AND u.deleted_at IS NULL AND u.status = 'active'
             )
           RETURNING i.role, i.project_scope, i.invited_by`,
          [userId, workspaceId, tokenHash],
        );
        const invitation = claimed.rows[0];
        if (!invitation) {
          await this.recordRefusal(tx, workspaceId, userId, tokenHash);
          throw new InvitationInvalidException();
        }

        const inserted = await tx.query<MemberRow>(
          `INSERT INTO workspace_members (id, workspace_id, user_id, role, project_scope, invited_by, status)
           VALUES ($1,$2,$3,$4,$5,$6,'active')
           ON CONFLICT (workspace_id, user_id) WHERE status <> 'removed' DO NOTHING
           RETURNING ${MEMBER_COLUMNS}`,
          [uuidV7(), workspaceId, userId, invitation.role, invitation.project_scope, invitation.invited_by],
        );

        let memberRow = inserted.rows[0];
        if (!memberRow) {
          const existing = await tx.query<MemberRow>(
            `SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND status <> 'removed'`,
            [workspaceId, userId],
          );
          memberRow = existing.rows[0]!;

          // STORY-021-E-13 — the ON CONFLICT target above also matches a
          // suspended row (only 'active'/'suspended'/'removed' exist), which
          // would otherwise silently no-op: the invitee gets back a 200 and
          // an "accepted" audit row while remaining suspended, with no
          // signal anything is wrong. Refuse loudly instead — reactivating a
          // suspended member is an administrative action this story does
          // not build a path for (see the story's "Out of scope" list).
          if (memberRow.status === "suspended") {
            throw new ConflictException({
              code: "conflict",
              message: "this member is suspended and cannot accept a new invitation — an admin must reactivate them first",
              details: { reason: "member_suspended" },
            });
          }

          // STORY-172 — an already-active member used to burn the token and
          // get a 200 with the EXISTING role, the invited role silently not
          // applied. Refuse instead. Throwing rolls the transaction back, so
          // the claim UPDATE above is undone and the token stays usable
          // (e.g. an admin can revoke it, or re-invite at a different role
          // after removing the member). Reachable only by the verified
          // holder of the invited address — see the method comment.
          throw new ConflictException({
            code: "conflict",
            message: "you are already a member of this workspace",
            details: { reason: "already_member" },
          });
        }

        const response = toMemberResponse(memberRow);
        await this.auditChain.append(tx, {
          workspaceId,
          actorType: "user",
          actorId: userId,
          actorIp: meta.ip,
          actorUa: meta.ua,
          action: "member.invitation_accepted",
          resourceType: "workspace_member",
          resourceId: memberRow.id,
          beforeState: null,
          afterState: response,
          requestId: meta.requestId,
          supportGrantId: null,
          severity: "info",
        });
        return response;
      });
    } finally {
      client.release();
    }
  }

  /**
   * STORY-172 — records WHY a claim matched no row, internally only: a counter
   * label and a redacted log line (workspace ID, reason — never the token, an
   * address or a name). It is deliberately NOT an audit-log row: the audit chain
   * takes a per-workspace lock and this path is reachable by any authenticated
   * caller with any token, so writing there would hand them a way to contend on
   * a victim workspace's chain, and an append that happened only on a mismatch
   * would also be a timing tell.
   *
   * Timing: this single diagnostic SELECT runs on EVERY refusal (unknown token
   * included), so a mismatch costs the same round trips as an unknown token.
   * It re-states the claim's predicates and must stay in step with them; it
   * only labels a refusal that has already happened and never grants anything.
   */
  private async recordRefusal(
    tx: ClientBase,
    workspaceId: string,
    userId: string,
    tokenHash: Buffer,
  ): Promise<void> {
    const probe = await tx.query<{ email_match: boolean | null; account_ok: boolean | null }>(
      `SELECT (u.email = i.email) AS email_match,
              (u.email_verified_at IS NOT NULL AND u.deleted_at IS NULL AND u.status = 'active') AS account_ok
       FROM workspace_invitations i
       LEFT JOIN users u ON u.id = $1
       WHERE i.workspace_id = $2 AND i.token_hash = $3
         AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()`,
      [userId, workspaceId, tokenHash],
    );
    const row = probe.rows[0];
    const reason = !row ? "token_unusable" : row.email_match !== true ? "email_mismatch" : row.account_ok !== true ? "account_not_verified" : "unclassified";
    incrementCounter("nominara_identity_invitation_accept_refused_total", { reason });
    this.logger.warn(`invitation accept refused workspace_id=${workspaceId} reason=${reason}`);
  }
}
