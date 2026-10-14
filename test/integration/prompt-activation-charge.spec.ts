import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActivatePromptsResponse, PromptResponse } from "../../contracts/prompts/index.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import { resolveEntitlements } from "../../src/lib/entitlements/resolution.js";
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
  const activation = new PromptActivationService(resolver);
  const lifecycle = new PromptLifecycleService(resolver);

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 300_000);

  afterAll(async () => {
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

  const activate = (project: string, ids: string[]): Promise<ActivatePromptsResponse> =>
    asTenant(() => activation.activate(project, { prompt_ids: ids }));
  const patch = (id: string, body: { status?: "active" | "paused" | "archived"; text?: string }): Promise<PromptResponse> =>
    asTenant(() => lifecycle.update(id, body));

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

    const result = await activate(project, ids);

    expect(result.summary.activated).toBe(12);
    expect(result.prompts_active).toBe(12);
    expect(result.credits_charged).toBe(2);
    expect(await wallet()).toEqual({ included: 98, reserved: 0, spent: 2 });
  });

  it("scenario 2 — the debit is a reserve and a commit under action prompt_activate, naming the project and the actor", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    await activate(project, ids);

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

    await activate(project, ids);

    const rows = await Promise.all(ids.map(promptRow));
    expect(rows.every((r) => r.first_activated_at !== null)).toBe(true);
    expect(rows.reduce((sum, r) => sum + Number(r.activation_credits), 0)).toBe(2);
    expect(rows.filter((r) => Number(r.activation_credits) === 1)).toHaveLength(2);
  });

  it("scenario 2 — exactly the free allowance (ten) is free: no wallet movement and no ledger row at all", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, GROWTH_FREE);

    const result = await activate(project, ids);

    expect(result.credits_charged).toBe(0);
    expect(await wallet()).toEqual({ included: 100, reserved: 0, spent: 0 });
    expect(await ledger()).toEqual([]);
  });

  it("scenario 2 — the free allowance is PER PROJECT: a second project gets its own ten", async () => {
    const first = await seedProject();
    const second = await seedProject();
    await activate(first, await seedPrompts(first, 10));

    const result = await activate(second, await seedPrompts(second, 10));

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("scenario 2 — the price is read from prompts.credits_per_generated, not written in code", async () => {
    await db.query(
      `UPDATE plans SET entitlements = jsonb_set(entitlements, '{"prompts.credits_per_generated","value"}', '3') WHERE key='growth'`,
    );
    const project = await seedProject();

    const result = await activate(project, await seedPrompts(project, 12));

    expect(result.credits_charged).toBe(6);
    expect((await wallet())?.included).toBe(94);
  });

  it("scenario 2 — the free allowance is read from prompts.free_at_creation, not written in code", async () => {
    await db.query(
      `UPDATE plans SET entitlements = jsonb_set(entitlements, '{"prompts.free_at_creation","value"}', '4') WHERE key='growth'`,
    );
    const project = await seedProject();

    const result = await activate(project, await seedPrompts(project, 6));

    expect(result.credits_charged).toBe(2);
  });

  it("scenario 2 — a wallet that does not exist yet is provisioned on demand and charged", async () => {
    await seedWorkspace("growth", null);
    const project = await seedProject();

    const result = await activate(project, await seedPrompts(project, 11));

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

    const result = await activate(project, ids.slice(0, 11));

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
    await activate(project, ids.slice(0, 10));

    const result = await activate(project, ids.slice(10));

    expect(result.credits_charged).toBe(1);
    expect((await wallet())?.spent).toBe(1);
  });

  it("scenario 5 — re-activating a prompt that was already charged (archived then activated again) is free", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 11);
    await activate(project, ids);
    const charged = (await Promise.all(ids.map(async (id) => ({ id, ...(await promptRow(id)) })))).find((r) => Number(r.activation_credits) === 1)!;

    await patch(charged.id, { status: "archived" });
    const result = await activate(project, [charged.id]);

    expect(result.credits_charged).toBe(0);
    expect((await wallet())?.spent).toBe(1);
    expect((await ledger()).filter((r) => r.entry_type === "commit")).toHaveLength(1);
  });

  it("scenario 5 — re-activating a prompt that was FREE the first time is still free, and does not eat a second free slot", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 10);
    await activate(project, ids);
    await patch(ids[0]!, { status: "archived" });
    await activate(project, [ids[0]!]);
    const [extra] = await seedPrompts(project, 1);

    const result = await activate(project, [extra!]);

    // Ten distinct prompts have been activated; the eleventh pays.
    expect(result.credits_charged).toBe(1);
  });

  it("scenario 5 — pausing and resuming a charged prompt is free", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 11);
    await activate(project, ids);

    for (const id of ids) {
      await patch(id, { status: "paused" });
      const back = await patch(id, { status: "active" });
      expect(back.credits_charged).toBe(0);
    }
    expect((await wallet())?.spent).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Manual prompts — 0, and they do not eat the free ten.
  // -------------------------------------------------------------------------

  it("scenario 8 — a manually typed prompt is never charged, even beyond the free ten", async () => {
    const project = await seedProject();
    await activate(project, await seedPrompts(project, 10));
    const manual = await seedPrompts(project, 3, { source: "manual" });

    const result = await activate(project, manual);

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("scenario 8 — manual prompts do not consume the free ten", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { source: "manual", status: "active", activatedBefore: true });

    const result = await activate(project, await seedPrompts(project, 10));

    expect(result.credits_charged).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Scenario 13 — replay.
  // -------------------------------------------------------------------------

  it("scenario 13 — replaying a charged activation charges nothing the second time", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);
    await activate(project, ids);

    const replay = await activate(project, ids);

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

    const error = await activate(project, ids).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("entitlement_exceeded");
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toEqual({ included: 100, reserved: 0, spent: 0 });
    for (const id of ids) expect(await promptRow(id)).toMatchObject({ status: "archived", first_activated_at: null });
  });

  it("scenario 2 — insufficient credits refuses with 402, charges nothing and activates nothing", async () => {
    await seedWorkspace("growth", 1);
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const error = await activate(project, ids).catch((e: unknown) => e as { code?: string; details?: { required?: number; available?: number } });

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

    const result = await activate(project, await seedPrompts(project, 12));

    expect(result.credits_charged).toBe(2);
    expect(await wallet()).toEqual({ included: 0, reserved: 0, spent: 2 });
  });

  it("scenario 2 — credits that are reserved for another action are not available to an activation", async () => {
    await db.query("UPDATE credit_wallets SET reserved = 99 WHERE workspace_id=$1", [workspaceId]);
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const error = await activate(project, ids).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("insufficient_credits");
  });

  it("scenario 4 — a prompt id from another project is refused before anything is charged", async () => {
    const project = await seedProject();
    const other = await seedProject();
    const ids = await seedPrompts(project, 11);
    const foreign = await seedPrompts(other, 1);

    const error = await activate(project, [...ids, ...foreign]).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("validation_failed");
    expect(await ledger()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Scenario 12 — concurrency.
  // -------------------------------------------------------------------------

  it("scenario 12 — two concurrent activations of the SAME prompts charge once", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const [a, b] = await Promise.all([activate(project, ids), activate(project, ids)]);

    expect([a.credits_charged, b.credits_charged].sort()).toEqual([0, 2]);
    expect(await wallet()).toEqual({ included: 98, reserved: 0, spent: 2 });
    expect((await ledger()).filter((r) => r.entry_type === "commit")).toHaveLength(1);
  });

  it("scenario 12 — two concurrent activations of DIFFERENT prompts share ONE free allowance", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 12);

    const [a, b] = await Promise.all([activate(project, ids.slice(0, 6)), activate(project, ids.slice(6))]);

    expect(a.credits_charged + b.credits_charged).toBe(2);
    expect((await wallet())?.spent).toBe(2);
  });

  it("scenario 12 — an activation and the PATCH door racing for the last free slot charge exactly one of them", async () => {
    const project = await seedProject();
    await seedPrompts(project, 9, { status: "active", activatedBefore: true });
    const [viaPost, viaPatch] = await seedPrompts(project, 2);

    const [a, b] = await Promise.all([activate(project, [viaPost!]), patch(viaPatch!, { status: "active" })]);

    expect(a.credits_charged + b.credits_charged).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The second door — PATCH /prompts/{id}.
  // -------------------------------------------------------------------------

  it("PATCH — leaving archived beyond the free ten charges the same price and reports it", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const result = await patch(candidate!, { status: "active" });

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

    const paused = await patch(candidate!, { status: "paused" });
    const resumed = await patch(candidate!, { status: "active" });

    expect(paused.credits_charged).toBe(1);
    expect(resumed.credits_charged).toBe(0);
    expect((await wallet())?.spent).toBe(1);
  });

  it("PATCH — within the free ten it is free and writes no ledger row", async () => {
    const project = await seedProject();
    const [candidate] = await seedPrompts(project, 1);

    const result = await patch(candidate!, { status: "active" });

    expect(result.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("PATCH — a refusal for insufficient credits leaves the prompt archived and the ledger empty", async () => {
    await seedWorkspace("growth", 0);
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const error = await patch(candidate!, { status: "active" }).catch((e: unknown) => e as { code?: string });

    expect((error as { code?: string }).code).toBe("insufficient_credits");
    expect(await promptRow(candidate!)).toMatchObject({ status: "archived", first_activated_at: null });
    expect(await ledger()).toEqual([]);
  });

  it("PATCH — archiving never charges", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [active] = await seedPrompts(project, 1, { status: "active", activatedBefore: true });

    const archived = await patch(active!, { status: "archived" });

    expect(archived.credits_charged).toBe(0);
    expect(await ledger()).toEqual([]);
  });

  it("PATCH — editing a CHARGED prompt's text carries the fact to the new row: reactivating it is free", async () => {
    const project = await seedProject();
    const ids = await seedPrompts(project, 11);
    await activate(project, ids);
    const charged = (await Promise.all(ids.map(async (id) => ({ id, ...(await promptRow(id)) })))).find((r) => Number(r.activation_credits) === 1)!;

    const edited = await patch(charged.id, { text: "a reworded question" });
    await patch(edited.prompt_id, { status: "archived" });
    const back = await patch(edited.prompt_id, { status: "active" });

    expect(edited.credits_charged).toBe(0);
    expect(back.credits_charged).toBe(0);
    expect((await wallet())?.spent).toBe(1);
    expect(await promptRow(edited.prompt_id)).toMatchObject({ activation_credits: 1 });
  });

  it("PATCH — an edit does not count one question twice against the free ten", async () => {
    const project = await seedProject();
    const nine = await seedPrompts(project, 9);
    await activate(project, nine);
    await patch(nine[0]!, { text: "the same question reworded" });
    const [tenth] = await seedPrompts(project, 1);

    const result = await activate(project, [tenth!]);

    // Nine questions, one of them reworded: the tenth is still inside the allowance.
    expect(result.credits_charged).toBe(0);
  });

  it("PATCH — editing an ARCHIVED, never-activated candidate while activating it charges once, on the new row", async () => {
    const project = await seedProject();
    await seedPrompts(project, 10, { status: "active", activatedBefore: true });
    const [candidate] = await seedPrompts(project, 1);

    const edited = await patch(candidate!, { text: "reworded and activated", status: "active" });

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

    const result = await activate(project, [next!]);

    expect(result.credits_charged).toBe(1);
  });
});
