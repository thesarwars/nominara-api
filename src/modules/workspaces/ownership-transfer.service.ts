import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ClientBase, Pool } from "pg";
import { CONFLICT_REASONS } from "../../../contracts/common/error-details.schema.js";
import type { TransferOwnershipResponse } from "../../../contracts/workspaces/transfer-ownership-response.schema.js";
import {
  ConflictError,
  type DomainError,
  DegradedError,
  ForbiddenError,
  WorkspaceLimitReachedError,
} from "../../api/errors/domain-errors.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import { REALTIME_PUBLISHER, type RealtimePublisher } from "../../lib/cache/realtime-publisher.js";
import { buildIdempotencyKey } from "../../lib/queue/idempotency.js";
import { QueueProducer } from "../../lib/queue/queue-producer.js";
import { incrementCounter } from "../../lib/telemetry/metrics.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { PermissionDeniedException } from "../../tenancy/errors.js";
import { MembershipCacheService } from "../../tenancy/membership-cache.js";
import { assertStepUpFresh } from "../../tenancy/step-up.js";
import { currentTenantStore, afterCommit, withActorContext, withTenantContext } from "../../tenancy/tenant-context.js";
import { AuditChainService } from "../audit/audit-chain.service.js";
import { ApiKeysService } from "../api-keys/api-keys.service.js";
import { ShareTokensService } from "../agency/share-tokens.service.js";
import { BillingInvoicesService } from "../billing/billing-invoices.service.js";
import { IdentityService } from "../identity/identity.service.js";
import { SessionService } from "../identity/session.service.js";
import { InvitationsService } from "./invitations.service.js";
import {
  OWNERSHIP_TRANSFER_TTL_MS,
  expiresAtOf,
  isExpired,
  isPending,
  parseTransfer,
  type TransferDocument,
} from "./ownership-transfer.state.js";
import type { AuditRequestMeta } from "./workspaces.service.js";

// STORY-021 (core slice) / EC-15 — workspace ownership transfer.
//
// THE STATE LIVES IN `workspaces.ownership_transfer` (jsonb, validated by
// ownershipTransferSchema) — no new table. Initiating, declining and cancelling
// write only that document and an audit row: "nothing was mutated, because
// execution begins only after acceptance". Accepting is the execution.
//
// ISOLATION. Every method runs on the request's ambient, context-carrying
// transaction (RLS scopes it to the token's workspace) and takes the workspace
// row lock `FOR UPDATE` first, so initiate / accept / decline / cancel / a
// downgrade / a deletion all take turns. EC-15 asks for SERIALIZABLE on top;
// that is deliberately not used — a SERIALIZABLE transaction's snapshot is fixed
// at its first statement, the audit chain reads its tail AFTER taking its own
// advisory lock, and a snapshot older than a concurrent append would read a
// stale tail and FORK the chain (see the STORY-021 report). The row lock gives
// the same serial order for every writer that matters here, and each UPDATE in
// the swap asserts its row count, so a writer that does NOT take the lock (a
// member removal) makes the transfer fail closed instead of half-applying.
//
// THE RECIPIENT CHECKS ARE REPEATED AT ACCEPT. The offer can sit for seven days;
// an admin demoted, a passkey revoked, a workspace founded, an invoice gone past
// due or a deletion scheduled in between must each stop the swap.

const NOT_PENDING_MESSAGE = "there is no pending ownership transfer to act on";
const RECIPIENT_PERMISSION = "transfer_ownership_recipient";

type Role = "recipient" | "initiator";

interface WorkspaceRow {
  readonly id: string;
  readonly status: string;
  readonly deletion_requested_at: Date | null;
  readonly deletion_execute_at: Date | null;
  readonly deleted_at: Date | null;
  readonly ownership_transfer: unknown;
}

type ConflictReason = (typeof CONFLICT_REASONS)[number];

const conflict = (reason: ConflictReason, message: string): DomainError => new ConflictError({ message, details: { reason } });

@Injectable()
export class OwnershipTransferService {
  private readonly logger = new Logger(OwnershipTransferService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly auditChain: AuditChainService,
    private readonly membershipCache: MembershipCacheService,
    private readonly apiKeys: ApiKeysService,
    private readonly shareTokens: ShareTokensService,
    private readonly invitations: InvitationsService,
    private readonly sessions: SessionService,
    private readonly identity: IdentityService,
    private readonly invoices: BillingInvoicesService,
    private readonly queues: QueueProducer,
    @Inject(REALTIME_PUBLISHER) private readonly realtime: RealtimePublisher,
  ) {}

  // ---- initiate ------------------------------------------------------------------------------------------------

  /** POST /workspaces/{id}/transfer-ownership — owner only (RbacGuard: permission + step-up). */
  async initiate(workspaceId: string, actorId: string, recipientId: string, meta: AuditRequestMeta): Promise<TransferOwnershipResponse> {
    const { client } = this.store();
    const row = await this.lockAndLoad(client, workspaceId);
    await this.assertActorIsOwner(client, workspaceId, actorId);

    const now = new Date();
    const existing = parseTransfer(row.ownership_transfer);
    if (isPending(existing, now)) {
      incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "refused", reason: "transfer_already_pending" });
      throw conflict("transfer_already_pending", "an ownership transfer is already awaiting acceptance");
    }
    // A lapsed offer is simply replaced; its lapse is put on the record first, so it is never silently overwritten.
    if (isExpired(existing, now)) {
      await this.audit(client, workspaceId, SYSTEM_ACTOR_ID, "system", meta, "workspace.ownership_transfer_expired", existing, { state: "expired" }, "notice");
    }

    await this.assertPreflight(client, row, recipientId);

    const doc: TransferDocument = {
      state: "awaiting_acceptance",
      initiatedBy: actorId,
      recipientId,
      initiatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + OWNERSHIP_TRANSFER_TTL_MS).toISOString(),
    };
    await this.writeDocument(client, workspaceId, doc);
    incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "initiated" });
    this.logger.log(`ownership transfer initiated workspace_id=${workspaceId}`);
    return toResponse(workspaceId, doc);
  }

  // ---- accept (the execution) ----------------------------------------------------------------------------------

  /** POST …/accept — the named recipient only, with a fresh step-up. */
  async accept(workspaceId: string, actorId: string, lastStrongAuthAt: Date | null, meta: AuditRequestMeta): Promise<TransferOwnershipResponse> {
    const { client } = this.store();
    const { row, doc } = await this.beginAct(client, workspaceId, actorId, "recipient", meta);

    // Identity first, THEN step-up: a stranger learns "403", never "you would need to step up".
    assertStepUpFresh(lastStrongAuthAt);

    await this.assertPreflight(client, row, actorId);

    // The owner we are about to demote must still be the one who made the offer.
    const owner = await client.query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner' AND status = 'active'`,
      [workspaceId],
    );
    const oldOwnerId = owner.rows[0]?.user_id;
    if (owner.rows.length !== 1 || oldOwnerId !== doc.initiatedBy) {
      incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "refused", reason: "owner_changed" });
      throw conflict("transfer_not_pending", NOT_PENDING_MESSAGE);
    }

    // The swap. Demotion FIRST: ux_members_single_owner forbids two live owners, so the order is the contract.
    // Each statement asserts its row count — a member removed or demoted by a writer that does not take the
    // workspace lock makes this fail closed (and roll back everything below) instead of half-applying.
    const demoted = await client.query(
      `UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'`,
      [workspaceId, oldOwnerId],
    );
    if (demoted.rowCount !== 1) throw conflict("transfer_not_pending", NOT_PENDING_MESSAGE);
    let promoted;
    try {
      promoted = await client.query(
        `UPDATE workspace_members SET role = 'owner', project_scope = NULL
          WHERE workspace_id = $1 AND user_id = $2 AND role = 'admin' AND status = 'active'`,
        [workspaceId, actorId],
      );
    } catch (error) {
      // The pre-flight reads the recipient's other ownership; this is the same rule at the database, for the
      // founder-in-the-gap race. Surfaced as the same clean conflict, never a raw constraint violation.
      if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "ux_one_owned_workspace_per_user") {
        throw await this.limitReached(actorId);
      }
      throw error;
    }
    if (promoted.rowCount !== 1) throw conflict("recipient_not_admin", "the recipient is no longer an active admin of this workspace");
    this.membershipCache.invalidate(oldOwnerId, workspaceId);
    this.membershipCache.invalidate(actorId, workspaceId);

    // Everything the departed authority could still hold. API keys: ALL, unconditionally. Share tokens: every
    // passwordless one, no option. Invitations: pending owner/admin ones (the departing authority's own offers).
    const revokedKeys = await this.apiKeys.revokeAll();
    const revokedTokens = await this.shareTokens.revokePasswordless();
    const revokedInvitations = await this.invitations.revokePendingPrivileged(workspaceId);
    // Both users' sessions, in this transaction: no moment where roles have swapped and the old owner's session lives.
    const revokedSessions = await this.sessions.revokeAllForUsers(client, [oldOwnerId, actorId]);

    const now = new Date();
    const completed: TransferDocument = { ...doc, state: "completed", resolvedAt: now.toISOString(), completedAt: now.toISOString() };
    const version = await client.query<{ entitlement_version: number }>(
      // billing_email is where payment-failed and top-up mail goes, falling back to the live owner when NULL. One that
      // was the departed owner's own address is cleared, so billing mail follows the new owner; a deliberately
      // different address (finance@…) is the workspace's choice and is left alone.
      `UPDATE workspaces
          SET ownership_transfer = $2::jsonb,
              entitlement_version = entitlement_version + 1,
              billing_email = CASE WHEN billing_email = (SELECT email FROM users WHERE id = $3) THEN NULL ELSE billing_email END
        WHERE id = $1 RETURNING entitlement_version`,
      [workspaceId, JSON.stringify(completed), oldOwnerId],
    );

    await this.audit(
      client,
      workspaceId,
      actorId,
      "user",
      meta,
      "workspace.ownership_transferred",
      { owner_id: oldOwnerId, recipient_id: actorId, recipient_role: "admin" },
      {
        owner_id: actorId,
        previous_owner_id: oldOwnerId,
        previous_owner_role: "admin",
        entitlement_version: version.rows[0]?.entitlement_version ?? null,
        // Key names avoid "key"/"token": the audit writer redacts any value under a secret-shaped name, counts included.
        revoked: { keys_revoked: revokedKeys, links_revoked: revokedTokens, invitations: revokedInvitations, sessions: revokedSessions },
      },
      "critical",
    );

    // After the COMMIT and never before: a rolled-back swap must not move caches, tell clients, or call Stripe.
    afterCommit(() => {
      this.membershipCache.invalidate(oldOwnerId, workspaceId);
      this.membershipCache.invalidate(actorId, workspaceId);
      this.realtime.memberChanged(workspaceId, { workspace_id: workspaceId, user_id: oldOwnerId, role: "admin", status: "active" });
      this.realtime.memberChanged(workspaceId, { workspace_id: workspaceId, user_id: actorId, role: "owner", status: "active" });
      this.enqueueBillingEmailRepoint(workspaceId, actorId, completed.initiatedAt);
    });

    incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "completed" });
    this.logger.log(`ownership transferred workspace_id=${workspaceId}`);
    return toResponse(workspaceId, completed);
  }

  // ---- decline / cancel -----------------------------------------------------------------------------------------

  /** POST …/decline — the named recipient only. No step-up: refusing an offer needs no proof of presence. */
  async decline(workspaceId: string, actorId: string, meta: AuditRequestMeta): Promise<TransferOwnershipResponse> {
    const { client } = this.store();
    const { doc } = await this.beginAct(client, workspaceId, actorId, "recipient", meta);
    return this.resolve(client, workspaceId, doc, "declined");
  }

  /** POST …/cancel — the initiating owner only (RbacGuard: permission + step-up). */
  async cancel(workspaceId: string, actorId: string, meta: AuditRequestMeta): Promise<TransferOwnershipResponse> {
    const { client } = this.store();
    const { doc } = await this.beginAct(client, workspaceId, actorId, "initiator", meta);
    await this.assertActorIsOwner(client, workspaceId, actorId);
    return this.resolve(client, workspaceId, doc, "cancelled");
  }

  private async resolve(
    client: ClientBase,
    workspaceId: string,
    doc: TransferDocument,
    state: "declined" | "cancelled",
  ): Promise<TransferOwnershipResponse> {
    const resolved: TransferDocument = { ...doc, state, resolvedAt: new Date().toISOString() };
    await this.writeDocument(client, workspaceId, resolved);
    incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: state });
    return toResponse(workspaceId, resolved);
  }

  // ---- shared: who may act, and is there anything to act on ------------------------------------------------------

  /**
   * The gate for accept / decline / cancel. Returns the LOCKED, re-read document of a live transfer the actor is
   * entitled to act on, or throws.
   *
   * 1. An UNLOCKED peek first. A lapsed transfer is recorded as `expired` and the request is then refused — and the
   *    refusal throws, which rolls the ambient transaction back, taking the very write that recorded the lapse with
   *    it. So the lapse is committed OUT OF BAND (own connection, own transaction) while this request's transaction
   *    has taken no lock yet (an unlocked READ COMMITTED read holds none), which is also why it cannot deadlock.
   * 2. Then lock and re-read. Everything is decided on the locked row.
   *
   * Identity before state: a caller who is not the named party gets one 403 whether a transfer exists, is expired,
   * or never was — there is no oracle for who is being offered ownership.
   */
  private async beginAct(client: ClientBase, workspaceId: string, actorId: string, role: Role, meta: AuditRequestMeta): Promise<{ row: WorkspaceRow; doc: TransferDocument }> {
    const peeked = parseTransfer(await this.readDocument(client, workspaceId));
    if (peeked !== null && this.isParty(peeked, actorId, role) && isExpired(peeked, new Date())) {
      await this.commitLapse(workspaceId, actorId, meta);
      throw conflict("transfer_expired", "this ownership transfer expired; nothing was changed");
    }

    const row = await this.lockAndLoad(client, workspaceId);
    const doc = parseTransfer(row.ownership_transfer);

    if (role === "recipient") {
      if (doc === null || !this.isParty(doc, actorId, role)) {
        incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "refused", reason: "not_recipient" });
        throw new ForbiddenError({ message: "only the named recipient can act on this transfer", details: { required_permission: RECIPIENT_PERMISSION } });
      }
    } else if (doc !== null && !this.isParty(doc, actorId, role)) {
      incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "refused", reason: "not_initiator" });
      throw new PermissionDeniedException("workspace:transfer_ownership");
    }

    const now = new Date();
    if (isExpired(doc, now)) {
      // The deadline passed between the peek and the lock. Nothing is written here; the next request records it.
      throw conflict("transfer_expired", "this ownership transfer expired; nothing was changed");
    }
    if (doc === null || !isPending(doc, now)) {
      incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "refused", reason: "not_pending" });
      throw conflict("transfer_not_pending", NOT_PENDING_MESSAGE);
    }
    return { row, doc };
  }

  private isParty(doc: TransferDocument, actorId: string, role: Role): boolean {
    return role === "recipient" ? doc.recipientId === actorId : doc.initiatedBy === actorId;
  }

  /** Records `expired` on a lapsed pending transfer in its own transaction, so the record survives the refusal. */
  private async commitLapse(workspaceId: string, requestActorId: string, meta: AuditRequestMeta): Promise<void> {
    const client = await this.pool.connect();
    try {
      await withTenantContext(client, { workspaceId, actorId: requestActorId }, async (tx) => {
        await lockWorkspaceBounded(tx, workspaceId, busy);
        const raw = await this.readDocument(tx, workspaceId);
        const doc = parseTransfer(raw);
        // Re-decided under the lock: a concurrent accept/cancel may have resolved it already.
        if (doc === null || !isExpired(doc, new Date())) return;
        await this.writeDocument(tx, workspaceId, { ...doc, state: "expired", resolvedAt: new Date().toISOString() });
        await this.audit(tx, workspaceId, SYSTEM_ACTOR_ID, "system", meta, "workspace.ownership_transfer_expired", { state: doc.state }, { state: "expired", expires_at: expiresAtOf(doc).toISOString() }, "notice");
        incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "expired" });
      });
    } finally {
      client.release();
    }
  }

  // ---- the EC-15 pre-flight, run at initiation AND again at acceptance --------------------------------------------

  private async assertPreflight(client: ClientBase, row: WorkspaceRow, recipientId: string): Promise<void> {
    const workspaceId = row.id;
    const refuse = (reason: ConflictReason, message: string): never => {
      incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "refused", reason });
      throw conflict(reason, message);
    };

    if (row.status === "pending_deletion" || row.deletion_requested_at !== null || row.deletion_execute_at !== null || row.deleted_at !== null) {
      refuse("workspace_pending_deletion", "a workspace with a pending deletion cannot change owner");
    }

    // One refusal for a stranger, a non-member, a manager, a removed or suspended admin and the owner themself:
    // the answer must not tell the asker who is a member.
    const membership = await client.query<{ role: string; status: string }>(
      `SELECT role, status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, recipientId],
    );
    const member = membership.rows[0];
    if (member === undefined || member.role !== "admin" || member.status !== "active") {
      refuse("recipient_not_admin", "the recipient must be an active admin of this workspace");
    }

    const user = await client.query<{ status: string; email_verified_at: Date | null; deleted_at: Date | null }>(
      `SELECT status, email_verified_at, deleted_at FROM users WHERE id = $1`,
      [recipientId],
    );
    const account = user.rows[0];
    if (account === undefined || account.deleted_at !== null || (account.status !== "active" && account.status !== "unverified")) {
      refuse("recipient_not_admin", "the recipient must be an active admin of this workspace");
    } else if (account.status === "unverified" || account.email_verified_at === null) {
      refuse("recipient_email_unverified", "the recipient's email address is not verified");
    }

    if (!(await this.identity.hasStrongAuthenticator(client, recipientId))) {
      refuse("recipient_no_strong_authenticator", "the recipient needs a passkey enrolled; an email code alone does not qualify");
    }

    // "Recipient owns nothing else" — up front, as a 409 naming the workspace, not as a raw constraint violation
    // after the outgoing owner has already made decisions.
    const owned = await this.findOwnedWorkspace(recipientId);
    if (owned !== null) {
      incrementCounter("nominara_workspace_ownership_transfers_total", { outcome: "refused", reason: "workspace_limit_reached" });
      throw new WorkspaceLimitReachedError({
        message: "the recipient already owns a workspace",
        details: { owned_workspace_id: owned.id, owned_workspace_name: owned.name },
      });
    }

    if (await this.invoices.hasPastDue(client)) {
      refuse("past_due_invoice", "settle the past-due invoice before changing the workspace owner");
    }
  }

  /**
   * The recipient's own workspace, if any. `workspace_members` is RLS-scoped to the request's workspace, so the
   * recipient's rows elsewhere are invisible from this transaction; the ADR-0001 actor-self read (READ ONLY, workspace
   * GUC cleared) is the only sanctioned way to see them, and it is run AS the recipient. That is a widening of
   * ADR-0001's "self" reads to a second person's id — read-only and returning one id and one name — flagged for review
   * in the STORY-021 report.
   */
  private async findOwnedWorkspace(userId: string): Promise<{ id: string; name: string } | null> {
    const client = await this.pool.connect();
    try {
      return await withActorContext(client, { actorId: userId }, async (tx) => {
        const result = await tx.query<{ id: string; name: string }>(
          `SELECT w.id, w.name FROM workspaces w
             JOIN workspace_members m ON m.workspace_id = w.id
            WHERE m.user_id = $1 AND m.role = 'owner' AND m.status = 'active'`,
          [userId],
        );
        return result.rows[0] ?? null;
      });
    } finally {
      client.release();
    }
  }

  private async limitReached(userId: string): Promise<Error> {
    const owned = await this.findOwnedWorkspace(userId);
    if (owned === null) return conflict("recipient_not_admin", "the recipient can no longer be promoted");
    return new WorkspaceLimitReachedError({
      message: "the recipient already owns a workspace",
      details: { owned_workspace_id: owned.id, owned_workspace_name: owned.name },
    });
  }

  // ---- small shared pieces -----------------------------------------------------------------------------------------

  private store(): { client: ClientBase } {
    const store = currentTenantStore();
    if (store === undefined) throw new Error("OwnershipTransferService requires an active tenant context");
    return { client: store.client };
  }

  private async lockAndLoad(client: ClientBase, workspaceId: string): Promise<WorkspaceRow> {
    await lockWorkspaceBounded(client, workspaceId, busy);
    const result = await client.query<WorkspaceRow>(
      `SELECT id, status, deletion_requested_at, deletion_execute_at, deleted_at, ownership_transfer FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    const row = result.rows[0];
    // RLS hides every other workspace: a foreign id is indistinguishable from an absent one.
    if (row === undefined) throw new ForbiddenError({ message: "no such workspace in this tenant", details: { required_permission: "workspace:transfer_ownership" } });
    return row;
  }

  private async readDocument(client: ClientBase, workspaceId: string): Promise<unknown> {
    const result = await client.query<{ ownership_transfer: unknown }>(`SELECT ownership_transfer FROM workspaces WHERE id = $1`, [workspaceId]);
    return result.rows[0]?.ownership_transfer ?? null;
  }

  private async writeDocument(client: ClientBase, workspaceId: string, doc: TransferDocument): Promise<void> {
    await client.query(`UPDATE workspaces SET ownership_transfer = $2::jsonb WHERE id = $1`, [workspaceId, JSON.stringify(doc)]);
  }

  /** The guard's membership comes from a per-process cache (≤30 s); this is the live row, under the lock. */
  private async assertActorIsOwner(client: ClientBase, workspaceId: string, actorId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM workspace_members WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner' AND status = 'active'`,
      [workspaceId, actorId],
    );
    if (result.rowCount !== 1) throw new PermissionDeniedException("workspace:transfer_ownership");
  }

  private async audit(
    client: ClientBase,
    workspaceId: string,
    actorId: string,
    actorType: "user" | "system",
    meta: AuditRequestMeta,
    action: string,
    beforeState: unknown,
    afterState: unknown,
    severity: "notice" | "critical",
  ): Promise<void> {
    await this.auditChain.append(client, {
      workspaceId,
      actorType,
      actorId,
      actorIp: actorType === "user" ? meta.ip : null,
      actorUa: actorType === "user" ? meta.ua : null,
      action,
      resourceType: "workspace",
      resourceId: workspaceId,
      beforeState,
      afterState,
      requestId: meta.requestId,
      supportGrantId: null,
      severity,
    });
  }

  /**
   * KAD-06: no Stripe call on a request path. After commit, one signed tenant job re-points the Stripe customer's billing
   * email to the NEW OWNER. The payload carries ids only (no address); the worker reads the live owner and customer.
   * A failure to enqueue is logged and counted, never raised — the transfer is committed and the customer is the same.
   */
  private enqueueBillingEmailRepoint(workspaceId: string, ownerUserId: string, initiatedAt: string): void {
    void this.queues
      .enqueueTenantJob("billing.customer_email", workspaceId, { ownerUserId }, {
        idempotencyKey: buildIdempotencyKey("billing.customer_email", { workspace: workspaceId, owner: ownerUserId, transfer: String(Date.parse(initiatedAt)) }),
      })
      .catch((error: unknown) => {
        incrementCounter("nominara_workspace_ownership_transfer_followup_failed_total", { step: "billing_email" });
        this.logger.error(`failed to enqueue billing email re-point workspace_id=${workspaceId}: ${error instanceof Error ? error.name : "unknown"}`);
      });
  }
}

const busy = (): Error => {
  incrementCounter("nominara_workspace_lock_wait_exceeded_total", { path: "ownership_transfer" });
  return new DegradedError({ message: "the workspace is being changed: retry shortly" });
};

function toResponse(workspaceId: string, doc: TransferDocument): TransferOwnershipResponse {
  return {
    workspace_id: workspaceId,
    state: doc.state as TransferOwnershipResponse["state"],
    initiated_by: doc.initiatedBy,
    recipient_id: doc.recipientId,
    initiated_at: doc.initiatedAt,
    expires_at: expiresAtOf(doc).toISOString(),
    resolved_at: doc.resolvedAt ?? null,
  };
}
