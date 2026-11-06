import type { ClientBase } from "pg";
import { incrementCounter } from "../telemetry/metrics.js";
import { appendComplianceAudit } from "./compliance-audit.js";

// STORY-111 / NFR-CMP-10 / data-model.md section 7 "Legal hold".
//
// The ONLY exemption from any purge. Two distinct people authorise it, it carries a stated reason and an expiry, and placing and
// releasing it are audited. The purge job skips a held subject AND REPORTS it (retention.ts `held`), so a hold can never be mistaken for a
// purge that ran. An expired hold needs no one to release it: `active` is a predicate on `expires_at`, so the subject returns to its normal
// schedule the instant the hold lapses; `releaseExpiredHolds` only RECORDS that (and audits it).
//
// Owner connection only (the tables are granted to no runtime role). Every function takes `now` so the clock is a parameter, not a guess.

export class LegalHoldError extends Error {
  constructor(
    readonly code: "same_person" | "reason_too_short" | "expiry_not_in_future" | "unknown_subject" | "unknown_person" | "not_active",
    message: string,
  ) {
    super(message);
    this.name = "LegalHoldError";
  }
}

export interface PlaceLegalHoldInput {
  readonly scope: "project" | "workspace";
  readonly scopeId: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly expiresAt: Date;
  readonly now?: Date;
}

export const MIN_HOLD_REASON_CHARS = 10;

export async function placeLegalHold(client: ClientBase, input: PlaceLegalHoldInput): Promise<{ id: string; workspaceId: string }> {
  const now = input.now ?? new Date();
  if (input.requestedBy === input.approvedBy) throw new LegalHoldError("same_person", "a legal hold needs two different people: requester and approver are the same");
  if (input.reason.trim().length < MIN_HOLD_REASON_CHARS) throw new LegalHoldError("reason_too_short", `a legal hold needs a stated reason of at least ${String(MIN_HOLD_REASON_CHARS)} characters`);
  if (input.expiresAt.getTime() <= now.getTime()) throw new LegalHoldError("expiry_not_in_future", "a legal hold needs an expiry in the future");

  const people = await client.query<{ id: string }>("SELECT id FROM users WHERE id = ANY($1::uuid[])", [[input.requestedBy, input.approvedBy]]);
  if (people.rowCount !== 2) throw new LegalHoldError("unknown_person", "requester and approver must both be existing users");

  const workspaceId = await resolveWorkspace(client, input.scope, input.scopeId);
  if (workspaceId === null) throw new LegalHoldError("unknown_subject", `no such ${input.scope}`);

  await client.query("BEGIN");
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO legal_holds (scope, scope_id, workspace_id, reason, requested_by, approved_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.scope, input.scopeId, workspaceId, input.reason.trim(), input.requestedBy, input.approvedBy, now.toISOString(), input.expiresAt.toISOString()],
    );
    const id = inserted.rows[0]!.id;
    await appendComplianceAudit(client, {
      workspaceId,
      actorType: "user",
      actorId: input.requestedBy,
      action: "legal_hold.placed",
      resourceType: "legal_hold",
      resourceId: id,
      // The reason is operator-written text about a legal matter: it stays in legal_holds, not in the audit chain.
      afterState: { scope: input.scope, scope_id: input.scopeId, approved_by: input.approvedBy, expires_at: input.expiresAt.toISOString() },
      severity: "critical",
    });
    await client.query("COMMIT");
    incrementCounter("nominara_retention_legal_holds_placed_total", { scope: input.scope });
    return { id, workspaceId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function resolveWorkspace(client: ClientBase, scope: "project" | "workspace", scopeId: string): Promise<string | null> {
  const row =
    scope === "workspace"
      ? await client.query<{ w: string }>("SELECT id AS w FROM workspaces WHERE id = $1", [scopeId])
      : await client.query<{ w: string }>("SELECT workspace_id AS w FROM projects WHERE id = $1", [scopeId]);
  return row.rows[0]?.w ?? null;
}

/** Ends a hold before its expiry. Audited. */
export async function releaseLegalHold(client: ClientBase, holdId: string, releasedBy: string, now: Date = new Date()): Promise<void> {
  await client.query("BEGIN");
  try {
    const released = await client.query<{ workspace_id: string }>(
      `UPDATE legal_holds SET released_at = $2, release_reason = 'manual'
        WHERE id = $1 AND released_at IS NULL AND expires_at > $2 RETURNING workspace_id`,
      [holdId, now.toISOString()],
    );
    const row = released.rows[0];
    if (row === undefined) throw new LegalHoldError("not_active", "no such active legal hold");
    await appendComplianceAudit(client, {
      workspaceId: row.workspace_id,
      actorType: "user",
      actorId: releasedBy,
      action: "legal_hold.released",
      resourceType: "legal_hold",
      resourceId: holdId,
      afterState: { release_reason: "manual" },
      severity: "critical",
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Records the release of every lapsed hold (idempotent: a recorded hold is not touched again). Returns how many were recorded. */
export async function releaseExpiredHolds(client: ClientBase, now: Date = new Date()): Promise<number> {
  await client.query("BEGIN");
  try {
    const lapsed = await client.query<{ id: string; workspace_id: string }>(
      `UPDATE legal_holds SET released_at = expires_at, release_reason = 'expired'
        WHERE released_at IS NULL AND expires_at <= $1 RETURNING id, workspace_id`,
      [now.toISOString()],
    );
    for (const hold of lapsed.rows) {
      await appendComplianceAudit(client, {
        workspaceId: hold.workspace_id,
        actorType: "system",
        actorId: null,
        action: "legal_hold.expired",
        resourceType: "legal_hold",
        resourceId: hold.id,
        afterState: { release_reason: "expired" },
        severity: "notice",
      });
    }
    await client.query("COMMIT");
    if (lapsed.rowCount !== null && lapsed.rowCount > 0) incrementCounter("nominara_retention_legal_holds_expired_total");
    return lapsed.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export interface ActiveHolds {
  readonly workspaces: ReadonlySet<string>;
  readonly projects: ReadonlySet<string>;
  /** workspace id -> true when the workspace has a held PROJECT (a workspace delete would remove it). */
  readonly workspacesWithHeldProject: ReadonlySet<string>;
}

/** Every hold active at `now`: unreleased and not yet expired. */
export async function activeHolds(client: ClientBase, now: Date): Promise<ActiveHolds> {
  const rows = await client.query<{ scope: string; scope_id: string; workspace_id: string }>(
    "SELECT scope, scope_id, workspace_id FROM legal_holds WHERE released_at IS NULL AND expires_at > $1",
    [now.toISOString()],
  );
  const workspaces = new Set<string>();
  const projects = new Set<string>();
  const withProject = new Set<string>();
  for (const row of rows.rows) {
    if (row.scope === "workspace") workspaces.add(row.scope_id);
    else {
      projects.add(row.scope_id);
      withProject.add(row.workspace_id);
    }
  }
  return { workspaces, projects, workspacesWithHeldProject: withProject };
}
