import { randomBytes } from "node:crypto";
import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { entityTagFor } from "../../api/etag/entity-tag.js";
import { assertIfMatch } from "../../api/etag/if-match.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { uuidV7 } from "../../lib/ids/uuidv7.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import {
  EmailNotVerifiedException,
  NotAMemberException,
  PermissionDeniedException,
  WorkspaceLimitReachedException,
  WorkspaceSuspendedException,
} from "../../tenancy/errors.js";
import { currentTenantStore, withActorContext, withTenantContext } from "../../tenancy/tenant-context.js";
import { SessionService } from "../identity/session.service.js";
import { DEK_PROVISIONER, type DekProvisioner } from "./ports/dek-provisioner.js";
import { MembershipService } from "./membership.service.js";
import type {
  CreateWorkspaceRequest,
  MemberResponse,
  UpdateMemberRoleRequest,
  UpdateWorkspaceRequest,
  WorkspaceListResponse,
  WorkspaceResponse,
} from "./dto/index.js";

// STORY-022 scaffold, extended by STORY-018 (suspend/bumpEntitlementVersion
// — signatures UNCHANGED; test/integration/workspace-guard-and-revocation.spec.ts
// calls them directly with an explicit `pool` argument) and now STORY-021
// with the full workspace-management surface. Ordinary (non-@SkipTenantContext)
// methods below read the ambient transaction via currentTenantStore()!.client
// — the same one TenantContextInterceptor already opened from req.tenant and
// AuditInterceptor later reads to append the @Audit() row — rather than
// opening a second, competing transaction. The three @SkipTenantContext()
// entry points (create/switchTo/InvitationsService.accept) have no ambient
// transaction to reuse and open their own via withTenantContext (STORY-021-E-12).

export interface AuditRequestMeta {
  readonly ip: string | null;
  readonly ua: string | null;
  readonly requestId: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  org_type: string;
  region: string;
  timezone: string;
  plan_key: string;
  entitlement_version: number;
  status: string;
  created_at: Date;
  updated_at: Date;
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

const MAX_SLUG_ATTEMPTS = 5;
const WORKSPACE_COLUMNS =
  "id, name, slug, org_type, region, timezone, plan_key, entitlement_version, status, created_at, updated_at";
const MEMBER_COLUMNS = "id, user_id, role, project_scope, status, joined_at, last_active_at";

function kebabCase(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base.length > 0 ? base : "workspace";
}

function toWorkspaceResponse(row: WorkspaceRow): WorkspaceResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    org_type: row.org_type as WorkspaceResponse["org_type"],
    region: row.region as WorkspaceResponse["region"],
    timezone: row.timezone,
    plan_key: row.plan_key,
    entitlement_version: row.entitlement_version,
    status: row.status as WorkspaceResponse["status"],
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
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
export class WorkspacesService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(DEK_PROVISIONER) private readonly dekProvisioner: DekProvisioner,
    private readonly auditChain: AuditChainService,
    private readonly membership: MembershipService,
    private readonly sessions: SessionService,
  ) {}

  /** Test scenario 8 (STORY-018): a suspended workspace refuses access immediately (WorkspaceGuard reads status live, never cached). */
  async suspend(pool: Pool, workspaceId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query("UPDATE workspaces SET status = 'suspended', updated_at = now() WHERE id = $1", [
          workspaceId,
        ]);
      });
    } finally {
      client.release();
    }
  }

  /** Test scenario 7 (STORY-018): bumping entitlement_version forces the next request bearing a stale ent_v claim to refresh. */
  async bumpEntitlementVersion(pool: Pool, workspaceId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
        await tx.query(
          "UPDATE workspaces SET entitlement_version = entitlement_version + 1, updated_at = now() WHERE id = $1",
          [workspaceId],
        );
      });
    } finally {
      client.release();
    }
  }

  /**
   * STORY-021 AC1/E-1/E-2/E-4/E-10/E-12 — workspace + DEK + owner membership
   * + starting subscription, all in ONE transaction, plus the in-service
   * `workspace.created` audit row (this route is @SkipTenantContext(), so
   * AuditInterceptor cannot reach it — E-12). A slug collision
   * (ux_workspaces_slug) retries with a fresh suffix on a NEW attempt of the
   * whole transaction (a failed statement aborts the transaction, so
   * retrying mid-transaction is not an option); ux_one_owned_workspace_per_user
   * maps to WorkspaceLimitReachedException specifically (E-5), and every
   * OTHER unique violation maps to a plain 409 conflict.
   */
  async create(userId: string, input: CreateWorkspaceRequest, meta: AuditRequestMeta): Promise<WorkspaceResponse> {
    const workspaceId = uuidV7();
    const baseSlug = kebabCase(input.name);
    const orgType = input.org_type ?? "in_house";
    const region = input.region ?? "us-east-1";
    const timezone = input.timezone ?? "UTC";

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${randomBytes(3).toString("hex")}`;
      const client = await this.pool.connect();
      try {
        return await withTenantContext(client, { workspaceId, actorId: userId }, (tx) =>
          this.insertWorkspaceRows(tx, workspaceId, userId, input.name, slug, orgType, region, timezone, meta),
        );
      } catch (error) {
        const pg = error as { code?: string; constraint?: string };
        if (pg?.code === "23505" && pg.constraint === "ux_workspaces_slug") {
          continue;
        }
        if (pg?.code === "23505" && pg.constraint === "ux_one_owned_workspace_per_user") {
          throw new WorkspaceLimitReachedException(await this.findOwnedWorkspace(userId));
        }
        if (pg?.code === "23505") {
          throw new ConflictException({
            code: "conflict",
            message: "a unique constraint was violated creating the workspace",
          });
        }
        throw error;
      } finally {
        client.release();
      }
    }
    throw new ConflictException({ code: "conflict", message: "could not allocate a unique workspace slug" });
  }

  private async insertWorkspaceRows(
    tx: ClientBase,
    workspaceId: string,
    userId: string,
    name: string,
    slug: string,
    orgType: string,
    region: string,
    timezone: string,
    meta: AuditRequestMeta,
  ): Promise<WorkspaceResponse> {
    // STORY-015 — AC "An email the provider did not verify creates the
    // account in an unverified state with no workspace-create right."
    // Inside this transaction (not before it, and not via a separate
    // round-trip on this.pool): a status check outside the transaction a
    // slug-collision retry re-opens could race a concurrent email
    // verification, and gating here — right before the first mutating
    // statement — means a rolled-back attempt never leaves a workspace
    // behind for an acting user this resolves as unverified.
    const actor = await tx.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [userId]);
    if (actor.rows[0]?.status === "unverified") {
      throw new EmailNotVerifiedException();
    }

    const workspaceResult = await tx.query<WorkspaceRow>(
      `INSERT INTO workspaces (id, name, slug, org_type, region, timezone, plan_key)
       VALUES ($1,$2,$3,$4,$5,$6,'free')
       RETURNING ${WORKSPACE_COLUMNS}`,
      [workspaceId, name, slug, orgType, region, timezone],
    );
    const workspaceRow = workspaceResult.rows[0]!;

    // STORY-021-E-10 — provisioned in-process (no network call), inside the
    // same transaction: a provisioning failure rolls the whole workspace
    // back rather than leaving a keyless workspace behind.
    const dek = await this.dekProvisioner.provision(workspaceId);
    await tx.query(
      `INSERT INTO workspace_keys (id, workspace_id, dek_id, wrapped_dek, kms_key_arn)
       VALUES ($1,$2,$3,$4,$5)`,
      [uuidV7(), workspaceId, dek.dekId, dek.wrappedDek, dek.kmsKeyArn],
    );

    await tx.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, status)
       VALUES ($1,$2,$3,'owner','active')`,
      [uuidV7(), workspaceId, userId],
    );

    // STORY-021-E-1/E-2 — free plan, active status, deterministic local
    // Stripe placeholders (unique per workspace); no trial length invented.
    await tx.query(
      `INSERT INTO subscriptions
         (id, workspace_id, plan_key, billing_interval, stripe_customer_id, stripe_subscription_id,
          status, current_period_start, current_period_end, trial_ends_at)
       VALUES ($1,$2,'free','monthly',$3,$4,'active', now(), now() + interval '1 month', NULL)`,
      [uuidV7(), workspaceId, `local_cus_${workspaceId}`, `local_sub_${workspaceId}`],
    );

    const response = toWorkspaceResponse(workspaceRow);

    // STORY-021-E-12 — @SkipTenantContext() route: AuditInterceptor never
    // reaches this handler, so the audit row is appended here, inside this
    // same transaction.
    await this.auditChain.append(tx, {
      workspaceId,
      actorType: "user",
      actorId: userId,
      actorIp: meta.ip,
      actorUa: meta.ua,
      action: "workspace.created",
      resourceType: "workspace",
      resourceId: workspaceId,
      beforeState: null,
      afterState: response,
      requestId: meta.requestId,
      supportGrantId: null,
      severity: "info",
    });

    return response;
  }

  /** Cross-tenant self-read (ADR-0001) for E-5's "naming the existing workspace" conflict detail. */
  private async findOwnedWorkspace(userId: string): Promise<{ id: string; name: string; slug: string }> {
    const client = await this.pool.connect();
    try {
      return await withActorContext(client, { actorId: userId }, async (tx) => {
        const result = await tx.query<{ id: string; name: string; slug: string }>(
          `SELECT w.id, w.name, w.slug FROM workspaces w
           JOIN workspace_members m ON m.workspace_id = w.id
           WHERE m.user_id = $1 AND m.role = 'owner' AND m.status = 'active'`,
          [userId],
        );
        const row = result.rows[0];
        if (!row) {
          throw new Error("ux_one_owned_workspace_per_user violated but no owned workspace row was found");
        }
        return row;
      });
    } finally {
      client.release();
    }
  }

  /** STORY-021 AC5/E-11 — GET /workspaces. Cross-tenant self-read under the ADR-0001 actor-only policy class, never withTenantContext. */
  async listForActor(userId: string): Promise<WorkspaceListResponse> {
    const client = await this.pool.connect();
    try {
      return await withActorContext(client, { actorId: userId }, async (tx) => {
        const result = await tx.query<{
          workspace_id: string;
          name: string;
          slug: string;
          role: string;
          plan_key: string;
          status: string;
        }>(
          `SELECT w.id AS workspace_id, w.name, w.slug, m.role, w.plan_key, w.status
           FROM workspace_members m
           JOIN workspaces w ON w.id = m.workspace_id
           WHERE m.user_id = $1 AND m.status = 'active'
           ORDER BY w.created_at ASC`,
          [userId],
        );

        const owned: WorkspaceListResponse["owned"] = [];
        const joined: WorkspaceListResponse["joined"] = [];
        for (const row of result.rows) {
          const item = {
            workspace_id: row.workspace_id,
            name: row.name,
            slug: row.slug,
            role: row.role as MemberResponse["role"],
            plan_key: row.plan_key,
            status: row.status as WorkspaceResponse["status"],
          };
          (row.role === "owner" ? owned : joined).push(item);
        }
        return { owned, joined };
      });
    } finally {
      client.release();
    }
  }

  /**
   * STORY-021 AC4/E-8 — PATCH /workspaces/{id}. Ordinary workspace-scoped
   * route: runs on the ambient transaction TenantContextInterceptor already
   * opened from req.tenant (workspaceId is that same value, already
   * verified against the URL by assertMatchesTenant in the controller).
   * `region` is accepted so it can be refused with an explanation rather
   * than rejected as an unrecognized key.
   *
   * STORY-024 T11 — AC8. `ifMatch` is the parsed `If-Match` precondition and
   * is REQUIRED: assertIfMatch() refuses `undefined` with 422
   * `precondition_unmet` and a stale tag with 409 `conflict`.
   *
   * The whole read-check-write runs on ONE statement sequence inside the
   * ambient transaction that TenantContextInterceptor opened
   * (`currentTenantStore()!.client`), and the read takes `FOR UPDATE`. Both
   * are load-bearing: without the row lock this is check-then-act, and a
   * concurrent writer committing between the SELECT and the UPDATE would be
   * silently overwritten — which is the exact lost update the precondition
   * exists to detect, reintroduced one line below the check for it.
   *
   * The `FOR UPDATE` also closes the same race on the pre-existing region
   * immutability check, which read without a lock before this change.
   */
  async update(
    workspaceId: string,
    input: UpdateWorkspaceRequest,
    ifMatch: string[] | "*" | undefined,
  ): Promise<WorkspaceResponse> {
    const client = currentTenantStore()!.client;

    const current = await client.query<WorkspaceRow>(
      `SELECT ${WORKSPACE_COLUMNS} FROM workspaces WHERE id = $1 FOR UPDATE`,
      [workspaceId],
    );
    const currentRow = current.rows[0];
    if (currentRow === undefined) {
      throw new NotFoundException();
    }

    // Ordered before the region check so a caller holding a stale tag is
    // told THAT, rather than being told their region is immutable on the
    // basis of a representation they never saw.
    assertIfMatch(ifMatch, entityTagFor(toWorkspaceResponse(currentRow)));

    if (input.region !== undefined && input.region !== currentRow.region) {
      throw new ConflictException({
        code: "conflict",
        message: "data residency is fixed at creation and cannot be changed",
        details: { field: "region", current: currentRow.region, reason: "region_immutable" },
      });
    }

    const result = await client.query<WorkspaceRow>(
      `UPDATE workspaces
       SET name = COALESCE($2, name), timezone = COALESCE($3, timezone)
       WHERE id = $1
       RETURNING ${WORKSPACE_COLUMNS}`,
      [workspaceId, input.name ?? null, input.timezone ?? null],
    );
    return toWorkspaceResponse(result.rows[0]!);
  }

  /**
   * STORY-021 AC6/E-3 — POST /workspaces/{id}/switch. @SkipTenantContext():
   * the target workspace is not necessarily the one in the caller's current
   * token, so this opens its own transaction (E-12) rather than relying on
   * an ambient one that may not exist or may name the wrong tenant.
   */
  async switchTo(
    userId: string,
    sid: string,
    workspaceId: string,
    meta: AuditRequestMeta,
  ): Promise<{ accessToken: string; csrfToken: string }> {
    const workspaceStatus = await this.membership.getWorkspaceStatus(this.pool, workspaceId);
    // Mirrors WorkspaceGuard.assertWorkspaceIsUsable exactly (STORY-018) — a
    // token minted for a suspended/pending-deletion/deleted workspace would
    // be refused on the very next request anyway; refusing it here too means
    // switching never hands back a token good for zero requests.
    const isUnusable =
      !workspaceStatus ||
      workspaceStatus.status === "suspended" ||
      workspaceStatus.status === "pending_deletion" ||
      workspaceStatus.status === "deleted" ||
      workspaceStatus.deletedAt !== null;
    if (isUnusable) {
      throw new WorkspaceSuspendedException();
    }

    const live = await this.membership.getLiveMembership(this.pool, userId, workspaceId);
    if (!live || live.status !== "active") {
      throw new NotAMemberException();
    }

    const client = await this.pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: userId }, async (tx) => {
        await tx.query(
          "UPDATE workspace_members SET last_active_at = now() WHERE workspace_id = $1 AND user_id = $2",
          [workspaceId, userId],
        );
        await this.auditChain.append(tx, {
          workspaceId,
          actorType: "user",
          actorId: userId,
          actorIp: meta.ip,
          actorUa: meta.ua,
          action: "workspace.switched",
          resourceType: "workspace",
          resourceId: workspaceId,
          beforeState: null,
          afterState: null,
          requestId: meta.requestId,
          supportGrantId: null,
          severity: "info",
        });
      });
    } finally {
      client.release();
    }

    return this.sessions.switchWorkspace(
      sid,
      userId,
      workspaceId,
      live.role,
      live.projectScope,
      workspaceStatus.entitlementVersion,
    );
  }

  /** STORY-021 AC7 — GET /workspaces/{id}/members. Ordinary route, ambient transaction. */
  async listMembers(): Promise<MemberResponse[]> {
    const client = currentTenantStore()!.client;
    const result = await client.query<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE status <> 'removed' ORDER BY joined_at ASC`,
    );
    return result.rows.map(toMemberResponse);
  }

  /**
   * STORY-021 AC7/E-9 — PATCH /members/{id}. `actorRole` is the caller's
   * OWN live role (req.membership.role), never re-derived here. The two
   * ownership refusal shapes are deliberately distinct — see E-9.
   */
  async updateMemberRole(
    workspaceId: string,
    actorRole: string,
    memberId: string,
    input: UpdateMemberRoleRequest,
  ): Promise<MemberResponse> {
    const client = currentTenantStore()!.client;

    const target = await client.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE id = $1`, [
      memberId,
    ]);
    const targetRow = target.rows[0];
    if (!targetRow) {
      throw new NotFoundException();
    }

    if (targetRow.role === "owner" && input.role !== "owner") {
      throw new ConflictException({
        code: "conflict",
        message: "the owner cannot be demoted — transfer ownership instead",
        details: { reason: "owner_removal_requires_transfer" },
      });
    }

    if (input.role === "owner") {
      if (actorRole !== "owner") {
        throw new PermissionDeniedException("workspace:transfer_ownership");
      }
      throw new ConflictException({
        code: "conflict",
        message: "granting ownership is not done through a role change — transfer ownership instead",
        details: { reason: "ownership_requires_transfer" },
      });
    }

    // Delegates to STORY-018's existing seam so cache invalidation is not
    // duplicated (STORY-018-E-5 / STORY-021-E-9). Passes the ambient client
    // (code-review fix) so this mutation shares TenantContextInterceptor's
    // transaction/AuditInterceptor's audit write instead of committing on a
    // separate connection first.
    await this.membership.updateRole(this.pool, workspaceId, targetRow.user_id, input.role, client);

    if (input.project_scope !== undefined) {
      await client.query("UPDATE workspace_members SET project_scope = $2 WHERE id = $1", [
        memberId,
        input.project_scope,
      ]);
    }

    const updated = await client.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE id = $1`, [
      memberId,
    ]);
    return toMemberResponse(updated.rows[0]!);
  }

  /** STORY-021 AC8/E-9 — DELETE /members/{id}. The owner cannot be removed at all; ownership must be transferred. */
  async removeMemberById(workspaceId: string, memberId: string): Promise<void> {
    const client = currentTenantStore()!.client;

    const target = await client.query<MemberRow>(`SELECT ${MEMBER_COLUMNS} FROM workspace_members WHERE id = $1`, [
      memberId,
    ]);
    const targetRow = target.rows[0];
    if (!targetRow) {
      throw new NotFoundException();
    }
    if (targetRow.role === "owner") {
      throw new ConflictException({
        code: "conflict",
        message: "the owner cannot be removed — transfer ownership instead",
        details: { reason: "owner_removal_requires_transfer" },
      });
    }

    // Ambient client (code-review fix) — see updateMemberRole's comment.
    await this.membership.removeMember(this.pool, workspaceId, targetRow.user_id, client);
  }
}
