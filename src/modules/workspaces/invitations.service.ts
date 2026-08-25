import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { Pool } from "pg";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { generateInvitationToken, hashInvitationToken, INVITATION_TTL_MS } from "../../lib/auth/invitation-token.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { InvitationInvalidException } from "../../tenancy/errors.js";
import { decodeCursor } from "../../api/pagination/cursor.js";
import { Page, pageFrom } from "../../api/pagination/page.js";
import type { PaginationRequest } from "../../../contracts/common/pagination.schema.js";
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
   * STORY-021 AC10/E-12 — POST /workspaces/{id}/invitations/accept.
   * @SkipTenantContext(): the invitee is not yet a member of `workspaceId`,
   * so this opens its own transaction rather than reusing an ambient one.
   * The URL's `:id` IS the workspace the token must belong to — a token
   * that belongs to a different workspace simply matches zero rows here,
   * which is both "unknown token" and "wrong workspace" collapsed into the
   * same uniform refusal (E-7's enumeration-surface requirement extends
   * naturally to this path). Never touches `subscriptions`/`credit_wallets`
   * — the invitee's own entitlement is untouched (AC).
   */
  async accept(workspaceId: string, userId: string, rawToken: string, meta: AuditRequestMeta): Promise<MemberResponse> {
    const tokenHash = hashInvitationToken(rawToken);
    const client = await this.pool.connect();
    try {
      return await withTenantContext(client, { workspaceId, actorId: userId }, async (tx) => {
        const claimed = await tx.query<{ role: string; project_scope: string[] | null; invited_by: string }>(
          `UPDATE workspace_invitations
           SET accepted_at = now(), accepted_user_id = $1
           WHERE workspace_id = $2 AND token_hash = $3
             AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
           RETURNING role, project_scope, invited_by`,
          [userId, workspaceId, tokenHash],
        );
        const invitation = claimed.rows[0];
        if (!invitation) {
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
}
