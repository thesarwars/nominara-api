import { randomUUID } from "node:crypto";
import { cancelTaskVerifications } from "../../lib/impact/verification-schedule.js";
import { Logger } from "@nestjs/common";
import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import type { PurgeFailureDetail } from "../../../contracts/ops/purge-failure-detail.schema.js";
import { connect, requireDatabaseUrl } from "../../db/client.js";
import { WorkspaceLockBusyError } from "../../lib/billing/errors.js";
import { lockWorkspaceBounded } from "../../lib/billing/workspace-lock.js";
import { RECHAINED_MARKER_ACTION } from "../../lib/crypto/audit-chain.js";
import { settleFinishedRunCredits } from "../../lib/credits/run-settlement.js";
import { pseudonymiseWorkspaceId } from "../../lib/crypto/pseudonymise.js";
import { activeHolds, releaseExpiredHolds } from "../../lib/compliance/legal-hold.js";
import type { PurgeJournal } from "../../lib/compliance/purge-journal.js";
import { incrementCounter, observeValue } from "../../lib/telemetry/metrics.js";
import { AuditChainService } from "../../modules/audit/audit-chain.service.js";
import { appendMark, appendTombstone, findBrokenMark, readChainHead } from "../../modules/audit/audit-chain-marks.js";
import { SYSTEM_ACTOR_ID } from "../../tenancy/constants.js";
import { withTenantContext } from "../../tenancy/tenant-context.js";

const auditChain = new AuditChainService();
const logger = new Logger("retention.sweep");

// STORY-013 — data-model.md §7 "Retention, erasure and the deletion
// cascade". The nightly retention cascade + orphan scan. Same "plain,
// exported, dependency-free TS function" surface as maintenance.ts — see
// that file's header comment for the full rationale.
//
// PRIVILEGE CONTRACT (corrected, second-engineer review — the previous
// wording was wrong for exactly two functions, see below):
//
// - Genuinely workspace/project-SCOPED functions that open (or are called
//   within) their own `withTenantContext` transaction and issue only
//   ordinary DML — `softDeleteProject`, `hardDeleteProject`,
//   `requestWorkspaceDeletion`, `expireRawCaptures`, `expireRollups`,
//   `expireDerivedAnalyses`, `expireAttributionDaily`,
//   `expireToolSnapshotsForWorkspace`, `tryPurgeProject`, `withExportLock` —
//   ARE safe on the ordinary `nominara_worker` runtime role: `nominara_worker`
//   holds SELECT/INSERT/UPDATE/DELETE on every tenant table (migration 0005)
//   and RLS enforces the single workspace named by the context that was set.
//   Proven, not just claimed: test/integration/retention-cascade.spec.ts
//   connects as `nominara_worker` (via `connectAsRole`) for every one of
//   these.
//
// - Functions that DISCOVER targets ACROSS every workspace with NO tenant
//   context set — `runNightlySweep`, `runDailyPurgeCycle`,
//   `scanForOrphans`/`runOrphanScan`, `resolveWorkspaceRetention`,
//   `collectComplianceExport`, `workspaceProjectsWithOpenExports` — issue a
//   cross-tenant SELECT against tables
//   that carry FORCE ROW LEVEL SECURITY (migration 0006). Under
//   `nominara_worker` (no BYPASSRLS, not the table owner), a query with no
//   `app.current_workspace_id` set is filtered to ZERO rows by the
//   `ws_isolation_*` policies — not merely "unsafe", genuinely unable to see
//   anything, so the sweep would silently do nothing every night. This needs
//   the SAME privileged-connection contract `pnpm db:rls-check`/
//   `db:rls-generate` and every migration already run under (README.md gap
//   G-4). Proven, not just claimed: retention-cascade.spec.ts includes an
//   explicit test connecting as `nominara_worker` with no context set and
//   asserting it sees zero workspaces/fact rows where the superuser
//   connection sees real ones.
//
// - `executeWorkspaceHardDelete`/`requestIndividualErasure` ALSO need a
//   privileged connection, for a THIRD, DIFFERENT reason that has nothing to
//   do with RLS filtering: both issue `ALTER TABLE ... DISABLE/ENABLE
//   TRIGGER` on `audit_log`/`credit_ledger`, which requires TABLE OWNERSHIP
//   — `nominara_worker`'s GRANTs (even APPEND_ONLY on audit_log) never confer
//   that, no matter what tenant context is set. (The previous version of this
//   comment incorrectly lumped these two into the first, "safe on
//   nominara_worker" bucket, because they ARE single-workspace/single-user
//   scoped — that part was true, but irrelevant to why they need privilege.)
//   Proven, not just claimed: retention-cascade.spec.ts includes an explicit
//   test connecting as `nominara_worker` and asserting the `ALTER TABLE ...
//   DISABLE TRIGGER` step fails with a permission error.

// ---------------------------------------------------------------------------
// Retention-window resolution — plans.entitlements->'retention.*_days'->'value'.
// `null` and the literal string "unlimited" both mean "never purge" (this
// story's own instruction); a numeric value is a day count.
// ---------------------------------------------------------------------------

export type RetentionWindow = number | "unlimited" | null;

export function resolveRetentionCutoff(window: RetentionWindow, referenceDate: Date): Date | null {
  if (window === null || window === "unlimited") {
    return null;
  }
  return new Date(referenceDate.getTime() - window * 86_400_000);
}

export interface WorkspaceRetention {
  /** The raw-capture window IN FORCE at the reference date: while a deferral is running, the longer of the plan's and the replaced plan's. */
  readonly rawCapturesDays: RetentionWindow;
  /** The rollup window IN FORCE at the reference date (same rule). */
  readonly rollupsDays: RetentionWindow;
  /**
   * STORY-077 slice B (EC-41): a plan change that shortens retention sets this to day 15 (lib/billing/retention-shortening.ts).
   * Until then the workspace keeps the window it is moving AWAY from (`retention_deferred_*_days`), on the sweep and on the read
   * paths alike, so the deferral never makes data readable that the old plan already hid, nor stops the old window's expiry.
   * `null` is no deferral. It can only lengthen a window; nothing reads it to purge more.
   */
  readonly purgeNotBefore: Date | null;
}

/**
 * True while the workspace's retention purge is deferred: until `referenceDate` is STRICTLY after `purgeNotBefore`. At the
 * instant itself it is still deferred, the side that keeps data (the first purge is day 15, never the moment day 15 begins).
 */
export function retentionPurgeDeferred(retention: WorkspaceRetention, referenceDate: Date): boolean {
  return retention.purgeNotBefore !== null && retention.purgeNotBefore.getTime() >= referenceDate.getTime();
}

/** The longer of two windows; `null` and "unlimited" (never purged) are the longest. The result is a day count or `null`. */
export function longerRetentionWindow(a: RetentionWindow, b: RetentionWindow): number | null {
  if (typeof a !== "number" || typeof b !== "number") return null;
  return Math.max(a, b);
}

export async function resolveWorkspaceRetention(client: ClientBase, workspaceId: string, referenceDate: Date = new Date()): Promise<WorkspaceRetention> {
  const result = await client.query<{
    raw: unknown;
    rollups: unknown;
    purge_not_before: Date | null;
    deferred_raw: number | null;
    deferred_rollups: number | null;
  }>(
    // ->'value' because STORY-069 wrapped every entitlement as
    // {value, live}. Reading the key directly now yields the whole object,
    // which resolveRetentionWindow would see as neither a number nor null.
    `SELECT p.entitlements->'retention.raw_captures_days'->'value' AS raw,
            p.entitlements->'retention.rollups_days'->'value'       AS rollups,
            w.retention_purge_not_before                            AS purge_not_before,
            w.retention_deferred_raw_days                           AS deferred_raw,
            w.retention_deferred_rollups_days                       AS deferred_rollups
       FROM workspaces w
       JOIN plans p ON p.key = w.plan_key
      WHERE w.id = $1`,
    [workspaceId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`resolveWorkspaceRetention: workspace ${workspaceId} not found`);
  }
  const planRaw = row.raw as RetentionWindow;
  const planRollups = row.rollups as RetentionWindow;
  const deferred = row.purge_not_before !== null && row.purge_not_before.getTime() >= referenceDate.getTime();
  // A NULL deferred window is "never purged", so a deferral recorded without windows keeps everything: the side that retains.
  return {
    rawCapturesDays: deferred ? longerRetentionWindow(planRaw, row.deferred_raw) : planRaw,
    rollupsDays: deferred ? longerRetentionWindow(planRollups, row.deferred_rollups) : planRollups,
    purgeNotBefore: row.purge_not_before,
  };
}

// ---------------------------------------------------------------------------
// Project soft delete — data-model.md §7 "immediate": deleted_at set, prompts
// paused, scheduled runs cancelled, data retained.
// ---------------------------------------------------------------------------

export async function softDeleteProject(
  client: ClientBase,
  workspaceId: string,
  projectId: string,
  actorId: string = SYSTEM_ACTOR_ID,
): Promise<void> {
  await withTenantContext(client, { workspaceId, actorId }, async (tx) => {
    await tx.query("UPDATE projects SET deleted_at = now(), next_run_at = NULL WHERE id = $1 AND deleted_at IS NULL", [
      projectId,
    ]);
    await tx.query("UPDATE tracked_prompts SET status = 'paused' WHERE project_id = $1 AND status = 'active'", [projectId]);
    await tx.query("UPDATE capture_runs SET status = 'canceled' WHERE project_id = $1 AND status = 'queued'", [projectId]);
    // STORY-067 AC10 - a deleted project is not re-measured: its pending verifications are cancelled, not orphaned.
    await cancelTaskVerifications(tx, { projectId }, "project_deleted");
  });
}

// ---------------------------------------------------------------------------
// Project hard delete (≤24h after soft delete + 30d grace, or on request) —
// data-model.md §7. Everything EXCEPT the three partitioned fact tables
// cascades automatically via `project_id REFERENCES projects(id) ON DELETE
// CASCADE` (rollups, milestones, tasks, AUX rows, alignment sessions, chunks,
// passages, semantic nodes, patches, source index all carry that FK already
// — see this story's Implementation Decisions). This function therefore
// orchestrates ONLY the no-FK fact-table deletes and the S3-prefix delete,
// per this story's own Technical Notes.
// ---------------------------------------------------------------------------

export interface HardDeleteProjectOptions {
  readonly actorId?: string;
  /** `{env}/{workspace_id}/...` — security-and-tenancy.md §10 ISO-14's object-key namespacing convention. Defaults to `process.env.NOMINARA_ENV ?? "local"`. */
  readonly env?: string;
  readonly deleteObjectPrefix?: (prefix: string) => Promise<void>;
}

export async function hardDeleteProject(
  client: ClientBase,
  workspaceId: string,
  projectId: string,
  options: HardDeleteProjectOptions = {},
): Promise<void> {
  await withTenantContext(client, { workspaceId, actorId: options.actorId ?? SYSTEM_ACTOR_ID }, async (tx) => {
    await tx.query("DELETE FROM citation_facts WHERE project_id = $1", [projectId]);
    await tx.query("DELETE FROM mention_facts WHERE project_id = $1", [projectId]);
    await tx.query("DELETE FROM answer_captures WHERE project_id = $1", [projectId]);
    await tx.query("DELETE FROM projects WHERE id = $1", [projectId]);
  });

  if (!options.deleteObjectPrefix) {
    throw new Error(
      "hardDeleteProject: no deleteObjectPrefix callback supplied — no object-storage client exists in this repo yet (disclosed gap, see README.md)",
    );
  }
  const env = options.env ?? process.env.NOMINARA_ENV ?? "local";
  await options.deleteObjectPrefix(`${env}/${workspaceId}/projects/${projectId}/`);
}

// ---------------------------------------------------------------------------
// Workspace deletion request — immediate lock, 30-day grace.
// ---------------------------------------------------------------------------

export const WORKSPACE_DELETION_GRACE_DAYS = 30;

export async function requestWorkspaceDeletion(
  client: ClientBase,
  workspaceId: string,
  referenceDate: Date = new Date(),
): Promise<void> {
  const executeAt = new Date(referenceDate.getTime() + WORKSPACE_DELETION_GRACE_DAYS * 86_400_000);
  await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    // Checkpoint-6 — bounded: a billing change may hold this row across a Stripe call.
    await lockWorkspaceBounded(tx, workspaceId, () => new WorkspaceLockBusyError(workspaceId));
    await tx.query(
      `UPDATE workspaces
          SET status = 'pending_deletion', deletion_requested_at = $2, deletion_execute_at = $3
        WHERE id = $1`,
      [workspaceId, referenceDate.toISOString(), executeAt.toISOString()],
    );
    await tx.query("UPDATE share_tokens SET revoked_at = now() WHERE workspace_id = $1 AND revoked_at IS NULL", [workspaceId]);
    await tx.query("UPDATE custom_domains SET status = 'disabled' WHERE workspace_id = $1 AND status <> 'disabled'", [
      workspaceId,
    ]);
  });
}

// ---------------------------------------------------------------------------
// Workspace hard delete (at deletion_execute_at) — export the two surviving
// record sets FIRST, then the cascade. Requires a PRIVILEGED (table-owner)
// connection: `audit_log`/`credit_ledger` both carry the append-only
// `reject_update_delete` trigger (migration 0002/0004), which blocks the
// `ON DELETE CASCADE` from `workspaces` from ever completing (STORY-007's
// own "KNOWN OPEN CONSTRAINT" — see 0002_identity_tenancy_billing.up.sql).
// This is that constraint's resolution: the trigger is disabled for the
// span of this one controlled, export-then-purge operation, and
// unconditionally re-enabled afterward (even on failure).
// ---------------------------------------------------------------------------

export interface ComplianceExportRow {
  readonly table: "audit_log" | "credit_ledger";
  readonly rows: readonly Record<string, unknown>[];
}

export async function collectComplianceExport(client: ClientBase, workspaceId: string): Promise<ComplianceExportRow[]> {
  const auditLog = await client.query("SELECT * FROM audit_log WHERE workspace_id = $1 ORDER BY seq", [workspaceId]);
  const creditLedger = await client.query("SELECT * FROM credit_ledger WHERE workspace_id = $1 ORDER BY occurred_at", [
    workspaceId,
  ]);
  return [
    { table: "audit_log", rows: auditLog.rows },
    { table: "credit_ledger", rows: creditLedger.rows },
  ];
}

export interface ExecuteWorkspaceHardDeleteOptions {
  readonly exportComplianceRecords: (records: readonly ComplianceExportRow[]) => Promise<void>;
  /**
   * STORY-180 r5. Deletes the workspace's stored report files (every version). Runs AFTER the cascade has COMMITTED and never inside
   * it (ADR-0003: no storage I/O in a transaction); not called if the export or the cascade failed (the workspace still exists).
   * Its failure is a `WorkspaceObjectsLeftBehindError`: the workspace IS erased, its objects are not.
   */
  readonly deleteWorkspaceObjects?: (workspaceId: string) => Promise<void>;
}

/** The cascade committed but the workspace's stored objects could not be deleted. The row is gone, so no later run rediscovers them: an operator must. */
export class WorkspaceObjectsLeftBehindError extends Error {
  constructor(
    readonly workspaceId: string,
    cause: unknown,
  ) {
    super(`workspace ${workspaceId} was erased but its stored objects could not be deleted`, { cause });
    this.name = "WorkspaceObjectsLeftBehindError";
  }
}

/**
 * STORY-111 "no purge path leaves customer content behind": every base table with a `workspace_id` column that `DELETE FROM workspaces`
 * does NOT reach through a chain of ON DELETE CASCADE foreign keys. They are discovered from the catalog, not listed, so a table added
 * later without a cascade is purged anyway instead of becoming an archive of a tenant that was erased. At the time of writing: the three
 * partitioned fact tables (answer_captures, mention_facts, citation_facts - no foreign key by design), notifications, report_artifacts
 * and source_domains; the first four deleted nothing before this and left the rows behind.
 *
 * `audit_log` (exported, then deleted explicitly), `legal_holds` (deleted explicitly) and `audit_chain_marks` (the tombstone that records the
 * deletion, STORY-143: identifiers only) are not in the result; they have their own handling.
 */
export async function workspaceTablesWithoutCascade(client: ClientBase): Promise<string[]> {
  const rows = await client.query<{ relname: string }>(
    `WITH RECURSIVE reach(oid) AS (
       SELECT k.conrelid FROM pg_constraint k WHERE k.contype = 'f' AND k.confdeltype = 'c' AND k.confrelid = 'public.workspaces'::regclass
       UNION
       SELECT k.conrelid FROM pg_constraint k JOIN reach r ON k.confrelid = r.oid WHERE k.contype = 'f' AND k.confdeltype = 'c'
     )
     SELECT c.relname
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND c.oid NOT IN (SELECT oid FROM reach)
        AND c.relname NOT IN ('audit_log', 'audit_chain_marks', 'legal_holds')
      ORDER BY c.relname`,
  );
  return rows.rows.map((r) => r.relname);
}

/**
 * The deletion cascade itself, with NO export before it: `executeWorkspaceHardDelete` exports first and then calls this, and a restore
 * re-applying a journalled purge (restore-replay.ts) calls it directly, because that purge was exported when it first ran.
 * Idempotent: deleting an already-absent workspace deletes nothing.
 */
export async function cascadeDeleteWorkspace(privilegedClient: ClientBase, workspaceId: string): Promise<void> {
  // Blocking (code review): ENABLE TRIGGER used to run in a `finally` block
  // AFTER COMMIT — as new, separately autocommitted statements. Once COMMIT
  // ran, the disabled-trigger state was durable and visible to every OTHER
  // session for the entire window until those ENABLE calls completed (a
  // concurrent session could UPDATE/DELETE ANY workspace's audit_log/
  // credit_ledger with no append-only guard), and a crash between COMMIT and
  // ENABLE left the trigger permanently disabled with no recovery path.
  // `ALTER TABLE ... DISABLE/ENABLE TRIGGER` is itself transactional DDL, so
  // moving ENABLE TRIGGER to run INSIDE this transaction, before COMMIT,
  // closes both problems: on the success path the trigger is re-enabled
  // before anyone else can observe the disabled state, and on any failure
  // the ROLLBACK undoes the DISABLE automatically — no separate re-enable
  // step is needed or run on that path.
  await privilegedClient.query("BEGIN");
  try {
    // STORY-143 AC7 — a tombstone, in the SAME transaction as the delete, so
    // the verifier either sees the chain and no tombstone, or neither. Without
    // it the vanished chain is indistinguishable from a deleted one and the
    // next verifier run pages on a deletion that was the intended outcome.
    await appendTombstone(privilegedClient, workspaceId);
    await privilegedClient.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await privilegedClient.query("ALTER TABLE credit_ledger DISABLE TRIGGER reject_update_delete");
    // audit_log carries NO foreign key from workspaces (deliberately — see
    // 0004's schema comment), unlike credit_ledger's `ON DELETE CASCADE`, so
    // it survives `DELETE FROM workspaces` untouched unless deleted here
    // explicitly (STORY-020 D-6).
    await privilegedClient.query("DELETE FROM audit_log WHERE workspace_id = $1", [workspaceId]);
    // STORY-111: the tables no foreign key cascades into (the fact tables among them). Identifiers come from the catalog and are quoted.
    for (const table of await workspaceTablesWithoutCascade(privilegedClient)) {
      await privilegedClient.query(`DELETE FROM "${table.replaceAll('"', '""')}" WHERE workspace_id = $1`, [workspaceId]);
    }
    await privilegedClient.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    // STORY-111: "exactly three record sets survive". A released or lapsed legal hold names this workspace and states a reason about a legal
    // matter; its audit rows are in the audit export, so the register row is deleted with the tenant. (An ACTIVE hold never reaches here.)
    await privilegedClient.query("DELETE FROM legal_holds WHERE workspace_id = $1", [workspaceId]);
    await privilegedClient.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");
    await privilegedClient.query("ALTER TABLE credit_ledger ENABLE TRIGGER reject_update_delete");
    await privilegedClient.query("COMMIT");
  } catch (error) {
    await privilegedClient.query("ROLLBACK");
    throw error;
  }
}

export async function executeWorkspaceHardDelete(
  privilegedClient: ClientBase,
  workspaceId: string,
  options: ExecuteWorkspaceHardDeleteOptions,
): Promise<void> {
  const exportData = await collectComplianceExport(privilegedClient, workspaceId);
  // STORY-020 AC "rows are retained only in the immutable export, with the
  // workspace identifier pseudonymised" — the export copy's audit_log rows
  // carry the pseudonym; credit_ledger is untouched (out of this story's
  // scope, its own STORY-013 export behavior is unchanged).
  const pseudonymisedExportData: ComplianceExportRow[] = exportData.map((record) =>
    record.table === "audit_log"
      ? { ...record, rows: record.rows.map((row) => ({ ...row, workspace_id: pseudonymiseWorkspaceId(workspaceId) })) }
      : record,
  );
  // Export precedes the cascade — data-model.md §7: "The cascade would
  // otherwise delete them, which is why the export precedes it rather than
  // following it."
  await options.exportComplianceRecords(pseudonymisedExportData);

  await cascadeDeleteWorkspace(privilegedClient, workspaceId);
  // AFTER the commit, with no transaction open: the objects of an erased workspace.
  if (options.deleteWorkspaceObjects !== undefined) {
    try {
      await options.deleteWorkspaceObjects(workspaceId);
    } catch (error) {
      throw new WorkspaceObjectsLeftBehindError(workspaceId, error);
    }
  }
}

// ---------------------------------------------------------------------------
// Individual erasure request — anonymise `users`, reassign authored
// task_events/milestones to SYSTEM_ACTOR_ID, pseudonymise audit_log/
// credit_ledger actor ids. Blocked outright if the requester is the sole
// active owner of any workspace (ux_members_single_owner).
// ---------------------------------------------------------------------------

export const SOLE_OWNER_ERASURE_BLOCK_REASON =
  "You are the sole owner of at least one workspace. Transfer ownership, or delete the workspace, before an erasure request can be completed.";

export type ErasureResult = { readonly blocked: true; readonly reason: string } | { readonly blocked: false };

export async function requestIndividualErasure(privilegedClient: ClientBase, userId: string): Promise<ErasureResult> {
  // audit_log and credit_ledger both carry the append-only
  // `reject_update_delete` trigger (migrations 0002/0004) — it raises on
  // ANY UPDATE unconditionally, so pseudonymising actor_id on either table
  // needs the SAME disable/re-enable dance as executeWorkspaceHardDelete's
  // resolution of STORY-007's deferred cascade constraint.
  //
  // Should-fix #8 (TOCTOU): the sole-owner check now runs INSIDE this same
  // transaction, with `FOR UPDATE` locking the requester's own active-owner
  // row(s) — it used to run as a standalone query BEFORE BEGIN, so a
  // concurrent ownership transfer could complete between the check and the
  // anonymization work below. Locking the row here means a concurrent
  // transfer touching the SAME row blocks until this transaction finishes,
  // closing that gap.
  //
  // Blocking (code review, same fix as executeWorkspaceHardDelete): ENABLE
  // TRIGGER now runs INSIDE this transaction, before COMMIT, not in a
  // `finally` after it — `ALTER TABLE ... DISABLE/ENABLE TRIGGER` is
  // transactional DDL, so a ROLLBACK already undoes the DISABLE with no
  // separate re-enable step needed.
  await privilegedClient.query("BEGIN");
  try {
    const soleOwner = await privilegedClient.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM workspace_members WHERE user_id = $1 AND role = 'owner' AND status = 'active' FOR UPDATE
       ) AS exists`,
      [userId],
    );
    if (soleOwner.rows[0]!.exists) {
      await privilegedClient.query("ROLLBACK");
      return { blocked: true, reason: SOLE_OWNER_ERASURE_BLOCK_REASON };
    }

    await privilegedClient.query(
      `UPDATE users
          SET email = 'deleted+' || id || '@nominara.invalid',
              full_name = NULL,
              avatar_url = NULL,
              status = 'deleted',
              deleted_at = now()
        WHERE id = $1`,
      [userId],
    );
    await privilegedClient.query("UPDATE workspace_members SET status = 'removed' WHERE user_id = $1", [userId]);
    await privilegedClient.query("UPDATE task_events SET actor_id = $2, actor_type = 'system' WHERE actor_id = $1", [
      userId,
      SYSTEM_ACTOR_ID,
    ]);
    await privilegedClient.query("UPDATE milestones SET created_by = $2 WHERE created_by = $1", [userId, SYSTEM_ACTOR_ID]);

    // STORY-020 D-4 / STORY-020-E-9: the workspaces touched by this
    // pseudonymisation must be captured BEFORE the UPDATE below overwrites
    // actor_id — after the UPDATE, this SELECT could never find them again.
    const affectedWorkspaces = await privilegedClient.query<{ workspace_id: string }>(
      "SELECT DISTINCT workspace_id FROM audit_log WHERE actor_id = $1",
      [userId],
    );

    await privilegedClient.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete");
    await privilegedClient.query("ALTER TABLE credit_ledger DISABLE TRIGGER reject_update_delete");
    await privilegedClient.query("UPDATE audit_log SET actor_id = $2 WHERE actor_id = $1", [userId, SYSTEM_ACTOR_ID]);
    // ⚠ PSEUDONYMISED, NOT REASSIGNED, and `credit_ledger` differs from
    // `audit_log` above for a reason worth stating. Both retain their rows;
    // only this one is an ACCOUNTING record, kept for the invoice-dispute
    // window (data-model.md §7), and a dispute asks who authorised a charge.
    // Collapsing every erased person onto the system actor answers "the
    // system", which is not an answer — after two erasures their spend is
    // indistinguishable, and from entries the system genuinely caused too.
    //
    // `actor_id` goes NULL because it carries an FK to `users` and a
    // pseudonym has no row to point at; `ck_credit_ledger_actor_exclusive`
    // is what keeps the two from ever both being set. The pseudonym is
    // deterministic, so one person's entries still group together, and
    // one-way, so the grouping identifies nobody.
    // ⚠ RANDOM, NOT DERIVED FROM THE USER ID. The first version hashed the
    // id, and the second-engineer review inverted it in one query: this
    // function ANONYMISES the `users` row rather than deleting it — every FK
    // in the product points at that id — so the brute-force candidate space
    // is `SELECT id FROM users`. Worse, the anonymised email above is
    // 'deleted+' || id || '@nominara.invalid', so the raw UUID survives in
    // plaintext in the very row that was meant to remove it.
    //
    // One random UUID, generated here and stored, groups this person's rows
    // exactly as well as a digest did and cannot be inverted because nothing
    // derives it. It is also a REAL v4 UUID, which the digest was not — 87%
    // of hashed pseudonyms failed the route's own published `uuid` contract,
    // written immutably into an append-only table.
    //
    // Generated once per erasure and reused for the whole UPDATE, so every
    // row of one person carries the same value.
    await privilegedClient.query(
      "UPDATE credit_ledger SET actor_id = NULL, actor_pseudonym = $2 WHERE actor_id = $1",
      [userId, randomUUID()],
    );

    // ⚠ AND THE LEDGER'S OWN REFERENCES ARE A ROUTE BACK TO THE PERSON.
    // STORY-073B started recording `reference_id` on every debit — the
    // capture run — and `capture_runs.triggered_by` holds the raw user id.
    // So a pseudonymised ledger row joined one hop re-identified the person
    // it had just been scrubbed of, a path this story created. Reassigned to
    // the system actor exactly as `milestones.created_by` and `task_events`
    // already are, and for the same reason.
    await privilegedClient.query("UPDATE capture_runs SET triggered_by = $2 WHERE triggered_by = $1", [
      userId,
      SYSTEM_ACTOR_ID,
    ]);
    await privilegedClient.query("ALTER TABLE audit_log ENABLE TRIGGER reject_update_delete");
    await privilegedClient.query("ALTER TABLE credit_ledger ENABLE TRIGGER reject_update_delete");

    // Documents exactly when/why the rows just pseudonymised stopped
    // matching their own row_hash, moving verifyChain's strict-verification
    // boundary forward past this event (see audit-chain.ts's own doc comment
    // on RECHAINED_MARKER_ACTION for the full trade-off, disclosed as
    // STORY-020-E-9). A plain INSERT — the append-only trigger only rejects
    // UPDATE/DELETE, never INSERT — so this runs fine with the trigger
    // already re-enabled above.
    for (const { workspace_id: affectedWorkspaceId } of affectedWorkspaces.rows) {
      // STORY-143 AC7 — never rechain over a chain that already fails its marks.
      // A `rechain` mark at a new head would otherwise launder a prior tail
      // truncation. Throwing rolls the whole erasure back; the verifier pages.
      const broken = await findBrokenMark(privilegedClient, affectedWorkspaceId);
      if (broken !== null) {
        throw new Error(
          `erasure rechain refused for workspace ${affectedWorkspaceId}: audit chain fails its high-water mark at seq ${broken.seq} (${broken.present ? "mark_hash_mismatch" : "chain_truncated"})`,
        );
      }
      await auditChain.append(privilegedClient, {
        workspaceId: affectedWorkspaceId,
        actorType: "system",
        actorId: SYSTEM_ACTOR_ID,
        actorIp: null,
        actorUa: null,
        action: RECHAINED_MARKER_ACTION,
        resourceType: "audit_log",
        resourceId: null,
        beforeState: null,
        afterState: { reason: "individual_erasure" },
        requestId: `erasure-${affectedWorkspaceId}`,
        supportGrantId: null,
        severity: "notice",
      });
      // STORY-143 AC7 — the head moved on purpose; say so in the same
      // transaction. Appending the marker advanced the chain, so the verifier's
      // previous mark is still satisfied, but the NEW head is a promise too:
      // deleting the marker row afterwards is exactly how a forged rechain is
      // undone, and only a mark at the marker row can see it.
      const head = await readChainHead(privilegedClient, affectedWorkspaceId);
      if (head === null) {
        throw new Error(`erasure rechain for workspace ${affectedWorkspaceId} appended a marker but found no chain head`);
      }
      await appendMark(privilegedClient, affectedWorkspaceId, head, "rechain");
    }

    await privilegedClient.query("COMMIT");
  } catch (error) {
    await privilegedClient.query("ROLLBACK");
    throw error;
  }
  return { blocked: false };
}

// ---------------------------------------------------------------------------
// Raw-capture expiry — nulls raw_object_key, marks payload.raw_expired,
// retains rollups (metric_daily) and the excerpt (response_excerpt).
// ---------------------------------------------------------------------------

export async function expireRawCaptures(
  client: ClientBase,
  workspaceId: string,
  retentionDays: RetentionWindow,
  referenceDate: Date = new Date(),
): Promise<number> {
  const cutoff = resolveRetentionCutoff(retentionDays, referenceDate);
  if (cutoff === null) return 0;
  return withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    const result = await tx.query(
      `UPDATE answer_captures
          SET raw_object_key = NULL,
              payload = jsonb_set(payload, '{raw_expired}', 'true'::jsonb, true)
        WHERE workspace_id = $1 AND captured_at < $2 AND raw_object_key IS NOT NULL`,
      [workspaceId, cutoff.toISOString()],
    );
    return result.rowCount ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Rollup expiry — metric_daily deleted; milestones NEVER touched here.
// ---------------------------------------------------------------------------

export async function expireRollups(
  client: ClientBase,
  workspaceId: string,
  rollupsRetentionDays: RetentionWindow,
  referenceDate: Date = new Date(),
): Promise<number> {
  const cutoff = resolveRetentionCutoff(rollupsRetentionDays, referenceDate);
  if (cutoff === null) return 0;
  return withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    const result = await tx.query("DELETE FROM metric_daily WHERE workspace_id = $1 AND metric_date < $2", [
      workspaceId,
      cutoff.toISOString().slice(0, 10),
    ]);
    return result.rowCount ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Derived-analysis expiry — geo_analyses, attribution_url_rollup,
// topic_clusters, all at rollup-retention cadence (recomputable from facts).
// ---------------------------------------------------------------------------

export interface DerivedAnalysesExpired {
  readonly geoAnalyses: number;
  readonly attributionUrlRollup: number;
  readonly topicClusters: number;
}

export async function expireDerivedAnalyses(
  client: ClientBase,
  workspaceId: string,
  rollupsRetentionDays: RetentionWindow,
  referenceDate: Date = new Date(),
): Promise<DerivedAnalysesExpired> {
  const cutoff = resolveRetentionCutoff(rollupsRetentionDays, referenceDate);
  if (cutoff === null) return { geoAnalyses: 0, attributionUrlRollup: 0, topicClusters: 0 };
  return withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    const geo = await tx.query("DELETE FROM geo_analyses WHERE workspace_id = $1 AND computed_at < $2", [
      workspaceId,
      cutoff.toISOString(),
    ]);
    const attribution = await tx.query(
      "DELETE FROM attribution_url_rollup WHERE workspace_id = $1 AND computed_at < $2",
      [workspaceId, cutoff.toISOString()],
    );
    const topics = await tx.query("DELETE FROM topic_clusters WHERE workspace_id = $1 AND computed_at < $2", [
      workspaceId,
      cutoff.toISOString(),
    ]);
    return {
      geoAnalyses: geo.rowCount ?? 0,
      attributionUrlRollup: attribution.rowCount ?? 0,
      topicClusters: topics.rowCount ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// attribution_daily expiry — rollup retention cadence, never per-visitor.
// ---------------------------------------------------------------------------

export async function expireAttributionDaily(
  client: ClientBase,
  workspaceId: string,
  rollupsRetentionDays: RetentionWindow,
  referenceDate: Date = new Date(),
): Promise<number> {
  const cutoff = resolveRetentionCutoff(rollupsRetentionDays, referenceDate);
  if (cutoff === null) return 0;
  return withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    const result = await tx.query("DELETE FROM attribution_daily WHERE workspace_id = $1 AND metric_date < $2", [
      workspaceId,
      cutoff.toISOString().slice(0, 10),
    ]);
    return result.rowCount ?? 0;
  });
}

// ---------------------------------------------------------------------------
// Tool-snapshot expiry — nulls result_json, keeps headline metrics
// (sov_estimate, citation_count, sentiment_label, brand_present, aux_score,
// entities_found, pages_scanned, items_kept), sets status='expired'.
// ---------------------------------------------------------------------------

/** STORY-078 AC15 - one batch's size, and how many batches one workspace gets in one nightly pass (10,000 runs). */
export const TOOL_SNAPSHOT_SWEEP_BATCH_SIZE = 500;
export const TOOL_SNAPSHOT_SWEEP_MAX_BATCHES = 20;

export interface ToolSnapshotSweepOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

/**
 * IDEMPOTENT (an expired run is not selected again), BATCHED (each batch is its own short transaction, so no lock outlives a batch) and
 * BOUNDED (a workspace gets at most `maxBatches` batches a pass; the rest wait for the next night). `FOR UPDATE SKIP LOCKED`: a run being
 * finished, pinned or converted at this moment is skipped and expires on the next pass, never blocks the sweep, and is never raced.
 * Pinning is not read: a pinned run still expires. ONLY A FINISHED RUN EXPIRES (the database trigger agrees): a run still `running` has an
 * unsettled charge, and expiring it would strand the debit, so a run still `running` past its own expires_at is settled first by
 * `reapStaleToolRuns` (refunded through the same path) INSIDE this function: a direct caller gets the same answer as the nightly sweep,
 * which also reaps first. Reaping is idempotent, so doing it in both places is safe.
 */
export async function expireToolSnapshotsForWorkspace(
  client: ClientBase,
  workspaceId: string,
  referenceDate: Date = new Date(),
  options: ToolSnapshotSweepOptions = {},
): Promise<number> {
  const batchSize = options.batchSize ?? TOOL_SNAPSHOT_SWEEP_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? TOOL_SNAPSHOT_SWEEP_MAX_BATCHES;
  for (let pass = 0; pass < maxBatches; pass += 1) {
    if ((await reapStaleToolRuns(client, workspaceId, referenceDate)) < TOOL_RUN_REAP_BATCH_SIZE) break;
  }
  let total = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const expired = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
      const result = await tx.query(
        `WITH due AS (
           SELECT id FROM tool_runs
            WHERE workspace_id = $1 AND status IN ('completed', 'partial', 'failed') AND expires_at <= $2
            ORDER BY expires_at, id
            LIMIT $3
              FOR UPDATE SKIP LOCKED
         )
         UPDATE tool_runs t SET status = 'expired', result_json = NULL
           FROM due WHERE t.id = due.id AND t.workspace_id = $1`,
        [workspaceId, referenceDate.toISOString(), batchSize],
      );
      return result.rowCount ?? 0;
    });
    total += expired;
    if (expired < batchSize) break;
  }
  if (total > 0) {
    observeValue("nominara_tools_snapshots_expired_rows", total);
    logger.log({ message: "tool snapshots expired", workspace_id: workspaceId, rows: total });
  }
  return total;
}

/** Owner decision 31 (2026-10-30): 60 minutes. A run still `running` after this long has lost its worker: the engine fan-out is bounded at about a minute (api-specification section 9). */
export const TOOL_RUN_STALE_AFTER_MINUTES = 60;
export const TOOL_RUN_REAP_BATCH_SIZE = 200;

/**
 * KAD-12 - every reserve ends in a commit or a release, including when the job that held the run is lost (worker crash, enqueue failure
 * after commit, poison message). A stale `running` run is settled as `failed` with `run_abandoned` and its charge returned in full
 * through the same refund path `finishRun` uses; the debit's own idempotency key makes a repeat (or a late `finishRun` from the lost
 * worker, which then finds the run not running) refund nothing more. Bounded to one batch a pass per workspace; a locked row is skipped.
 */
export async function reapStaleToolRuns(
  client: ClientBase,
  workspaceId: string,
  referenceDate: Date = new Date(),
  options: { readonly staleAfterMinutes?: number; readonly batchSize?: number } = {},
): Promise<number> {
  const cutoff = new Date(referenceDate.getTime() - (options.staleAfterMinutes ?? TOOL_RUN_STALE_AFTER_MINUTES) * 60_000);
  const reaped = await withTenantContext(client, { workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
    const due = await tx.query<{ id: string; credits_charged: number }>(
      `SELECT id, credits_charged FROM tool_runs
        WHERE workspace_id = $1 AND status = 'running' AND (created_at <= $2 OR expires_at <= $4)
        ORDER BY created_at, id
        LIMIT $3
          FOR UPDATE SKIP LOCKED`,
      [workspaceId, cutoff.toISOString(), options.batchSize ?? TOOL_RUN_REAP_BATCH_SIZE, referenceDate.toISOString()],
    );
    for (const run of due.rows) {
      const refunded = run.credits_charged > 0 ? (await settleFinishedRunCredits(tx, { workspaceId, runId: run.id, deliveredCells: 0, referenceType: "tool_run" })).refunded : 0;
      await tx.query(
        "UPDATE tool_runs SET status = 'failed', error_code = 'run_abandoned', credits_charged = credits_charged - $3 WHERE workspace_id = $1 AND id = $2 AND status = 'running'",
        [workspaceId, run.id, refunded],
      );
    }
    return due.rows.length;
  });
  if (reaped > 0) {
    observeValue("nominara_tools_runs_reaped_rows", reaped);
    logger.warn({ message: "stale tool runs settled as failed and refunded", workspace_id: workspaceId, rows: reaped });
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// Nightly orphan scan — data-model.md §5 "the price of partitioning without
// foreign keys": zero fact rows without a parent answer_captures row for
// that (captured_at, result_id), per partition, and PAGES on non-zero.
//
// No PagerDuty/alert-paging integration exists anywhere in this repo yet
// (the same disclosed absence as README.md gap G-1 — this is not a new
// gap). A thrown error (non-zero process exit from `pnpm db:maintenance:
// sweep`) is the strongest "page" a script-only environment can produce
// today, and is deliberately NOT a passive log line — see this story's
// Implementation Decisions.
// ---------------------------------------------------------------------------

export interface OrphanReport {
  readonly table: "mention_facts" | "citation_facts";
  readonly partition: string;
  readonly orphanCount: number;
}

export async function scanForOrphans(client: ClientBase): Promise<OrphanReport[]> {
  // Cross-tenant by definition, so it goes through the count-only SECURITY DEFINER function (migration 0160, ADR-0004): a direct scan
  // from a NOSUPERUSER NOBYPASSRLS connection would read 0 rows under FORCE RLS. Counts and partition names only; a partition with no
  // orphan is not returned.
  const result = await client.query<{ parent_table: "mention_facts" | "citation_facts"; partition_name: string; orphan_count: string }>(
    "SELECT parent_table, partition_name, orphan_count::text AS orphan_count FROM app.maintenance_orphan_counts() ORDER BY parent_table, partition_name",
  );
  return result.rows
    .map((row) => ({ table: row.parent_table, partition: row.partition_name, orphanCount: Number(row.orphan_count) }))
    .filter((report) => report.orphanCount > 0);
}

export const ORPHAN_SCAN_PAGE_MESSAGE = "orphan fact row(s) detected — a fact was written outside its parent's transaction";

export async function runOrphanScan(client: ClientBase): Promise<OrphanReport[]> {
  const reports = await scanForOrphans(client);
  if (reports.length > 0) {
    // Deliberately not an interpolated-segment-then-slash shape (ISO-14's
    // scanner over src/ flags that exact shape as a possible un-namespaced
    // object key) — this is a diagnostic message, not an object key.
    const detail = reports.map((r) => `table=${r.table} partition=${r.partition} count=${r.orphanCount}`).join(", ");
    throw new Error(`${ORPHAN_SCAN_PAGE_MESSAGE}: ${detail}`);
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Export lock blocks purge — an active export holds a BLOCKING advisory lock
// on the project's purge for the export's duration; the purge job's
// per-project loop uses `pg_try_advisory_lock` and skips+retries next cycle.
// ---------------------------------------------------------------------------

function purgeLockKey(projectId: string): string {
  return `export.purge.${projectId}`;
}

export async function withExportLock<T>(client: ClientBase, projectId: string, fn: () => Promise<T>): Promise<T> {
  await client.query("SELECT pg_advisory_lock(hashtext($1)::bigint)", [purgeLockKey(projectId)]);
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [purgeLockKey(projectId)]);
  }
}

export interface PurgeSkipped {
  readonly scope: "project" | "workspace";
  readonly scopeId: string;
  readonly reason: "export-lock-held";
}

export type TryPurgeOutcome = PurgeSkipped | { readonly scope: "project"; readonly scopeId: string; readonly purged: true };

export async function tryPurgeProject(
  client: ClientBase,
  projectId: string,
  fn: (client: ClientBase) => Promise<void>,
): Promise<TryPurgeOutcome> {
  const acquired = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked", [
    purgeLockKey(projectId),
  ]);
  if (!acquired.rows[0]!.locked) {
    return { scope: "project", scopeId: projectId, reason: "export-lock-held" };
  }
  try {
    await fn(client);
    return { scope: "project", scopeId: projectId, purged: true };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [purgeLockKey(projectId)]);
  }
}

/**
 * The project ids WITHIN `workspaceId` that currently hold an open export
 * lock — a non-mutating probe (acquires then immediately releases
 * `pg_try_advisory_lock` for every project that ISN'T locked, to avoid
 * leaking a lock this function never intended to hold).
 */
export async function workspaceProjectsWithOpenExports(client: ClientBase, workspaceId: string): Promise<string[]> {
  const projects = await client.query<{ id: string }>("SELECT id FROM projects WHERE workspace_id = $1", [workspaceId]);
  const locked: string[] = [];
  for (const { id } of projects.rows) {
    const probe = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked", [
      purgeLockKey(id),
    ]);
    if (probe.rows[0]!.locked) {
      await client.query("SELECT pg_advisory_unlock(hashtext($1)::bigint)", [purgeLockKey(id)]);
    } else {
      locked.push(id);
    }
  }
  return locked;
}

// ---------------------------------------------------------------------------
// purge_failures persistence — a purge job failure requires an explicit
// resolution (`resolved_at` set), never a silent retry-clears-it path.
// ---------------------------------------------------------------------------

export interface RecordPurgeFailureInput {
  readonly scope: "project" | "workspace";
  readonly scopeId: string;
  readonly reason: string;
  readonly detail?: PurgeFailureDetail;
}

export async function recordPurgeFailure(client: ClientBase, input: RecordPurgeFailureInput): Promise<void> {
  await client.query("INSERT INTO purge_failures (scope, scope_id, reason, detail) VALUES ($1, $2, $3, $4)", [
    input.scope,
    input.scopeId,
    input.reason,
    input.detail === undefined ? null : JSON.stringify(input.detail),
  ]);
}

export async function resolvePurgeFailure(client: ClientBase, id: string, resolvedBy: string): Promise<void> {
  await client.query("UPDATE purge_failures SET resolved_at = now(), resolved_by = $2 WHERE id = $1", [id, resolvedBy]);
}

// ---------------------------------------------------------------------------
// Orchestration — the nightly sweep (expiries + orphan scan, per active
// workspace) and the daily purge cycle (project/workspace hard deletes,
// export-lock aware).
// ---------------------------------------------------------------------------

export interface NightlySweepResult {
  readonly rawCapturesExpired: number;
  readonly rollupsExpired: number;
  readonly derivedAnalysesExpired: DerivedAnalysesExpired;
  readonly attributionDailyExpired: number;
  readonly toolSnapshotsExpired: number;
  /** Stale `running` tool runs settled as failed and refunded this pass. */
  readonly toolRunsReaped: number;
  /** Workspaces whose tool-run reap or expiry threw: counted, logged and skipped so one tenant's bad row cannot stop retention for the rest. */
  readonly toolSweepFailedWorkspaces: readonly string[];
  /** Workspaces swept under the replaced plan's longer windows because their first purge is deferred (STORY-077 slice B). */
  readonly deferredWorkspaces: number;
  /**
   * STORY-111 / NFR-CMP-10: workspaces the sweep SKIPPED because a legal hold covers the workspace or one of its projects. Reported, never
   * omitted silently. A project-level hold skips the whole workspace's sweep: the expiry functions are workspace-scoped, and over-retaining
   * is the safe side of a legal hold.
   */
  readonly held: readonly PurgeHeld[];
  readonly orphans: readonly OrphanReport[];
}

/** A subject a purge SKIPPED because of a legal hold. */
export interface PurgeHeld {
  readonly scope: "project" | "workspace";
  readonly scopeId: string;
  readonly reason: "legal-hold";
}

export async function runNightlySweep(privilegedClient: ClientBase, referenceDate: Date = new Date()): Promise<NightlySweepResult> {
  const workspaces = await privilegedClient.query<{ id: string }>(
    "SELECT id FROM workspaces WHERE deleted_at IS NULL AND status <> 'pending_deletion'",
  );

  let rawCapturesExpired = 0;
  let rollupsExpired = 0;
  let attributionDailyExpired = 0;
  let toolSnapshotsExpired = 0;
  let toolRunsReaped = 0;
  const toolSweepFailedWorkspaces: string[] = [];
  const derivedAnalysesExpired: { geoAnalyses: number; attributionUrlRollup: number; topicClusters: number } = {
    geoAnalyses: 0,
    attributionUrlRollup: 0,
    topicClusters: 0,
  };

  let workspacesDeferred = 0;
  const holds = await activeHolds(privilegedClient, referenceDate);
  const held: PurgeHeld[] = [];
  for (const { id: workspaceId } of workspaces.rows) {
    if (holds.workspaces.has(workspaceId) || holds.workspacesWithHeldProject.has(workspaceId)) {
      held.push({ scope: "workspace", scopeId: workspaceId, reason: "legal-hold" });
      incrementCounter("nominara_retention_purge_held_total", { scope: "workspace", job: "sweep" });
      continue;
    }
    const retention = await resolveWorkspaceRetention(privilegedClient, workspaceId, referenceDate);
    // STORY-077 slice B (EC-41): while a plan change's first purge is deferred past its notice, the windows in force are the
    // replaced plan's (resolveWorkspaceRetention returns the longer of the two), so everything the OLD plan already expired is
    // still expired, tool snapshots included, and nothing the new, shorter window would remove goes yet. The deferral adds no
    // predicate to any DELETE or UPDATE below, so it cannot widen what this owner-role connection removes.
    if (retentionPurgeDeferred(retention, referenceDate)) {
      workspacesDeferred += 1;
      incrementCounter("nominara_retention_sweep_deferred_total");
      logger.log({ message: "retention sweep running under the replaced plan's windows for a workspace (shortened-retention notice period)", workspace_id: workspaceId });
    }
    rawCapturesExpired += await expireRawCaptures(privilegedClient, workspaceId, retention.rawCapturesDays, referenceDate);
    rollupsExpired += await expireRollups(privilegedClient, workspaceId, retention.rollupsDays, referenceDate);
    const derived = await expireDerivedAnalyses(privilegedClient, workspaceId, retention.rollupsDays, referenceDate);
    derivedAnalysesExpired.geoAnalyses += derived.geoAnalyses;
    derivedAnalysesExpired.attributionUrlRollup += derived.attributionUrlRollup;
    derivedAnalysesExpired.topicClusters += derived.topicClusters;
    attributionDailyExpired += await expireAttributionDaily(privilegedClient, workspaceId, retention.rollupsDays, referenceDate);
    try {
      toolRunsReaped += await reapStaleToolRuns(privilegedClient, workspaceId, referenceDate);
      toolSnapshotsExpired += await expireToolSnapshotsForWorkspace(privilegedClient, workspaceId, referenceDate);
    } catch (error) {
      // Not swallowed: reported in the result and the metric, and the pass continues for every other tenant. The error text can carry row
      // values, so only its class is logged.
      toolSweepFailedWorkspaces.push(workspaceId);
      incrementCounter("nominara_tools_sweep_failures_total");
      logger.error({ message: "tool-run retention failed for a workspace; continuing with the rest", workspace_id: workspaceId, error: error instanceof Error ? error.name : "unknown" });
    }
  }

  const orphans = await scanForOrphans(privilegedClient);

  return {
    rawCapturesExpired,
    rollupsExpired,
    derivedAnalysesExpired,
    attributionDailyExpired,
    toolSnapshotsExpired,
    toolRunsReaped,
    toolSweepFailedWorkspaces,
    deferredWorkspaces: workspacesDeferred,
    held,
    orphans,
  };
}

export interface DailyPurgeCycleOptions {
  readonly referenceDate?: Date;
  readonly deleteObjectPrefix?: (prefix: string) => Promise<void>;
  readonly exportComplianceRecords?: (records: readonly ComplianceExportRow[]) => Promise<void>;
  /** STORY-180 r5: deletes an erased workspace's stored report files after its cascade commits. Absent = the objects are not touched. */
  readonly deleteWorkspaceObjects?: (workspaceId: string) => Promise<void>;
  /**
   * STORY-111 / NFR-CMP-08: the purge journal, outside the database. When present, each purge appends one entry AFTER its cascade commits
   * (an entry for a delete that rolled back would make a restore purge a live tenant). A failed append is a recorded `purge_failures` row.
   */
  readonly journal?: PurgeJournal;
  /** Builds the per-workspace `exportComplianceRecords` (object storage). Takes precedence over `exportComplianceRecords`. */
  readonly exporterFor?: (workspaceId: string) => (records: readonly ComplianceExportRow[]) => Promise<void>;
}

export interface DailyPurgeCycleResult {
  readonly projectsPurged: readonly string[];
  readonly workspacesPurged: readonly string[];
  readonly skipped: readonly PurgeSkipped[];
  /** STORY-111: subjects skipped under a legal hold (reported, never silently omitted). */
  readonly held: readonly PurgeHeld[];
  /** STORY-111: failures recorded in `purge_failures` during this cycle. */
  readonly failed: number;
}

async function journalPurge(
  client: ClientBase,
  journal: PurgeJournal | undefined,
  entry: { scope: "project" | "workspace"; scopeId: string; workspaceId: string; reason: "project_hard_deleted" | "workspace_deletion_executed" },
): Promise<boolean> {
  if (journal === undefined) return true;
  try {
    await journal.append(entry);
    incrementCounter("nominara_retention_purge_journal_entries_total", { scope: entry.scope });
    return true;
  } catch (error) {
    // The cascade has committed. The subject IS gone; what is missing is the record that a restore would need. Loud, and unresolved until an operator re-journals it.
    await recordPurgeFailure(client, { scope: entry.scope, scopeId: entry.scopeId, reason: "purge journal append failed after the purge committed" });
    logger.error({ message: "purge journal append failed", scope: entry.scope, scope_id: entry.scopeId, error: error instanceof Error ? error.name : "unknown" });
    return false;
  }
}

export async function runDailyPurgeCycle(
  privilegedClient: ClientBase,
  options: DailyPurgeCycleOptions = {},
): Promise<DailyPurgeCycleResult> {
  const referenceDate = options.referenceDate ?? new Date();
  const startedAt = new Date();
  // A lapsed hold releases by itself (the `active` predicate is on expires_at); this records and audits that it did.
  await releaseExpiredHolds(privilegedClient, referenceDate);
  const holds = await activeHolds(privilegedClient, referenceDate);
  const held: PurgeHeld[] = [];
  let failed = 0;
  const hardDeleteCutoff = new Date(referenceDate.getTime() - 30 * 86_400_000);

  const dueProjects = await privilegedClient.query<{ id: string; workspace_id: string }>(
    "SELECT id, workspace_id FROM projects WHERE deleted_at IS NOT NULL AND deleted_at <= $1",
    [hardDeleteCutoff.toISOString()],
  );

  const projectsPurged: string[] = [];
  const skipped: PurgeSkipped[] = [];
  for (const project of dueProjects.rows) {
    if (holds.projects.has(project.id) || holds.workspaces.has(project.workspace_id)) {
      held.push({ scope: "project", scopeId: project.id, reason: "legal-hold" });
      incrementCounter("nominara_retention_purge_held_total", { scope: "project", job: "purge" });
      continue;
    }
    // Blocking (code review): one project's purge failure must not abort
    // every remaining dueProjects row AND the entire dueWorkspaces loop that
    // follows. recordPurgeFailure already persisted the failure (inside
    // tryPurgeProject's callback below) before this rethrows — this try/catch
    // exists ONLY to stop that rethrow from propagating past this one
    // project's iteration.
    try {
      const outcome = await tryPurgeProject(privilegedClient, project.id, async (tx) => {
        try {
          const hardDeleteOptions: HardDeleteProjectOptions = options.deleteObjectPrefix
            ? { deleteObjectPrefix: options.deleteObjectPrefix }
            : {};
          await hardDeleteProject(tx, project.workspace_id, project.id, hardDeleteOptions);
        } catch (error) {
          await recordPurgeFailure(tx, { scope: "project", scopeId: project.id, reason: (error as Error).message });
          throw error;
        }
      });
      if ("purged" in outcome) {
        projectsPurged.push(project.id);
        await privilegedClient.query("DELETE FROM legal_holds WHERE scope = 'project' AND scope_id = $1", [project.id]);
        if (!(await journalPurge(privilegedClient, options.journal, { scope: "project", scopeId: project.id, workspaceId: project.workspace_id, reason: "project_hard_deleted" }))) failed += 1;
      } else {
        skipped.push(outcome);
      }
    } catch {
      // Already recorded in purge_failures above; continue with the next
      // due project rather than aborting the whole cycle.
      failed += 1;
    }
  }

  const dueWorkspaces = await privilegedClient.query<{ id: string }>(
    "SELECT id FROM workspaces WHERE status = 'pending_deletion' AND deletion_execute_at <= $1",
    [referenceDate.toISOString()],
  );
  const workspacesPurged: string[] = [];
  for (const workspace of dueWorkspaces.rows) {
    if (holds.workspaces.has(workspace.id) || holds.workspacesWithHeldProject.has(workspace.id)) {
      held.push({ scope: "workspace", scopeId: workspace.id, reason: "legal-hold" });
      incrementCounter("nominara_retention_purge_held_total", { scope: "workspace", job: "purge" });
      continue;
    }
    const openExports = await workspaceProjectsWithOpenExports(privilegedClient, workspace.id);
    if (openExports.length > 0) {
      skipped.push({ scope: "workspace", scopeId: workspace.id, reason: "export-lock-held" });
      continue;
    }
    try {
      await executeWorkspaceHardDelete(privilegedClient, workspace.id, {
        exportComplianceRecords:
          (options.exporterFor !== undefined ? options.exporterFor(workspace.id) : undefined) ??
          options.exportComplianceRecords ??
          (async () => {
            throw new Error(
              "executeWorkspaceHardDelete: no exportComplianceRecords callback supplied — no object-storage client exists in this repo yet (disclosed gap)",
            );
          }),
        ...(options.deleteWorkspaceObjects !== undefined ? { deleteWorkspaceObjects: options.deleteWorkspaceObjects } : {}),
      });
      workspacesPurged.push(workspace.id);
      if (!(await journalPurge(privilegedClient, options.journal, { scope: "workspace", scopeId: workspace.id, workspaceId: workspace.id, reason: "workspace_deletion_executed" }))) failed += 1;
    } catch (error) {
      // The cascade committed: the workspace IS purged, and the leftover objects are an unresolved failure the operator must clear.
      if (error instanceof WorkspaceObjectsLeftBehindError) {
        workspacesPurged.push(workspace.id);
        await journalPurge(privilegedClient, options.journal, { scope: "workspace", scopeId: workspace.id, workspaceId: workspace.id, reason: "workspace_deletion_executed" });
      }
      failed += 1;
      await recordPurgeFailure(privilegedClient, { scope: "workspace", scopeId: workspace.id, reason: (error as Error).message });
    }
  }

  // STORY-111: the outcome of THIS cycle, always, so "ran and found nothing" is distinguishable from "did not run".
  const skippedHold = held.length;
  const skippedLock = skipped.length;
  await privilegedClient.query(
    `INSERT INTO purge_runs (started_at, finished_at, projects_purged, workspaces_purged, skipped_export_lock, skipped_legal_hold, failed, status)
     VALUES ($1, GREATEST(now(), $1::timestamptz), $2, $3, $4, $5, $6, $7)`,
    [startedAt.toISOString(), projectsPurged.length, workspacesPurged.length, skippedLock, skippedHold, failed, failed === 0 ? "ok" : "partial"],
  );
  incrementCounter("nominara_retention_purge_cycles_total", { status: failed === 0 ? "ok" : "partial" });

  return { projectsPurged, workspacesPurged, skipped, held, failed };
}

async function main(): Promise<void> {
  const client = await connect(requireDatabaseUrl());
  try {
    const sweep = await runNightlySweep(client);
    console.log(JSON.stringify(sweep, null, 2));
    const purgeCycle = await runDailyPurgeCycle(client);
    console.log(JSON.stringify(purgeCycle, null, 2));
    if (sweep.orphans.length > 0) {
      console.error(`db:maintenance:sweep: ${ORPHAN_SCAN_PAGE_MESSAGE}: ${JSON.stringify(sweep.orphans)}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
