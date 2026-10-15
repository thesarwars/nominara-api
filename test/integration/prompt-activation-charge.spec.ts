import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivatePromptsPreviewResponse, ActivatePromptsResponse, PromptResponse } from "../../contracts/prompts/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { resolveEntitlements } from "../../src/lib/entitlements/resolution.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { PromptActivationService } from "../../src/modules/prompts/activation.service.js";
import { PromptLifecycleService } from "../../src/modules/prompts/lifecycle.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// STORY-046 AC3 — the activation charge, against a real database.
//
// THE RULE UNDER TEST (owner decision 2026-10-14, plans-and-entitlements.md
// §4): a generated prompt is charged ONCE, at the first activation beyond the
// project's free `prompts.free_at_creation` (10); the price is
// `prompts.credits_per_generated`. A rejected candidate, a manually typed
// prompt, a re-activation and a replay are free. Every scenario here is a WHERE
// clause, a lock or a rollback, so none of it is provable without Postgres.

const GROWTH_FREE = 10;

describe("STORY-046 · the activation charge", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let actorId: string;

  const resolver = {
    resolveForWorkspace: async (id: string) => resolveEntitlements(db, id),
    resolve: async (id: string) => resolveEntitlements(db, id),
  } as unknown as EntitlementResolver;
  // Records the jobs a debit asks for. `visibleElsewhere` is read from a DIFFERENT connection at enqueue time:
  // it is true only once the request's transaction has committed.
  const enqueued: { name: string; workspaceId: string; idempotencyKey: string; visibleElsewhere: boolean }[] = [];
  const producer = {
    enqueueTenantJob: vi.fn(async (name: string, ws: string, _payload: Record<string, unknown>, options: { idempotencyKey: string }) => {
      const seen = await probe.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [ws]);
      enqueued.push({ name, workspaceId: ws, idempotencyKey: options.idempotencyKey, visibleElsewhere: (seen.rowCount ?? 0) > 0 });
      return {} as never;
    }),
  } as unknown as QueueProducer;
  let probe: Client;
  const activation = new PromptActivationService(resolver, producer);
  const lifecycle = new PromptLifecycleService(resolver, producer);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
  }, 300_000);

  afterAll(async () => {
    await probe.end();
    await db.end();
    await container.stop();
  });

  async function seedWorkspace(planKey: string, included: number | null): Promise<void> {
    await db.query("TRUNCATE credit_ledger, credit_wallets, tracked_prompts, projects, workspaces CASCADE");
    await db.query("TRUNCATE users CASCADE");
    actorId = (
      await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])
    ).rows[0].id;
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,$3,'UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
      planKey,
    ]);
    if (included !== null) {
      await db.query(
        `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
         VALUES ($1,$2,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)`,
        [workspaceId, included],
      );
    }
  }

  beforeEach(async () => {
    enqueued.length = 0;
    await seedWorkspace("growth", 100);
    // Restore the seeded schedule: one test overrides it.
    await db.query(
      `UPDATE plans SET entitlements = jsonb_set(jsonb_set(entitlements, '{"prompts.credits_per_generated","value"}', '1'),
                                                  '{"prompts.free_at_creation","value"}', '10')
        WHERE key = 'growth'`,
    );
  });

  async function seedProject(): Promise<string> {
    const project = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence)
       VALUES ($1,$2,'P',$3,'https://e.test','e.test','active','weekly')`,
      [project, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    return project;
  }

  interface SeedOptions {
    readonly status?: "active" | "paused" | "archived";
    readonly source?: "generated" | "manual";
    /** Pretend the prompt has been activated before (free), as the migration backfill does. */
    readonly activatedBefore?: boolean;
    readonly deleted?: boolean;
  }

  async function seedPrompts(project: string, count: number, options: SeedOptions = {}): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID();
      ids.push(id);
      const text = `prompt ${randomUUID()}`;
      await db.query(
        `INSERT INTO tracked_prompts
           (id, workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status, generation_source)
         VALUES ($1,$2,$3,$4::text,sha256(convert_to($4::text,'UTF8')),'recommendation','consideration',$5,$6)`,
        [id, workspaceId, project, text, options.status ?? "archived", options.source ?? "generated"],
      );
      if (options.activatedBefore === true) {
        await db.query("UPDATE tracked_prompts SET first_activated_at = now() WHERE id = $1", [id]);
      }
      if (options.deleted === true) await db.query("UPDATE tracked_prompts SET deleted_at = now() WHERE id = $1", [id]);
    }
    return ids;
  }

  async function asTenant<T>(fn: () => Promise<T>): Promise<T> {
    const c = new Client({ connectionString: container.getConnectionUri() });
    await c.connect();
    await c.query("SET ROLE nominara_app");
    try {
      return await withTenantContext(c, { workspaceId, actorId }, fn);
    } finally {
      await c.end();
    }
  }

  /** `confirmed` is the raw `X-Nominara-Confirmed-Credits` header value, or absent. */
  const activate = (project: string, ids: string[], confirmed?: string): Promise<ActivatePromptsResponse> =>
    asTenant(() => activation.activate(project, { prompt_ids: ids }, confirmed));
  const patch = (
    id: string,
    body: { status?: "active" | "paused" | "archived"; text?: string; is_priority?: boolean },
    confirmed?: string,
  ): Promise<PromptResponse> => asTenant(() => lifecycle.update(id, body, confirmed));
  const preview = (project: string, ids: string[]): Promise<ActivatePromptsPreviewResponse> =>
    asTenant(() => activation.preview(project, { prompt_ids: ids }));
  const codeOf = (error: unknown): string | undefined => (error as { code?: string }).code;
  const settleJobs = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

  /**
   * The honest client: asks the server for the price, then echoes exactly that figure (owner decision 2026-10-15).
   * The older scenarios are about the charge arithmetic, not the confirmation, so they go through this.
   */
  const activateQuoted = async (project: string, ids: string[]): Promise<ActivatePromptsResponse> =>
    activate(project, ids, String((await preview(project, ids)).credits));
  /** The loser of a race is told its quote is stale (409 price_changed); an honest client re-quotes and tries once more. */
  async function requotingOnPriceChange<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (codeOf(error) !== "price_changed") throw error;
      return attempt();
    }
  }
  const patchQuoted = async (
    id: string,
    body: { status?: "active" | "paused" | "archived"; text?: string; is_priority?: boolean },
  ): Promise<PromptResponse> => {
    const project = (await db.query("SELECT project_id FROM tracked_prompts WHERE id=$1", [id])).rows[0].project_id as string;
    return patch(id, body, String((await preview(project, [id])).credits));
  };

  /**
   * Run calls concurrently and wait for ALL of them, then surface the first failure.
   *
   * `Promise.all` rejects as soon as one call does and leaves the others in flight, still
   * holding the project row lock; the next test's TRUNCATE then queues behind that lock on the
   * same `db` connection the in-flight call needs to resolve entitlements, and the suite hangs
   * instead of failing. Found by running the mutation battery, where a broken rule made one
   * of two concurrent calls throw.
   */
  async function concurrently<T extends readonly unknown[]>(...calls: { [K in keyof T]: Promise<T[K]> }): Promise<T> {
    const settled = await Promise.allSettled(calls);
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed !== undefined) throw failed.reason;
    return settled.map((r) => (r as PromiseFulfilledResult<unknown>).value) as unknown as T;
  }

  async function wallet() {
    const row = (await db.query("SELECT included_balance, purchased_balance, reserved, lifetime_spent FROM credit_wallets WHERE workspace_id=$1", [workspaceId])).rows[0];
    return row === undefined
      ? null
      : { included: Number(row.included_balance), reserved: Number(row.reserved), spent: Number(row.lifetime_spent) };
  }

  async function ledger() {
    return (
      await db.query(
        `SELECT entry_type, action_code, credits::int AS credits, project_id, actor_id, actor_type, idempotency_key
           FROM credit_ledger WHERE workspace_id=$1 AND entry_type IN ('reserve','commit','release') ORDER BY seq`,
        [workspaceId],
      )
    ).rows;
  }

  async function promptRow(id: string) {
    return (await db.query("SELECT status, first_activated_at, activation_credits FROM tracked_prompts WHERE id=$1", [id])).rows[0];
  }

  // -------------------------------------------------------------------------
  // Scenario 2 — the charge matches the activated number.
  // -------------------------------------------------------------------------

  it("scenario 2 — activating twelve generated prompts on a fresh project charges the two beyond the free ten", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const result = await activateQuoted(project, ids);

    expect(result.summary.activated).toBe(12);
    expect(result.prompts_active).toBe(12);
    expect(result.credits_charged).toBe(2);
    expect(await wallet()).toEqual({ included: 98, reserved: 0, spent: 2 });
  });

  it("scenario 2 — the debit is a reserve and a commit under action prompt_activate, naming the project and the actor", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    await activateQuoted(project, ids);

    const rows = await ledger();
    expect(rows.map((r) => [r.entry_type, r.action_code, r.credits])).toEqual([
      ["reserve", "prompt_activate", 2],
      ["commit", "prompt_activate", 2],
    ]);
    expect(rows[1]).toMatchObject({ project_id: project, actor_id: actorId, actor_type: "user" });
  });

  it("scenario 2 — the once-per-prompt fact is durable: each activated prompt records when, and what it cost", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    await activateQuoted(project, ids);

    const rows = await Promise.all(ids.map(promptRow));
    expect(rows.every((r) => r.first_activated_at !== null)).toBe(true);
    expect(rows.reduce((sum, r) => sum + Number(r.activation_credits), 0)).toBe(2);
    expect(rows.filter((r) => Number(r.activation_credits) === 1)).toHaveLength(2);
  });

  it("scenario 2 — exactly the free allowance (ten) is free: no wallet movement and no ledger row at all", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, GROWTH_FREE);

    const result = await activateQuoted(project, ids);

    expect(result.credits_charged).toBe(0);
    expect(await wallet()).toEqual({ included: 100, reserved: 0, spent: 0 });
    expect(await ledger()).toEqual([]);
  });

  it("scenario 2 — the free allowance is PER PROJECT: a second project gets its own ten", async () => {
    const first = await seedProject();
    const second = await seedProject();
    await activateQuoted(first, await seedPrompts(first, 10));

    const result = await activateQuoted(second, await seedPrompts(second, 10));

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("scenario 2 — the price is read from prompts.credits_per_generated, not written in code", async () => {
    await db.query(
      `UPDATE plans SET entitlements = jsonb_set(entitlements, '{"prompts.credits_per_generated","value"}', '3') WHERE key='growth'`,
    );
    const project = await seedProject();

    const result = await activateQuoted(project, await seedPrompts(project, 12));

    expect(result.credits_charged).toBe(6);
    expect((await wallet())?.included).toBe(94);
  });

  it("scenario 2 — the free allowance is read from prompts.free_at_creation, not written in code", async () => {
    await db.query(
      `UPDATE plans SET entitlements = jsonb_set(entitlements, '{"prompts.free_at_creation","value"}', '4') WHERE key='growth'`,
    );
    const project = await seedProject();

    const result = await activateQuoted(project, await seedPrompts(project, 6));

    expect(result.credits_charged).toBe(2);
  });

  it("scenario 2 — a wallet that does not exist yet is provisioned on demand and charged", async () => {
    await seedWorkspace("growth", null);
    const project = await seedProject();

    const result = await activateQuoted(project, await seedPrompts(project, 11));

    expect(result.credits_charged).toBe(1);
    const w = await wallet();
    expect(w?.spent).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 3 — a rejected candidate is never charged.
  // -------------------------------------------------------------------------

  it("scenario 3 — candidates the customer did not name are not charged and stay archived", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 15);

    const result = await activateQuoted(project, ids.slice(0, 11));

    expect(result.credits_charged).toBe(1);
    for (const rejected of ids.slice(11)) {
      expect(await promptRow(rejected)).toMatchObject({ status: "archived", first_activated_at: null, activation_credits: 0 });
    }
    expect((await wallet())?.spent).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Scenario 5 — an archived candidate activated later.
  // -------------------------------------------------------------------------

  it("scenario 5 — a never-activated archived candidate is charged ONCE, at its first activation beyond the free ten", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 11);
    await activateQuoted(project, ids.slice(0, 10));

    const result = await activateQuoted(project, ids.slice(10));

    expect(result.credits_charged).toBe(1);
    expect((await wallet())?.spent).toBe(1);
  });

  it("scenario 5 — re-activating a prompt that was already charged (archived then activated again) is free", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 11);
    await activateQuoted(project, ids);
    const charged = (await Promise.all(ids.map(async (id) => ({ id, ...(await promptRow(id)) })))).find((r) => Number(r.activation_credits) === 1)!;

    await patchQuoted(charged.id, { status: "archived" });
    const result = await activateQuoted(project, [charged.id]);

    expect(result.credits_charged).toBe(0);
    expect((await wallet())?.spent).toBe(1);
    expect((await ledger()).filter((r) => r.entry_type === "commit")).toHaveLength(1);
  });

  it("scenario 5 — re-activating a prompt that was FREE the first time is still free, and does not eat a second free slot", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 10);
    await activateQuoted(project, ids);
    await patchQuoted(ids[0]!, { status: "archived" });
    await activateQuoted(project, [ids[0]!]);
    const [extra] = await seedPrompts(project, 1);

    const result = await activateQuoted(project, [extra!]);

    // Ten distinct prompts have been activated; the eleventh pays.
    expect(result.credits_charged).toBe(1);
  });

  it("scenario 5 — pausing and resuming a charged prompt is free", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 11);
    await activateQuoted(project, ids);

    for (const id of ids) {
      await patchQuoted(id, { status: "paused" });
      const back = await patchQuoted(id, { status: "active" });
      expect(back.credits_charged).toBe(0);
    }
    expect((await wallet())?.spent).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Manual prompts — 0, and they do not eat the free ten.
  // -------------------------------------------------------------------------

  it("scenario 8 — a manually typed prompt is never charged, even beyond the free ten", async () => {
    const project = await seedProject();
    await activateQuoted(project, await seedPrompts(project, 10));
    const manual = await seedPrompts(project, 3, { source: "manual" });

    const result = await activateQuoted(project, manual);

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("scenario 8 — manual prompts do not consume the free ten", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { source: "manual", status: "active", activatedBefore: true });

    const result = await activateQuoted(project, await seedPrompts(project, 10));

    expect(result.credits_charged).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 13 — replay.
  // -------------------------------------------------------------------------

  it("scenario 13 — replaying a charged activation charges nothing the second time", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);
    await activateQuoted(project, ids);

    const replay = await activateQuoted(project, ids);

    expect(replay.credits_charged).toBe(0);
    expect(replay.summary).toMatchObject({ activated: 0, already_active: 12 });
    expect(await wallet()).toEqual({ included: 98, reserved: 0, spent: 2 });
    expect(await ledger()).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Refusals charge nothing and activate nothing.
  // -------------------------------------------------------------------------

  it("scenario 4 — a refusal at the cap leaves no ledger row, no wallet movement and no activated prompt", async () => {
    await seedWorkspace("starter", 100);
    const project = await seedProject();
    // 30 is starter's cap, and all thirty were activated before: the free ten are long gone.
    await seedPrompts(project, 30, { status: "active", activatedBefore: true });
    const ids = await seedPrompts(project, 2);

    const error = await activateQuoted(project, ids).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("entitlement_exceeded");
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toEqual({ included: 100, reserved: 0, spent: 0 });
    for (const id of ids) expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null });
  });

  it("scenario 2 — insufficient credits refuses with 402, charges nothing and activates nothing", async () => {
    await seedWorkspace("growth", 1);
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const error = await activateQuoted(project, ids).catch((e: unknown) => e as { code?: string; details?: { required?: number; available?: number } });

    expect((error as { code?: string }).code).toBe("insufficient_credits");
    expect((error as { details?: { required?: number } }).details?.required).toBe(2);
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toEqual({ included: 1, reserved: 0, spent: 0 });
    for (const id of ids) expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null, activation_credits: 0 });
    expect((await db.query("SELECT prompts_active FROM projects WHERE id=$1", [project])).rows[0].prompts_active).toBe(0);
  });

  it("scenario 2 — a wallet holding exactly the price is enough", async () => {
    await seedWorkspace("growth", 2);
    const project = await seedProject();

    const result = await activateQuoted(project, await seedPrompts(project, 12));

    expect(result.credits_charged).toBe(2);
    expect(await wallet()).toEqual({ included: 0, reserved: 0, spent: 2 });
  });

  it("scenario 2 — credits that are reserved for another action are not available to an activation", async () => {
    await db.query("UPDATE credit_wallets SET reserved = 99 WHERE workspace_id=$1", [workspaceId]);
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const error = await activateQuoted(project, ids).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("insufficient_credits");
  });

  it("scenario 4 — a prompt id from another project is refused before anything is charged", async () => {
    const project = await seedProject();
    const other = await seedProject();
    const ids = await seedPrompts(project, 11);
    const foreign = await seedPrompts(other, 1);

    const error = await activateQuoted(project, [...ids, ...foreign]).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("validation_failed");
    expect(await ledger()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Scenario 12 — concurrency.
  // -------------------------------------------------------------------------

  it("scenario 12 — two concurrent activations of the SAME prompts charge once", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const [a, b] = await concurrently(activateQuoted(project, ids), activateQuoted(project, ids));

    expect([a.credits_charged, b.credits_charged].sort()).toEqual([0, 2]);
    expect(await wallet()).toEqual({ included: 98, reserved: 0, spent: 2 });
    expect((await ledger()).filter((r) => r.entry_type === "commit")).toHaveLength(1);
  });

  it("scenario 12 — two concurrent activations of DIFFERENT prompts share ONE free allowance", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const [a, b] = await concurrently(
      requotingOnPriceChange(() => activateQuoted(project, ids.slice(0, 6))),
      requotingOnPriceChange(() => activateQuoted(project, ids.slice(6))),
    );

    expect(a.credits_charged + b.credits_charged).toBe(2);
    expect((await wallet())?.spent).toBe(2);
  });

  it("scenario 12 — an activation and the PATCH door racing for the last free slot charge exactly one of them", async () => {
    const project = await seedProject();
    await seedPrompts(project, 9, { status: "active", activatedBefore: true });
    const [viaPost, viaPatch] = await seedPrompts(project, 2);

    const [a, b] = await concurrently(
      requotingOnPriceChange(() => activateQuoted(project, [viaPost!])),
      requotingOnPriceChange(() => patchQuoted(viaPatch!, { status: "active" })),
    );

    expect(a.credits_charged + b.credits_charged).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The second door — PATCH /prompts/{id}.
  // -------------------------------------------------------------------------

  it("PATCH — leaving archived beyond the free ten charges the same price and reports it", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const result = await patchQuoted(candidate!, { status: "active" });

    expect(result.credits_charged).toBe(1);
    expect((await ledger()).map((r) => [r.entry_type, r.action_code, r.credits])).toEqual([
      ["reserve", "prompt_activate", 1],
      ["commit", "prompt_activate", 1],
    ]);
  });

  it("PATCH — archived to PAUSED is an activation too: the slot is taken, so the charge is not dodged by pausing first", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const paused = await patchQuoted(candidate!, { status: "paused" });
    const resumed = await patchQuoted(candidate!, { status: "active" });

    expect(paused.credits_charged).toBe(1);
    expect(resumed.credits_charged).toBe(0);
    expect((await wallet())?.spent).toBe(1);
  });

  it("PATCH — within the free ten it is free and writes no ledger row", async () => {
    const project = await seedProject();
    const [candidate] = await seedPrompts(project, 1);

    const result = await patchQuoted(candidate!, { status: "active" });

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("PATCH — a refusal for insufficient credits leaves the prompt archived and the ledger empty", async () => {
    await seedWorkspace("growth", 0);
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const error = await patchQuoted(candidate!, { status: "active" }).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("insufficient_credits");
    expect(await promptRow(candidate!)).toMatchObject({ status: "archived", first_activated_at: null });
    expect(await ledger()).toEqual([]);
  });

  it("PATCH — archiving never charges", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [active] = await seedPrompts(project, 1, { status: "active", activatedBefore: true });

    const archived = await patchQuoted(active!, { status: "archived" });

    expect(archived.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("PATCH — a change that leaves the prompt archived (same status, a priority flag, a reworded text) charges nothing and records nothing", async () => {
    // Business: the priority flag needs `scan.priority_subset_size`, which growth does not have.
    await seedWorkspace("business", 100);
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [sameStatus, flagged, reworded] = await seedPrompts(project, 3);

    const a = await patchQuoted(sameStatus!, { status: "archived" });
    const b = await asTenant(() => lifecycle.update(flagged!, { is_priority: true }));
    const c = await patchQuoted(reworded!, { text: "reworded but still a candidate" });

    expect([a.credits_charged, b.credits_charged, c.credits_charged]).toEqual([0, 0, 0]);
    expect(await ledger()).toEqual([]);
    for (const id of [sameStatus!, flagged!, c.prompt_id]) {
      expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null, activation_credits: 0 });
    }
  });

  it("PATCH — a change on a prompt that is NOT archived never charges, even when its row carries no activation fact", async () => {
    // A row written by something other than this service (a seed, a restore) can be active with
    // first_activated_at NULL. Pausing it is not an activation: only LEAVING `archived` is.
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [orphan] = await seedPrompts(project, 1, { status: "active" });

    const paused = await patchQuoted(orphan!, { status: "paused" });

    expect(paused.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
    expect(await promptRow(orphan!)).toMatchObject({ status: "paused", first_activated_at: null });
  });

  it("PATCH — editing a CHARGED prompt's text carries the fact to the new row: reactivating it is free", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 11);
    await activateQuoted(project, ids);
    const charged = (await Promise.all(ids.map(async (id) => ({ id, ...(await promptRow(id)) })))).find((r) => Number(r.activation_credits) === 1)!;

    const edited = await patchQuoted(charged.id, { text: "a reworded question" });
    await patchQuoted(edited.prompt_id, { status: "archived" });
    const back = await patchQuoted(edited.prompt_id, { status: "active" });

    expect(edited.credits_charged).toBe(0);
    expect(back.credits_charged).toBe(0);
    expect((await wallet())?.spent).toBe(1);
    expect(await promptRow(edited.prompt_id)).toMatchObject({ activation_credits: 1 });
  });

  it("PATCH — an edit does not count one question twice against the free ten", async () => {
    const project = await seedProject();
    const nine = await seedPrompts(project, 9);
    await activateQuoted(project, nine);
    await patchQuoted(nine[0]!, { text: "the same question reworded" });
    const [tenth] = await seedPrompts(project, 1);

    const result = await activateQuoted(project, [tenth!]);

    // Nine questions, one of them reworded: the tenth is still inside the allowance.
    expect(result.credits_charged).toBe(0);
  });

  it("PATCH — editing an ARCHIVED, never-activated candidate while activating it charges once, on the new row", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const edited = await patchQuoted(candidate!, { text: "reworded and activated", status: "active" });

    expect(edited.credits_charged).toBe(1);
    expect(await promptRow(edited.prompt_id)).toMatchObject({ status: "active", activation_credits: 1 });
  });

  // -------------------------------------------------------------------------
  // The free count cannot be recycled.
  // -------------------------------------------------------------------------

  it("scenario 2 — deleting an activated prompt does not hand its free slot back", async () => {
    const project = await seedProject();
    await seedPrompts(project, 9, { status: "active", activatedBefore: true });
    await seedPrompts(project, 1, { status: "archived", activatedBefore: true, deleted: true });
    const [next] = await seedPrompts(project, 1);

    const result = await activateQuoted(project, [next!]);

    expect(result.credits_charged).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Second-engineer review 1 - a SUPERSEDED row is not a door into activation.
  // `countFreeAllowanceUsed` counts chain heads only, so a row that is no longer a head
  // must be refused at BOTH doors or the free ten can be recycled.
  // -------------------------------------------------------------------------

  async function supersededConflict(call: Promise<unknown>): Promise<{ code?: string; details?: { reason?: string } }> {
    return (await call.then(
      () => ({ code: "no error" }),
      (e: unknown) => e,
    )) as { code?: string; details?: { reason?: string } };
  }

  it("review 1 (scenario A) - POST refuses a superseded archived row, so X, Y, Z cannot dodge the free ten", async () => {
    const project = await seedProject();
    await activate(project, await seedPrompts(project, 9)); // nine heads, all free
    const originals = await seedPrompts(project, 3);
    const heads: string[] = [];
    for (const id of originals) heads.push((await patch(id, { text: `reworded ${id}` })).prompt_id); // stays archived; the original is now superseded

    for (const old of originals) {
      const refusal = await supersededConflict(activate(project, [old]));
      expect(refusal).toMatchObject({ code: "conflict", details: { reason: "prompt_superseded" } });
      expect(await promptRow(old)).toMatchObject({ status: "archived", first_activated_at: null });
    }
    expect(await ledger()).toEqual([]);

    // The live rows still obey the allowance: the tenth question is free, the eleventh is not.
    expect((await activate(project, [heads[0]!])).credits_charged).toBe(0);
    expect((await activate(project, [heads[1]!], "1")).credits_charged).toBe(1);
  });

  it("review 1 - POST refuses the WHOLE batch when one of its rows is superseded: nothing is charged or activated", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [old] = await seedPrompts(project, 1);
    await patch(old!, { text: "the new wording" });
    const fresh = await seedPrompts(project, 2);

    const refusal = await supersededConflict(activate(project, [...fresh, old!], "2"));

    expect(refusal).toMatchObject({ code: "conflict", details: { reason: "prompt_superseded" } });
    expect(await ledger()).toEqual([]);
    for (const id of fresh) expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null });
  });

  it("review 1 (scenario B) - PATCH with new text on a superseded row is refused: one question never gets two heads", async () => {
    const project = await seedProject();
    const [a] = await seedPrompts(project, 1);
    await activate(project, [a!]);
    const b = await patch(a!, { text: "B" });

    const refusal = await supersededConflict(patch(a!, { text: "C" }));

    expect(refusal).toMatchObject({ code: "conflict", details: { reason: "prompt_superseded" } });
    const rows = (await db.query("SELECT id, superseded_by, first_activated_at FROM tracked_prompts WHERE project_id=$1", [project])).rows;
    expect(rows).toHaveLength(2); // no C was written
    expect(rows.find((r) => r.id === a)!.superseded_by).toBe(b.prompt_id); // and A still points at B
    const heads = rows.filter((r) => r.superseded_by === null && r.first_activated_at !== null);
    expect(heads).toHaveLength(1); // the question spends ONE free slot
  });

  it("review 1 - PATCH of a status on a superseded archived row is refused (the PATCH door of scenario A)", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [old] = await seedPrompts(project, 1);
    await patch(old!, { text: "the new wording" });

    const refusal = await supersededConflict(patch(old!, { status: "active" }, "1"));

    expect(refusal).toMatchObject({ code: "conflict", details: { reason: "prompt_superseded" } });
    expect(await promptRow(old!)).toMatchObject({ status: "archived", first_activated_at: null });
    expect(await ledger()).toEqual([]);
  });

  it("review 1 - a flag-only PATCH of a superseded row is refused too: the row is history, not a live prompt", async () => {
    const project = await seedProject();
    const [old] = await seedPrompts(project, 1);
    await patch(old!, { text: "the new wording" });

    const refusal = await supersededConflict(patch(old!, { is_priority: true }));

    expect(refusal).toMatchObject({ code: "conflict", details: { reason: "prompt_superseded" } });
  });

  // -------------------------------------------------------------------------
  // Second-engineer review 2 - the inline debit asks for an auto top-up, after the commit.
  // -------------------------------------------------------------------------

  const configureAutoTopup = (threshold: number): Promise<unknown> =>
    db.query(
      `UPDATE credit_wallets SET auto_topup_enabled = true, auto_topup_pack_key = 'starter_vault', auto_topup_threshold = $2, auto_topup_max_per_cycle = 3
        WHERE workspace_id = $1`,
      [workspaceId, threshold],
    );

  it("review 2 - a charged activation that leaves the wallet below the threshold queues billing.auto_topup, and only after the commit", async () => {
    await configureAutoTopup(99); // 100 - 2 = 98 < 99
    const project = await seedProject();

    await activate(project, await seedPrompts(project, 12), "2");
    await settleJobs();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ name: "billing.auto_topup", workspaceId, visibleElsewhere: true });
    expect(enqueued[0]!.idempotencyKey.startsWith(`autotopup:${workspaceId}:`)).toBe(true);
  });

  it("review 2 - the PATCH door requests it as well", async () => {
    await configureAutoTopup(99);
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    await db.query("UPDATE credit_wallets SET included_balance = 99 WHERE workspace_id = $1", [workspaceId]);
    const [candidate] = await seedPrompts(project, 1);

    await patch(candidate!, { status: "active" }, "1"); // 99 - 1 = 98 < 99
    await settleJobs();

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({ name: "billing.auto_topup", workspaceId, visibleElsewhere: true });
  });

  it("review 2 - nothing is queued when the transaction rolls back after the debit", async () => {
    await configureAutoTopup(99);
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    await expect(
      asTenant(async () => {
        await activation.activate(project, { prompt_ids: ids }, "2");
        throw new Error("rolled back after the debit");
      }),
    ).rejects.toThrow(/rolled back/);
    await settleJobs();

    expect(enqueued).toEqual([]);
    expect(await ledger()).toEqual([]);
  });

  it("review 2 - nothing is queued when the debit is refused for insufficient credits", async () => {
    await db.query("UPDATE credit_wallets SET included_balance = 1 WHERE workspace_id = $1", [workspaceId]);
    await configureAutoTopup(99);
    const project = await seedProject();

    const error = await activate(project, await seedPrompts(project, 12), "2").catch((e: unknown) => e);
    await settleJobs();

    expect(codeOf(error)).toBe("insufficient_credits");
    expect(enqueued).toEqual([]);
  });

  it("review 2 - nothing is queued when the balance stays at or above the threshold, or when the activation is free", async () => {
    const project = await seedProject();
    await configureAutoTopup(98); // 100 - 2 = 98, NOT below 98
    await activate(project, await seedPrompts(project, 12), "2");
    await settleJobs();
    expect(enqueued).toEqual([]);

    await configureAutoTopup(10_000);
    const other = await seedProject();
    await activate(other, await seedPrompts(other, 3)); // free: no debit, so no request
    await settleJobs();
    expect(enqueued).toEqual([]);
  });

  it("review 2 - a service built without a queue producer still charges (the producer is optional, as in CreditInterceptor)", async () => {
    await configureAutoTopup(99);
    const project = await seedProject();
    const bare = new PromptActivationService(resolver);

    const ids = await seedPrompts(project, 12);
    const charged = await asTenant(() => bare.activate(project, { prompt_ids: ids }, "2"));

    expect(charged.credits_charged).toBe(2);
    expect(enqueued).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Owner decision 2026-10-15, option C - a price quote is required.
  // -------------------------------------------------------------------------

  it("quote - the preview equals what the activation then charges, and says how the figure is made up", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const quote = await preview(project, ids);
    const result = await activate(project, ids, String(quote.credits));

    expect(quote).toEqual({ credits: 2, prompts: { requested: 12, already_active: 0, free: 10, charged: 2 }, credits_charged: 0 });
    expect(result.credits_charged).toBe(quote.credits);
  });

  it("quote - the preview counts prompts that are already active as neither free nor charged", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);
    await activate(project, ids.slice(0, 5));

    const quote = await preview(project, ids);

    expect(quote.prompts).toEqual({ requested: 12, already_active: 5, free: 5, charged: 2 });
    expect(quote.credits).toBe(2);
  });

  it("quote - the preview follows the plan's price", async () => {
    await db.query(`UPDATE plans SET entitlements = jsonb_set(entitlements, '{"prompts.credits_per_generated","value"}', '3') WHERE key='growth'`);
    const project = await seedProject();

    expect((await preview(project, await seedPrompts(project, 12))).credits).toBe(6);
  });

  it("quote - the preview is read-only: no wallet is provisioned, nothing is reserved, no ledger row, nothing activated", async () => {
    await seedWorkspace("growth", null); // no wallet row at all
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const quote = await preview(project, ids);

    expect(quote.credits).toBe(2);
    expect(await wallet()).toBeNull();
    expect(await ledger()).toEqual([]);
    expect(enqueued).toEqual([]);
    for (const id of ids) expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null, activation_credits: 0 });
    expect((await db.query("SELECT prompts_active FROM projects WHERE id=$1", [project])).rows[0].prompts_active).toBe(0);
  });

  it("quote - the preview leaves an existing wallet untouched", async () => {
    const project = await seedProject();
    await preview(project, await seedPrompts(project, 12));
    expect(await wallet()).toEqual({ included: 100, reserved: 0, spent: 0 });
    expect(await ledger()).toEqual([]);
  });

  it("quote - the preview refuses a prompt from another project and a superseded one, as the activation does", async () => {
    const project = await seedProject();
    const other = await seedProject();
    const [foreign] = await seedPrompts(other, 1);
    const [old] = await seedPrompts(project, 1);
    await patch(old!, { text: "reworded" });

    expect(codeOf(await preview(project, [foreign!]).catch((e: unknown) => e))).toBe("validation_failed");
    expect(codeOf(await preview(project, [old!]).catch((e: unknown) => e))).toBe("conflict");
  });

  it("quote - a STALE figure is refused with price_changed naming both figures; no ledger row, nothing activated", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const error = await activate(project, ids, "1").catch((e: unknown) => e as { code?: string; details?: unknown });

    expect(codeOf(error)).toBe("price_changed");
    expect((error as { details?: unknown }).details).toMatchObject({ shown: 1, recomputed: 2 });
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toEqual({ included: 100, reserved: 0, spent: 0 });
    for (const id of ids) expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null });
  });

  it("quote - a figure that is too HIGH is refused as well: the check is equality, not a ceiling", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    expect(codeOf(await activate(project, ids, "3").catch((e: unknown) => e))).toBe("price_changed");
    expect(await ledger()).toEqual([]);
  });

  it("quote - a MISSING header on a charged activation is refused like the deep-scan route refuses it; no ledger row", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const error = await activate(project, ids).catch((e: unknown) => e);

    expect(codeOf(error)).toBe("validation_failed");
    expect(JSON.stringify((error as { details?: unknown }).details)).toContain("x-nominara-confirmed-credits");
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toEqual({ included: 100, reserved: 0, spent: 0 });
    for (const id of ids) expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null });
  });

  it("quote - a header that is not exactly a non-negative integer is refused, never read leniently", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);
    for (const bad of ["2abc", "2.0", "-2", "", "   ", "two"]) {
      expect(codeOf(await activate(project, ids, bad).catch((e: unknown) => e)), `header ${JSON.stringify(bad)}`).toBe("validation_failed");
    }
    expect(await ledger()).toEqual([]);
  });

  it("quote - a fully FREE activation needs no header", async () => {
    const project = await seedProject();

    const result = await activate(project, await seedPrompts(project, GROWTH_FREE));

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("quote - the figure is recomputed under the project lock: a quote taken before a concurrent activation is stale after it", async () => {
    const project = await seedProject();
    await seedPrompts(project, 9, { status: "active", activatedBefore: true });
    const [p, q] = await seedPrompts(project, 2);
    expect((await preview(project, [p!])).credits).toBe(0);
    expect((await preview(project, [q!])).credits).toBe(0); // both look free: there is one free slot left

    const settled = await Promise.allSettled([activate(project, [p!], "0"), activate(project, [q!], "0")]);

    // Exactly one gets the last free slot. The other would have to pay 1, which is not what its quote said.
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = settled.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(codeOf(refused.reason)).toBe("price_changed");
    expect(await ledger()).toEqual([]);
  });

  it("quote (PATCH door) - the preview equals the charge, and the header is echoed", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const quote = await preview(project, [candidate!]);
    const result = await patch(candidate!, { status: "active" }, String(quote.credits));

    expect(quote.credits).toBe(1);
    expect(result.credits_charged).toBe(1);
  });

  it("quote (PATCH door) - a missing header on a charged activation is refused, with no ledger row", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    expect(codeOf(await patch(candidate!, { status: "active" }).catch((e: unknown) => e))).toBe("validation_failed");
    expect(await ledger()).toEqual([]);
    expect(await promptRow(candidate!)).toMatchObject({ status: "archived", first_activated_at: null });
  });

  it("quote (PATCH door) - a stale figure is refused with price_changed naming both figures; the prompt stays archived", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const error = await patch(candidate!, { status: "paused" }, "0").catch((e: unknown) => e as { code?: string; details?: unknown });

    expect(codeOf(error)).toBe("price_changed");
    expect((error as { details?: unknown }).details).toMatchObject({ shown: 0, recomputed: 1 });
    expect(await ledger()).toEqual([]);
    expect(await promptRow(candidate!)).toMatchObject({ status: "archived", first_activated_at: null });
  });

  it("quote (PATCH door) - an edit that also activates is quoted and checked the same way", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    expect(codeOf(await patch(candidate!, { text: "reworded", status: "active" }, "0").catch((e: unknown) => e))).toBe("price_changed");
    const ok = await patch(candidate!, { text: "reworded", status: "active" }, "1");
    expect(ok.credits_charged).toBe(1);
  });

  it("quote (PATCH door) - a free activation, and a change that is not an activation, need no header", async () => {
    const project = await seedProject();
    const [free, other] = await seedPrompts(project, 2);

    expect((await patch(free!, { status: "active" })).credits_charged).toBe(0);
    expect((await patch(other!, { status: "archived" })).credits_charged).toBe(0); // not leaving archived
    expect((await patch(free!, { status: "paused" })).credits_charged).toBe(0); // already activated, so a re-pause is free
  });

  // -------------------------------------------------------------------------
  // Review 4 - POST and PATCH agree on a paused row that carries no activation fact.
  // -------------------------------------------------------------------------

  it("POST - a paused row that carries no activation fact is not an activation: no charge, no fact (the twin of the PATCH case)", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [orphan] = await seedPrompts(project, 1, { status: "paused" });

    const result = await activate(project, [orphan!]);

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
    expect(await promptRow(orphan!)).toMatchObject({ status: "active", first_activated_at: null, activation_credits: 0 });
  });

  // -------------------------------------------------------------------------
  // Review 6 - concurrency at scale.
  // -------------------------------------------------------------------------

  it("review 6 - twenty concurrent activations mixing POST and PATCH on one project: one commit per charged prompt, spent = price x count", async () => {
    await seedWorkspace("growth", 100);
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true }); // the free ten is spent
    const ids = await seedPrompts(project, 20);

    const settled = await Promise.allSettled(
      ids.map((id, i) => (i % 2 === 0 ? activate(project, [id], "1") : patch(id, { status: "active" }, "1"))),
    );

    expect(settled.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason)).toEqual([]);
    const commits = (await ledger()).filter((r) => r.entry_type === "commit");
    expect(commits).toHaveLength(20);
    expect(commits.every((r) => r.credits === 1)).toBe(true);
    expect(await wallet()).toEqual({ included: 80, reserved: 0, spent: 20 });
    for (const id of ids) expect(await promptRow(id)).toMatchObject({ status: "active", activation_credits: 1 });
    expect((await db.query("SELECT prompts_active FROM projects WHERE id=$1", [project])).rows[0].prompts_active).toBe(30);
  });

  it("review 6 - six projects against a wallet that covers three charges: exactly three succeed, three get 402 and leave no ledger row", async () => {
    await seedWorkspace("growth", 3);
    const projects: { project: string; candidate: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const project = await seedProject();
      await seedPrompts(project, 10, { status: "active", activatedBefore: true });
      projects.push({ project, candidate: (await seedPrompts(project, 1))[0]! });
    }

    const settled = await Promise.allSettled(projects.map(({ project, candidate }) => activate(project, [candidate], "1")));

    const refused = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(refused.map((r) => codeOf(r.reason))).toEqual(["insufficient_credits", "insufficient_credits", "insufficient_credits"]);
    expect((await ledger()).map((r) => r.entry_type).sort()).toEqual(["commit", "commit", "commit", "reserve", "reserve", "reserve"]);
    expect(await wallet()).toEqual({ included: 0, reserved: 0, spent: 3 });
    const activated = (await db.query("SELECT count(*)::int AS n FROM tracked_prompts WHERE workspace_id=$1 AND activation_credits = 1", [workspaceId])).rows[0].n;
    expect(activated).toBe(3);
  });
});
