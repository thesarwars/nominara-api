import type { ClientBase, Pool } from "pg";
import { describe, expect, it } from "vitest";
import { applyPlanChange, planKeyOnly } from "../../src/lib/billing/apply-plan.js";
import { WorkspacesService } from "../../src/modules/workspaces/workspaces.service.js";
import { requestWorkspaceDeletion } from "../../src/workers/rollup/retention.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// Checkpoint-6 (major). The lock holder of the workspaces row (add, remove, checkout) keeps it across Stripe
// calls, up to about 5 x 10 s. Every OTHER writer of that row queued behind it with no `lock_timeout` on a
// main-pool connection, so a burst of PATCH /workspaces/:id from one tenant could drain the pool for all of them.
// Each writer must set a transaction-local lock_timeout BEFORE its first locking statement and turn the resulting
// SQLSTATE 55P03 into a retryable refusal.

const WORKSPACE = "00000000-0000-7000-8000-0000000000aa";
const LOCKING = /FOR UPDATE|UPDATE workspaces/iu;

interface Recorded {
  readonly client: ClientBase;
  readonly statements: string[];
  readonly lockTimeoutAtLockingStatement: (string | undefined)[];
}

/** A connection whose workspaces row is held by someone else: the first locking statement fails with 55P03 (what lock_timeout produces). */
function heldRowClient(): Recorded {
  const statements: string[] = [];
  const lockTimeoutAtLockingStatement: (string | undefined)[] = [];
  let lockTimeout: string | undefined;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      statements.push(sql);
      if (/set_config\(\s*'lock_timeout'/iu.test(sql)) lockTimeout = String(params?.[0] ?? "0");
      if (LOCKING.test(sql) && !/set_config/iu.test(sql)) {
        lockTimeoutAtLockingStatement.push(lockTimeout);
        throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as ClientBase;
  return { client, statements, lockTimeoutAtLockingStatement };
}

const poolOf = (client: ClientBase): Pool => ({ connect: async () => client }) as unknown as Pool;
const service = (): WorkspacesService => new WorkspacesService(null as never, null as never, null as never, null as never, null as never, null as never);
const tenant = { workspaceId: WORKSPACE, actorId: WORKSPACE };

function expectBoundedFirst(r: Recorded): void {
  expect(r.lockTimeoutAtLockingStatement, "the writer reached a locking statement").toHaveLength(1);
  expect(Number(r.lockTimeoutAtLockingStatement[0]), "lock_timeout was set before the locking statement").toBeGreaterThan(0);
  expect(Number(r.lockTimeoutAtLockingStatement[0])).toBeLessThanOrEqual(3_000);
}

describe("checkpoint-6 · every writer of the workspaces row bounds its wait for the row lock", () => {
  it("D-1 AC-bound-update . PATCH /workspaces/:id (WorkspacesService.update) sets lock_timeout first and refuses as a retryable `degraded`", async () => {
    const r = heldRowClient();
    const outcome = await withTenantContext(r.client, tenant, async () => service().update(WORKSPACE, { name: "x" }, undefined)).then(
      () => "served",
      (error: unknown) => error,
    );
    expectBoundedFirst(r);
    expect(outcome).toMatchObject({ code: "degraded" });
  });

  it("D-1 AC-bound-suspend . WorkspacesService.suspend sets lock_timeout first and refuses as a retryable `degraded`", async () => {
    const r = heldRowClient();
    const outcome = await service().suspend(poolOf(r.client), WORKSPACE).then(() => "served", (error: unknown) => error);
    expectBoundedFirst(r);
    expect(outcome).toMatchObject({ code: "degraded" });
  });

  it("D-1 AC-bound-bump . WorkspacesService.bumpEntitlementVersion sets lock_timeout first and refuses as a retryable `degraded`", async () => {
    const r = heldRowClient();
    const outcome = await service().bumpEntitlementVersion(poolOf(r.client), WORKSPACE).then(() => "served", (error: unknown) => error);
    expectBoundedFirst(r);
    expect(outcome).toMatchObject({ code: "degraded" });
  });

  it("D-1 AC-bound-apply-plan . applyPlanChange (worker plan-set path) sets lock_timeout first and refuses with a typed busy error", async () => {
    const r = heldRowClient();
    const outcome = await applyPlanChange(r.client, WORKSPACE, planKeyOnly("growth"), { requestId: "R", operator: "test", reason: "test" }).then(
      () => "served",
      (error: unknown) => error,
    );
    expectBoundedFirst(r);
    expect(outcome).toMatchObject({ name: "WorkspaceLockBusyError" });
  });

  it("D-1 AC-bound-retention . retention's requestWorkspaceDeletion sets lock_timeout first and refuses with a typed busy error", async () => {
    const r = heldRowClient();
    const outcome = await requestWorkspaceDeletion(r.client, WORKSPACE).then(() => "served", (error: unknown) => error);
    expectBoundedFirst(r);
    expect(outcome).toMatchObject({ name: "WorkspaceLockBusyError" });
  });

  it("D-1 AC-bound-other-errors . a failure that is not a lock timeout still propagates unchanged", async () => {
    const failure = Object.assign(new Error("deadlock detected"), { code: "40P01" });
    const client = {
      query: async (sql: string) => {
        if (/FOR UPDATE|UPDATE workspaces/iu.test(sql) && !/set_config/iu.test(sql)) throw failure;
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    } as unknown as ClientBase;
    expect(await service().suspend(poolOf(client), WORKSPACE).then(() => "served", (e: unknown) => e)).toBe(failure);
  });
});
