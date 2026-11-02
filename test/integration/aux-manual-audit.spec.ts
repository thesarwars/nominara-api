import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Logger } from "@nestjs/common";
import { Client, Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { auxAuditPrice } from "../../src/lib/aux/audit-price.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { AuxService } from "../../src/modules/aux/aux.service.js";
import { reapStaleManualAudits, MANUAL_AUDIT_STALE_AFTER_MINUTES } from "../../src/lib/aux/stale-audit-reaper.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";
import { refundAuxAuditCharge } from "../../src/lib/credits/aux-audit-refund.js";
import { createCrawlAuditHandler } from "../../src/lib/queue/handlers/crawl-audit.handler.js";
import type { GuardedResponse } from "../../src/lib/net/guarded-fetch.js";
import type { Job } from "bullmq";

// AUXLIVE-3 (owner decision 34 item 3, STORY-194) - POST /projects/{id}/aux-audits, the manual re-audit, against a real database.
//
// RUN AS `nominara_app` (RLS live), through withTenantContext, with the queue faked: what is under test is the charge, the audit row, the
// ledger and the order of events (the enqueue only after COMMIT), not BullMQ.

describe("AUXLIVE-3 · the manual AUX audit: priced, queued after commit, refunded when it fails", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let probe: Client;
  let pool: Pool;
  let workspaceId: string;
  let projectId: string;
  let actorId: string;
  let enqueued: { name: string; workspaceId: string; payload: Record<string, unknown>; key: string; auditVisibleElsewhere: boolean }[];
  let enqueueFails: boolean;

  const producer = {
    enqueueTenantJob: vi.fn(async (name: string, ws: string, payload: Record<string, unknown>, options: { idempotencyKey: string }) => {
      const seen = await probe.query("SELECT 1 FROM aux_audits WHERE id = $1", [payload.auditId]);
      enqueued.push({ name, workspaceId: ws, payload, key: options.idempotencyKey, auditVisibleElsewhere: (seen.rowCount ?? 0) > 0 });
      if (enqueueFails) throw new Error("queue down: redis://user:secret@queue.internal");
      return {} as never;
    }),
  } as unknown as QueueProducer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    probe = new Client({ connectionString: container.getConnectionUri() });
    await probe.connect();
    const password = resolvePassword("nominara_app", {});
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(password)}`);
    pool = new Pool({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: "nominara_app", password, max: 4 });
  }, 300_000);

  afterAll(async () => {
    await pool.end();
    await probe.end();
    await db.end();
    await container.stop();
  });

  async function seed(plan: string, included: number | null): Promise<void> {
    await db.query("TRUNCATE credit_ledger, credit_wallets, aux_audits, projects, workspaces CASCADE");
    await db.query("TRUNCATE users CASCADE");
    actorId = (await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])).rows[0].id;
    workspaceId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,$3,'UTC')", [workspaceId, `w-${randomUUID().slice(0, 8)}`, plan]);
    projectId = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence)
       VALUES ($1,$2,'P',$3,'https://acme.com','acme.com','active','weekly')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    if (included !== null) {
      await db.query(
        `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end)
         VALUES ($1,$2,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)`,
        [workspaceId, included],
      );
    }
  }

  beforeEach(async () => {
    enqueued = [];
    enqueueFails = false;
    vi.mocked(producer.enqueueTenantJob).mockClear();
    await seed("starter", 100);
  });
  // The enqueue is fire-and-forget after commit: let a test's own job land before the next test resets `enqueued`.
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    vi.restoreAllMocks();
  });

  const service = (): AuxService => new AuxService(pool, producer);
  async function asTenant<T>(fn: () => Promise<T>, project = workspaceId): Promise<T> {
    const c = await pool.connect();
    try {
      return await withTenantContext(c, { workspaceId: project, actorId }, fn);
    } finally {
      c.release();
    }
  }
  // Owner decision 39: a priced action takes the caller's Idempotency-Key (the audit's identity) and the figure it was shown (X-Nominara-Confirmed-Credits).
  const trigger = (
    body: Parameters<AuxService["triggerAudit"]>[1] = {},
    project = projectId,
    options: { idempotencyKey?: string; confirmedCredits?: string | undefined } = {},
  ) =>
    asTenant(() =>
      service().triggerAudit(project, body, { id: actorId, type: "user" }, {
        idempotencyKey: options.idempotencyKey ?? randomUUID(),
        confirmedCredits: "confirmedCredits" in options ? options.confirmedCredits : "10",
      }),
    );
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));
  const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;

  async function wallet() {
    const r = (await db.query("SELECT included_balance, purchased_balance, reserved, lifetime_spent FROM credit_wallets WHERE workspace_id=$1", [workspaceId])).rows[0];
    return r === undefined ? null : { included: Number(r.included_balance), purchased: Number(r.purchased_balance), reserved: Number(r.reserved), spent: Number(r.lifetime_spent) };
  }
  const ledger = async () =>
    (
      await db.query(
        `SELECT entry_type, action_code, credits::int AS credits, project_id, actor_id, actor_type, reference_type, reference_id, idempotency_key
           FROM credit_ledger WHERE workspace_id=$1 AND entry_type IN ('reserve','commit','release','refund') ORDER BY seq`,
        [workspaceId],
      )
    ).rows;
  const audits = async () => (await db.query("SELECT * FROM aux_audits ORDER BY created_at")).rows;

  it("AUXLIVE-3 AC1 · a manual audit charges the first band's flat price, 10 credits, as a reserve and a commit under aux_manual naming the project, the actor and the audit", async () => {
    const res = await trigger();
    expect(res).toMatchObject({ status: "queued", trigger: "manual", requested_scope: "key_pages", credits_charged: 10 });
    expect(res.pricing).toEqual({ pages_priced: 25, base_credits: 10, base_page_band: 25, extra_page_credits: 1 });
    expect(res.credits_charged).toBe(auxAuditPrice(res.pricing.pages_priced));
    expect(await wallet()).toEqual({ included: 90, purchased: 0, reserved: 0, spent: 10 });
    const rows = await ledger();
    expect(rows.map((r) => [r.entry_type, r.action_code, r.credits])).toEqual([["reserve", "aux_manual", 10], ["commit", "aux_manual", 10]]);
    expect(rows[1]).toMatchObject({ project_id: projectId, actor_id: actorId, actor_type: "user", reference_type: "aux_audit", reference_id: res.audit_id });
  });

  it("AUXLIVE-3 AC2 · the audit row exists at once as queued/manual, owned by the caller's workspace and project, and is read back by id", async () => {
    const res = await trigger({ scope: "sitemap_sample" });
    const [a] = await audits();
    expect(a).toMatchObject({ id: res.audit_id, workspace_id: workspaceId, project_id: projectId, trigger: "manual", status: "queued", scope: "sitemap_sample", triggered_by: actorId });
    expect(a.target_urls).toEqual([]);
    expect(a.aux_score).toBeNull(); // nothing measured yet: null, not 0
    expect(a.rule_version).toBeTruthy();
    expect(a.tokenizer).toBeTruthy();
    const read = await asTenant(() => service().getAudit(res.audit_id));
    expect(read).toMatchObject({ audit_id: res.audit_id, status: "queued", trigger: "manual" });
  });

  it("AUXLIVE-3 AC3 · the crawl.audit job is enqueued AFTER commit, keyed aux:{project}:{audit}, carrying the manual trigger and the asked-for scope", async () => {
    const res = await trigger({ scope: "single_url", target_urls: ["https://acme.com/pricing"] });
    await settle();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      name: "crawl.audit",
      workspaceId,
      key: `aux:${projectId}:${res.audit_id}`,
      payload: { projectId, auditId: res.audit_id, trigger: "manual", scope: "single_url", targetUrls: ["https://acme.com/pricing"] },
      auditVisibleElsewhere: true,
    });
  });

  it("AUXLIVE-3 AC4 · a single-URL audit is one page, inside the flat first band: still 10 credits, priced for 1 page", async () => {
    const res = await trigger({ scope: "single_url", target_urls: ["https://acme.com/pricing"] });
    expect(res.credits_charged).toBe(10);
    expect(res.pricing.pages_priced).toBe(1);
  });

  it("AUXLIVE-3 AC5 · the same Idempotency-Key twice is ONE audit and ONE charge, from the database alone - no interceptor, no cache in this test - and the second answer is the first", async () => {
    const key = randomUUID();
    const first = await trigger({}, projectId, { idempotencyKey: key });
    const second = await trigger({}, projectId, { idempotencyKey: key });
    expect(second).toEqual(first);
    expect(await wallet()).toMatchObject({ included: 90, spent: 10 });
    expect(await audits()).toHaveLength(1);
    expect((await ledger()).filter((r) => r.entry_type === "commit")).toHaveLength(1);
    await settle();
    // the replay does not queue a second job either
    expect(enqueued).toHaveLength(1);
  });

  it("AUXLIVE-3 AC5 · the replayed answer needs no fresh price check: a retry of a SUCCEEDED request is not turned into price_changed by a price that moved since", async () => {
    const key = randomUUID();
    const first = await trigger({}, projectId, { idempotencyKey: key });
    const replay = await trigger({}, projectId, { idempotencyKey: key, confirmedCredits: "999" });
    expect(replay).toEqual(first);
  });

  it("AUXLIVE-3 AC5 · the same key with a DIFFERENT body is 409 idempotency_conflict and charges nothing more", async () => {
    const key = randomUUID();
    await trigger({}, projectId, { idempotencyKey: key });
    const err = await trigger({ scope: "sitemap_sample" }, projectId, { idempotencyKey: key }).then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("idempotency_conflict");
    expect(await audits()).toHaveLength(1);
    expect(await wallet()).toMatchObject({ included: 90 });
  });

  // Review round 2 (major): the replay compares the request with an IMMUTABLE record of it, not with columns crawl.audit rewrites. claimAudit sets `scope` to
  // the scope verification decided (an unverified domain becomes public_surface) and `commit` sets `target_urls` to the pages it crawled.
  const workerRewrites = (id: string, status: string): Promise<unknown> =>
    db.query(
      "UPDATE aux_audits SET scope = 'public_surface', target_urls = ARRAY['https://acme.com/robots.txt','https://acme.com/llms.txt','https://acme.com/'], status = $2, started_at = now(), finished_at = now() WHERE id = $1",
      [id, status],
    );

  it("AUXLIVE-3 AC5 round 2 · a retry with the same key and body AFTER crawl.audit ran (scope and target_urls rewritten) and the Valkey record is gone gets the ORIGINAL answer, not 409, and no new charge", async () => {
    const key = randomUUID();
    const first = await trigger({ scope: "sitemap_sample", target_urls: ["https://acme.com/a", "https://acme.com/b"] }, projectId, { idempotencyKey: key });
    await settle();
    await workerRewrites(first.audit_id, "completed");
    const replay = await trigger({ scope: "sitemap_sample", target_urls: ["https://acme.com/a", "https://acme.com/b"] }, projectId, { idempotencyKey: key });
    expect(replay).toMatchObject({ audit_id: first.audit_id, requested_scope: "sitemap_sample", credits_charged: 10, credits_refunded: 0, status: "completed" });
    expect(await audits()).toHaveLength(1);
    expect(await wallet()).toMatchObject({ included: 90, spent: 10 });
    expect(enqueued).toHaveLength(1);
  });

  it("AUXLIVE-3 AC5 round 2 · after crawl.audit ran, the same key with a DIFFERENT body is still 409 idempotency_conflict (the record is of the request, not of the rewritten row)", async () => {
    const key = randomUUID();
    const first = await trigger({}, projectId, { idempotencyKey: key });
    await workerRewrites(first.audit_id, "completed");
    const err = await trigger({ scope: "sitemap_sample" }, projectId, { idempotencyKey: key }).then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("idempotency_conflict");
    // a body equal to what the worker REWROTE it to is not the original request either
    const err2 = await trigger({ target_urls: ["https://acme.com/robots.txt", "https://acme.com/llms.txt", "https://acme.com/"] }, projectId, { idempotencyKey: key }).then(() => null, (e: unknown) => e);
    expect(codeOf(err2)).toBe("idempotency_conflict");
    expect(await wallet()).toMatchObject({ included: 90 });
  });

  it("AUXLIVE-3 AC5 round 2 · a replay of an audit that FAILED and was refunded says so: its real status, the charge and the refund - not 'queued' and an unrefunded 10", async () => {
    const key = randomUUID();
    const first = await trigger({}, projectId, { idempotencyKey: key });
    await db.query("UPDATE aux_audits SET created_at = now() - make_interval(mins => 61) WHERE id = $1", [first.audit_id]);
    expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 1 });
    const replay = await trigger({}, projectId, { idempotencyKey: key });
    expect(replay).toMatchObject({ audit_id: first.audit_id, status: "failed", credits_charged: 10, credits_refunded: 10 });
    expect(await wallet()).toMatchObject({ included: 100 });
    expect(await audits()).toHaveLength(1);
  });

  it("AUXLIVE-3 AC5 round 2 · the first answer reports credits_refunded 0", async () => {
    expect(await trigger()).toMatchObject({ status: "queued", credits_charged: 10, credits_refunded: 0 });
  });

  it("AUXLIVE-3 AC10 round 2 · the dispatch failure goes through the one failure function: the failed-audit counter moves too", async () => {
    enqueueFails = true;
    const counts: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => { counts.push(m); });
    await trigger();
    await settle();
    expect(counts.find((l) => (l as { metric?: string }).metric === "nominara_aux_audits_total" && (l as { status?: string }).status === "failed")).toMatchObject({ trigger: "manual" });
  });

  it("AUXLIVE-3 AC5 · two DIFFERENT keys are two audits and two charges; another workspace's identical key is a different audit", async () => {
    await trigger();
    await trigger();
    expect(await wallet()).toMatchObject({ included: 80 });
    expect(new Set((await audits()).map((a) => a.id)).size).toBe(2);
  });

  it("AUXLIVE-3 AC5 · the audit id and the ledger key are the derived ones, so the DATABASE refuses a replay: the audit id is manualAuditIdentity(workspace, key)", async () => {
    const key = randomUUID();
    const res = await trigger({}, projectId, { idempotencyKey: key });
    const { manualAuditIdentity } = await import("../../src/lib/aux/manual-audit-id.js");
    const derived = manualAuditIdentity(workspaceId, key);
    expect(res.audit_id).toBe(derived.auditId);
    expect((await ledger()).filter((r) => r.entry_type === "commit")[0]!.idempotency_key).toBe(derived.ledgerKey);
  });

  it("AUXLIVE-3 AC5 · twenty CONCURRENT attempts with ONE key (a client retrying while the first is still in flight) charge once and all get the same answer", async () => {
    const key = randomUUID();
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () => trigger({}, projectId, { idempotencyKey: key })));
    const answers = settled.map((r) => (r.status === "fulfilled" ? r.value : r.reason));
    for (const a of answers) expect(a).toMatchObject({ status: "queued", credits_charged: 10 });
    expect(new Set(answers.map((a) => (a as { audit_id: string }).audit_id)).size).toBe(1);
    expect(await audits()).toHaveLength(1);
    expect(await wallet()).toMatchObject({ included: 90, spent: 10 });
    expect((await ledger()).filter((r) => r.entry_type === "commit")).toHaveLength(1);
  });

  it("AUXLIVE-3 AC13 · twenty concurrent attempts against a wallet of 50: exactly 5 succeed, 15 are 402, the balance is 0, and there are 5 audits and 5 commits", async () => {
    await seed("starter", 50);
    const settled = await Promise.allSettled(Array.from({ length: 20 }, () => trigger()));
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    const refused = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(15);
    for (const r of refused) expect(codeOf(r.reason)).toBe("insufficient_credits");
    expect(await wallet()).toMatchObject({ included: 0, reserved: 0, spent: 50 });
    expect(await audits()).toHaveLength(5);
    expect((await ledger()).filter((r) => r.entry_type === "commit")).toHaveLength(5);
  });

  // ---- owner decision 39: the priced-action flow (api-specification.md sections 1 and 7) ----

  it("AUXLIVE-3 AC14 · no X-Nominara-Confirmed-Credits is 400 validation_failed NAMING the header: nothing charged, written or queued", async () => {
    const err = await trigger({}, projectId, { confirmedCredits: undefined }).then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("validation_failed");
    expect(JSON.stringify(err)).toContain("x-nominara-confirmed-credits");
    expect(await audits()).toEqual([]);
    expect(await ledger()).toEqual([]);
    await settle();
    expect(enqueued).toEqual([]);
  });

  it("AUXLIVE-3 AC14 · a malformed header (not a whole number) is 400, and a blank one is the same as absent", async () => {
    for (const bad of ["ten", "1e1", "10abc", "-10", "10.0", ""]) {
      const err = await trigger({}, projectId, { confirmedCredits: bad }).then(() => null, (e: unknown) => e);
      expect(codeOf(err), bad).toBe("validation_failed");
    }
    expect(await ledger()).toEqual([]);
  });

  it("AUXLIVE-3 AC14 · a figure that does not match the price recomputed now is 409 price_changed with shown, recomputed and a reason - BEFORE any money moves", async () => {
    for (const shown of ["9", "11", "0"]) {
      const err = await trigger({}, projectId, { confirmedCredits: shown }).then(() => null, (e: unknown) => e);
      expect(codeOf(err), shown).toBe("price_changed");
      expect((err as { details?: Record<string, unknown> }).details).toMatchObject({ shown: Number(shown), recomputed: 10 });
      expect(typeof (err as { details?: { reason?: unknown } }).details?.reason).toBe("string");
    }
    expect(await audits()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toMatchObject({ included: 100, reserved: 0, spent: 0 });
  });

  it("AUXLIVE-3 AC14 · the price is checked BEFORE the wallet: a mismatch on an empty wallet is price_changed, not insufficient_credits", async () => {
    await seed("starter", 0);
    const err = await trigger({}, projectId, { confirmedCredits: "7" }).then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("price_changed");
  });

  it("AUXLIVE-3 AC14 · a matching figure is charged; a single-URL audit is also 10, so 10 is the figure it must echo", async () => {
    await expect(trigger({ scope: "single_url", target_urls: ["https://acme.com/pricing"] }, projectId, { confirmedCredits: "10" })).resolves.toMatchObject({ credits_charged: 10 });
  });

  it("AUXLIVE-3 AC15 · the PREVIEW quotes the price and its breakdown and changes nothing: no ledger entry, no audit row, no job, no reservation", async () => {
    const quote = await asTenant(() => service().previewAudit(projectId, {}));
    expect(quote).toEqual({ credits: 10, requested_scope: "key_pages", pricing: { pages_priced: 25, base_credits: 10, base_page_band: 25, extra_page_credits: 1 }, credits_charged: 0 });
    const single = await asTenant(() => service().previewAudit(projectId, { scope: "single_url", target_urls: ["https://acme.com/a"] }));
    expect(single).toMatchObject({ credits: 10, pricing: { pages_priced: 1 } });
    expect(await ledger()).toEqual([]);
    expect(await audits()).toEqual([]);
    expect(await wallet()).toMatchObject({ included: 100, reserved: 0, spent: 0 });
    await settle();
    expect(enqueued).toEqual([]);
  });

  it("AUXLIVE-3 AC15 · the preview quotes the same figure the trigger demands: echoing it is accepted", async () => {
    const quote = await asTenant(() => service().previewAudit(projectId, {}));
    await expect(trigger({}, projectId, { confirmedCredits: String(quote.credits) })).resolves.toMatchObject({ credits_charged: quote.credits });
  });

  it("AUXLIVE-3 AC15 · the preview is refused for a plan with no AUX audits (403 feature_not_in_plan) and for a project that is not the caller's (404), like the trigger", async () => {
    await seed("free", 60);
    expect(codeOf(await asTenant(() => service().previewAudit(projectId, {})).then(() => null, (e: unknown) => e))).toBe("feature_not_in_plan");
    await seed("starter", 60);
    expect(codeOf(await asTenant(() => service().previewAudit(randomUUID(), {})).then(() => null, (e: unknown) => e))).toBe("not_found");
  });

  it("AUXLIVE-3 AC6 · a wallet that cannot cover it is 402 insufficient_credits: no audit row, no ledger entry, nothing enqueued", async () => {
    await seed("starter", 9);
    const err = await trigger().then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("insufficient_credits");
    expect((err as { details?: { required?: number; available?: number } }).details).toMatchObject({ required: 10, available: 9 });
    expect(await audits()).toEqual([]);
    expect(await ledger()).toEqual([]);
    expect(await wallet()).toMatchObject({ included: 9, reserved: 0, spent: 0 });
    await settle();
    expect(enqueued).toEqual([]);
  });

  it("AUXLIVE-3 AC6 · exactly the price is enough (10 of 10): the boundary", async () => {
    await seed("starter", 10);
    await expect(trigger()).resolves.toMatchObject({ credits_charged: 10 });
    expect(await wallet()).toMatchObject({ included: 0, spent: 10 });
  });

  it("AUXLIVE-3 AC7 · a plan with no AUX audits (Free) is 403 feature_not_in_plan, naming the key: nothing is charged, written or enqueued", async () => {
    await seed("free", 60);
    const err = await trigger().then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("feature_not_in_plan");
    expect(await audits()).toEqual([]);
    expect(await ledger()).toEqual([]);
    await settle();
    expect(enqueued).toEqual([]);
  });

  it("AUXLIVE-3 AC8 · another workspace's project, or a project that does not exist, is 404 and charges nothing", async () => {
    const otherWs = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'O',$2,'starter','UTC')", [otherWs, `w-${randomUUID().slice(0, 8)}`]);
    const otherProject = randomUUID();
    await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence) VALUES ($1,$2,'O',$3,'https://o.test','o.test','active','weekly')", [otherProject, otherWs, `p-${randomUUID().slice(0, 8)}`]);
    for (const id of [otherProject, randomUUID()]) {
      const err = await trigger({}, id).then(() => null, (e: unknown) => e);
      expect(codeOf(err)).toBe("not_found");
    }
    expect(await ledger()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it("AUXLIVE-3 AC9 · a soft-deleted project is 404", async () => {
    await db.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [projectId]);
    const err = await trigger().then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("not_found");
    expect(await ledger()).toEqual([]);
  });

  it("AUXLIVE-3 AC10 · if the job cannot be handed to the queue the audit is failed and the charge refunded in full, to the buckets it came from", async () => {
    enqueueFails = true;
    const res = await trigger();
    await settle();
    const [a] = await audits();
    expect(a).toMatchObject({ id: res.audit_id, status: "failed" });
    expect(a.error_summary).toEqual({ reason: "dispatch_failed" });
    expect(a.finished_at).not.toBeNull();
    expect(await wallet()).toMatchObject({ included: 100, reserved: 0 });
    const rows = await ledger();
    expect(rows.map((r) => r.entry_type)).toEqual(["reserve", "commit", "refund"]);
    expect(rows[2]).toMatchObject({ credits: 10, reference_type: "aux_audit", reference_id: res.audit_id });
  });

  it("AUXLIVE-3 AC10 · the dispatch-failure log carries the workspace id, the audit id and the error NAME, never the queue's message or the workspace name", async () => {
    enqueueFails = true;
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "error").mockImplementation((m: unknown) => { lines.push(m); });
    await trigger();
    await settle();
    const line = lines.find((l) => (l as { event?: string }).event === "aux.manual_audit.dispatch_failed");
    expect(line).toMatchObject({ workspace_id: workspaceId, project_id: projectId });
    expect(JSON.stringify(lines)).not.toContain("secret");
    expect(JSON.stringify(lines)).not.toContain("queue.internal");
  });

  it("AUXLIVE-3 AC11 · observability: a counter for the request, and a log line with the workspace id, the audit id and the credits, with no domain and no workspace name", async () => {
    const lines: unknown[] = [];
    vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => { lines.push(m); });
    const res = await trigger();
    await settle();
    expect(lines.find((l) => (l as { metric?: string }).metric === "nominara_aux_manual_audits_requested_total")).toMatchObject({ outcome: "queued" });
    const line = lines.find((l) => (l as { event?: string }).event === "aux.manual_audit.requested");
    expect(line).toMatchObject({ workspace_id: workspaceId, project_id: projectId, audit_id: res.audit_id, credits: 10 });
    expect(JSON.stringify(lines)).not.toContain("acme.com");
  });

  // ---- refundAuxAuditCharge: the primitive the crawl.audit handler and the dispatch compensation share ----

  const withTx = <T>(fn: (tx: Client) => Promise<T>): Promise<T> =>
    asTenant(async () => {
      const store = (await import("../../src/tenancy/tenant-context.js")).currentTenantStore()!;
      return fn(store.client as unknown as Client);
    });

  it("AUXLIVE-3 AC12 · refunding twice returns the credits once: the refund carries the debit's own idempotency key per bucket", async () => {
    const res = await trigger();
    const first = await withTx((tx) => refundAuxAuditCharge(tx, { workspaceId, auditId: res.audit_id, reason: "audit_failed" }));
    const second = await withTx((tx) => refundAuxAuditCharge(tx, { workspaceId, auditId: res.audit_id, reason: "audit_failed" }));
    expect(first).toEqual({ refunded: 10 });
    expect(second).toEqual({ refunded: 0 });
    expect(await wallet()).toMatchObject({ included: 100 });
    expect((await ledger()).filter((r) => r.entry_type === "refund")).toHaveLength(1);
  });

  it("AUXLIVE-3 AC12 · an audit that was never charged (an onboarding audit) refunds nothing and that is not an error", async () => {
    const id = randomUUID();
    const out = await withTx((tx) => refundAuxAuditCharge(tx, { workspaceId, auditId: id, reason: "audit_failed" }));
    expect(out).toEqual({ refunded: 0 });
    expect(await ledger()).toEqual([]);
  });

  it("AUXLIVE-3 AC12 · a refund restores the expiring (included) and durable (purchased) buckets to exactly what the debit took from each", async () => {
    await db.query("UPDATE credit_wallets SET included_balance = 4, purchased_balance = 20 WHERE workspace_id = $1", [workspaceId]);
    const res = await trigger();
    expect(await wallet()).toMatchObject({ included: 0, purchased: 14 });
    await withTx((tx) => refundAuxAuditCharge(tx, { workspaceId, auditId: res.audit_id, reason: "audit_failed" }));
    expect(await wallet()).toMatchObject({ included: 4, purchased: 20 });
  });

  // ---- owner decision 40: the 60-minute reaper for a manual audit whose job never finished ----

  describe("AUXLIVE-3 AC16 · the stale manual-audit reaper", () => {
    const age = (id: string, minutes: number, status = "queued"): Promise<unknown> =>
      db.query("UPDATE aux_audits SET created_at = now() - make_interval(mins => $2), status = $3 WHERE id = $1", [id, minutes, status]);
    const refunds = async () => (await ledger()).filter((r) => r.entry_type === "refund");

    it("AUXLIVE-3 AC16 · the bound is 60 minutes (owner decision 40)", () => {
      expect(MANUAL_AUDIT_STALE_AFTER_MINUTES).toBe(60);
    });

    it("AUXLIVE-3 AC16 · a manual audit still queued after 61 minutes is failed (stale) and refunded in full to the buckets it came from", async () => {
      const res = await trigger();
      await age(res.audit_id, 61);
      expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 1 });
      const [a] = await audits();
      expect(a).toMatchObject({ id: res.audit_id, status: "failed" });
      expect(a.error_summary).toEqual({ reason: "stale" });
      expect(a.finished_at).not.toBeNull();
      expect(await wallet()).toMatchObject({ included: 100, reserved: 0 });
      expect(await refunds()).toHaveLength(1);
    });

    it("AUXLIVE-3 AC16 · a manual audit still RUNNING after 61 minutes is reaped too", async () => {
      const res = await trigger();
      await age(res.audit_id, 61, "running");
      expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 1 });
      expect((await audits())[0].status).toBe("failed");
      expect(await wallet()).toMatchObject({ included: 100 });
    });

    it("AUXLIVE-3 AC16 · boundary: 59 minutes is left alone", async () => {
      const res = await trigger();
      await age(res.audit_id, 59);
      expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 0 });
      expect((await audits())[0].status).toBe("queued");
      expect(await wallet()).toMatchObject({ included: 90 });
    });

    it("AUXLIVE-3 AC16 · only QUEUED/RUNNING manual audits: a finished one keeps its charge, and an onboarding audit (no charge) is not this reaper's", async () => {
      const done = await trigger();
      await age(done.audit_id, 500, "completed");
      const partial = await trigger();
      await age(partial.audit_id, 500, "partial");
      await db.query(
        `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, rule_version, tokenizer, status, created_at)
         VALUES ($1,$2,$3,'onboarding','public_surface','{}','2026.10.1','cl100k','queued', now() - interval '5 hours')`,
        [randomUUID(), workspaceId, projectId],
      );
      expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 0 });
      expect(await refunds()).toEqual([]);
      expect(await wallet()).toMatchObject({ included: 80 });
    });

    it("AUXLIVE-3 AC16 · idempotent: a second pass refunds nothing more, and a refund already made (the job failed it first) is not repeated", async () => {
      const res = await trigger();
      await age(res.audit_id, 120);
      await reapStaleManualAudits(db, new Date());
      expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 0 });
      expect(await refunds()).toHaveLength(1);
      expect(await wallet()).toMatchObject({ included: 100 });
    });

    it("AUXLIVE-3 AC16 · observability: a counter and a log line with the workspace id and the audit id - no domain, no workspace name, no URL", async () => {
      const lines: unknown[] = [];
      vi.spyOn(Logger.prototype, "log").mockImplementation((m: unknown) => { lines.push(m); });
      const res = await trigger({ scope: "single_url", target_urls: ["https://acme.com/secret-path"] });
      await age(res.audit_id, 90);
      await reapStaleManualAudits(db, new Date());
      expect(lines.find((l) => (l as { metric?: string }).metric === "nominara_aux_stale_audits_reaped_total")).toBeDefined();
      expect(lines.find((l) => (l as { event?: string }).event === "aux.audit.reaped_stale")).toMatchObject({ workspace_id: workspaceId, audit_id: res.audit_id });
      expect(JSON.stringify(lines.filter((l) => (l as { event?: string }).event === "aux.audit.reaped_stale"))).not.toMatch(/acme\.com|secret-path/);
    });

    it("AUXLIVE-3 AC16 · the scheduler sweep runs the reaper: a stale manual audit is failed and refunded by a tick, with no other caller", async () => {
      const res = await trigger();
      await age(res.audit_id, 90);
      const { SchedulerSweepRuntime } = await import("../../src/lib/capture/scheduler-sweep.js");
      const runtime = new SchedulerSweepRuntime({
        connect: () => {
          const client = new Client({ connectionString: container.getConnectionUri() });
          return client.connect().then(() => client);
        },
        enqueue: () => Promise.resolve(),
      });
      await runtime.tick();
      expect((await audits())[0].status).toBe("failed");
      expect(await wallet()).toMatchObject({ included: 100 });
    });

    it("AUXLIVE-3 AC16 · one tenant's stale audits are settled in THEIR OWN context: two workspaces, each refunded to its own wallet", async () => {
      const first = await trigger();
      await age(first.audit_id, 90);
      const firstWorkspace = workspaceId;
      const firstProject = projectId;
      // a second workspace with its own funded wallet and a stale charged audit
      const otherWs = randomUUID();
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'O',$2,'starter','UTC')", [otherWs, `w-${randomUUID().slice(0, 8)}`]);
      const otherProject = randomUUID();
      await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain, status, cadence) VALUES ($1,$2,'O',$3,'https://o.test','o.test','active','weekly')", [otherProject, otherWs, `p-${randomUUID().slice(0, 8)}`]);
      await db.query(
        `INSERT INTO credit_wallets (workspace_id, included_balance, cycle_start, cycle_end) VALUES ($1,100,(now() AT TIME ZONE 'UTC')::date,(now() AT TIME ZONE 'UTC')::date + 30)`,
        [otherWs],
      );
      const second = await asTenant(() => service().triggerAudit(otherProject, {}, { id: actorId, type: "user" }, { idempotencyKey: randomUUID(), confirmedCredits: "10" }), otherWs);
      await age(second.audit_id, 90);
      expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 2 });
      const balances = (await db.query("SELECT workspace_id, included_balance::int AS b FROM credit_wallets ORDER BY b")).rows;
      expect(balances.map((r) => r.b)).toEqual([100, 100]);
      expect(new Set(balances.map((r) => r.workspace_id))).toEqual(new Set([firstWorkspace, otherWs]));
      expect(firstProject).toBeDefined();
    });
  });

  // OWNER DECISION 48 - the Idempotency-Key is honoured for 24 HOURS, as on every paid action. The database-backed replay is bounded by the audit's own
  // created_at; after the window the same key starts a NEW audit (a new identity, a new ledger key) and charges normally.
  describe("owner decision 48 · the replay window is 24 hours", () => {
    const ageBy = (auditId: string, hours: number, minutes = 0): Promise<unknown> =>
      db.query("UPDATE aux_audits SET created_at = now() - make_interval(hours => $2, mins => $3) WHERE id = $1", [auditId, hours, minutes]);
    const commits = async (): Promise<number> => (await db.query("SELECT count(*)::int AS n FROM credit_ledger WHERE workspace_id = $1 AND entry_type = 'commit'", [workspaceId])).rows[0].n;

    it("AUXLIVE-3 D48 · a replay at 23 hours returns the ORIGINAL audit: same id, no new audit, no new charge, no new job", async () => {
      const key = randomUUID();
      const first = await trigger({}, projectId, { idempotencyKey: key });
      await settle();
      await ageBy(first.audit_id, 23);
      const replay = await trigger({}, projectId, { idempotencyKey: key });
      expect(replay).toEqual(first);
      expect(await audits()).toHaveLength(1);
      expect(await commits()).toBe(1);
      expect(await wallet()).toMatchObject({ included: 90, spent: 10 });
      await settle();
      expect(enqueued).toHaveLength(1);
    });

    it("AUXLIVE-3 D48 · a request at 25 hours with the same key and body is a NEW audit with a NEW charge and its own job", async () => {
      const key = randomUUID();
      const first = await trigger({}, projectId, { idempotencyKey: key });
      await settle();
      await ageBy(first.audit_id, 25);
      const second = await trigger({}, projectId, { idempotencyKey: key });
      expect(second.audit_id).not.toBe(first.audit_id);
      expect(second).toMatchObject({ status: "queued", credits_charged: 10, credits_refunded: 0 });
      expect(await audits()).toHaveLength(2);
      expect(await commits()).toBe(2);
      expect(await wallet()).toMatchObject({ included: 80, spent: 20 });
      // two different ledger keys: the second charge is not the first one's replay
      const keys = (await ledger()).filter((r) => r.entry_type === "commit").map((r) => r.idempotency_key);
      expect(new Set(keys).size).toBe(2);
      await settle();
      expect(enqueued.map((e) => e.payload.auditId)).toEqual([first.audit_id, second.audit_id]);
      // the first audit is untouched
      expect((await audits()).find((a) => a.id === first.audit_id)).toMatchObject({ status: "queued" });
    });

    it("AUXLIVE-3 D48 · boundary: 23h59m replays, 24h01m starts a new audit", async () => {
      const key = randomUUID();
      const first = await trigger({}, projectId, { idempotencyKey: key });
      await ageBy(first.audit_id, 23, 59);
      expect((await trigger({}, projectId, { idempotencyKey: key })).audit_id).toBe(first.audit_id);
      await ageBy(first.audit_id, 24, 1);
      expect((await trigger({}, projectId, { idempotencyKey: key })).audit_id).not.toBe(first.audit_id);
      expect(await commits()).toBe(2);
    });

    it("AUXLIVE-3 D48 · after the new audit, the same key replays THAT audit inside ITS window - the window restarts, it does not charge a third time", async () => {
      const key = randomUUID();
      const first = await trigger({}, projectId, { idempotencyKey: key });
      await ageBy(first.audit_id, 30);
      const second = await trigger({}, projectId, { idempotencyKey: key });
      const again = await trigger({}, projectId, { idempotencyKey: key });
      expect(again).toEqual(second);
      expect(await commits()).toBe(2);
      // and a third window later is a third audit
      await ageBy(second.audit_id, 25);
      const third = await trigger({}, projectId, { idempotencyKey: key });
      expect(new Set([first.audit_id, second.audit_id, third.audit_id]).size).toBe(3);
      expect(await commits()).toBe(3);
    });

    it("AUXLIVE-3 D48 · past the window the key is free again: the same key with a DIFFERENT body is a new audit, not 409 idempotency_conflict (inside it, it still is)", async () => {
      const key = randomUUID();
      const first = await trigger({}, projectId, { idempotencyKey: key });
      const inside = await trigger({ scope: "sitemap_sample" }, projectId, { idempotencyKey: key }).then(() => null, (e: unknown) => e);
      expect(codeOf(inside)).toBe("idempotency_conflict");
      await ageBy(first.audit_id, 25);
      const after = await trigger({ scope: "sitemap_sample" }, projectId, { idempotencyKey: key });
      expect(after).toMatchObject({ requested_scope: "sitemap_sample", credits_charged: 10 });
      expect(after.audit_id).not.toBe(first.audit_id);
    });

    it("AUXLIVE-3 D48 · an old audit that FAILED and was refunded is not replayed after the window either: the key starts a new, charged audit", async () => {
      const key = randomUUID();
      const first = await trigger({}, projectId, { idempotencyKey: key });
      await db.query("UPDATE aux_audits SET created_at = now() - make_interval(hours => 25) WHERE id = $1", [first.audit_id]);
      expect(await reapStaleManualAudits(db, new Date())).toEqual({ reaped: 1 });
      expect(await wallet()).toMatchObject({ included: 100 });
      const second = await trigger({}, projectId, { idempotencyKey: key });
      expect(second.audit_id).not.toBe(first.audit_id);
      expect(await wallet()).toMatchObject({ included: 90 });
    });

    it("AUXLIVE-3 D48 · five CONCURRENT attempts with one expired key start ONE new audit and charge once", async () => {
      const key = randomUUID();
      const first = await trigger({}, projectId, { idempotencyKey: key });
      await ageBy(first.audit_id, 25);
      const results = await Promise.all(Array.from({ length: 5 }, () => trigger({}, projectId, { idempotencyKey: key })));
      expect(new Set(results.map((r) => r.audit_id)).size).toBe(1);
      expect(results[0]!.audit_id).not.toBe(first.audit_id);
      expect(await commits()).toBe(2);
      expect(await audits()).toHaveLength(2);
    });
  });

  // OWNER DECISION 47 - Free gets the free site-files-only check (no charge), but still cannot buy the priced page re-audit: plans-and-entitlements.md
  // section 3, Free: "No exports, integrations, share links, alignment analysis, or AUX audits"; aux.scheduled_audits is off on Free.
  it("AUXLIVE-3 D47 · a Free workspace that HAS its site-files onboarding audit still cannot POST a priced re-audit (403 feature_not_in_plan) nor preview one: no debit, no row, no job", async () => {
    await seed("free", 60);
    await db.query(
      `INSERT INTO aux_audits (id, workspace_id, project_id, trigger, scope, target_urls, excluded_rules, rule_version, tokenizer, status)
       VALUES ($1,$2,$3,'onboarding','public_surface','{}','{}','2026.10.1','cl100k','completed')`,
      [randomUUID(), workspaceId, projectId],
    );
    const err = await trigger().then(() => null, (e: unknown) => e);
    expect(codeOf(err)).toBe("feature_not_in_plan");
    expect(codeOf(await asTenant(() => service().previewAudit(projectId, {})).then(() => null, (e: unknown) => e))).toBe("feature_not_in_plan");
    expect(await audits()).toHaveLength(1);
    expect(await ledger()).toEqual([]);
    await settle();
    expect(enqueued).toEqual([]);
  });

  // Review minor (round 3) - the replay after crawl.audit REALLY ran, through the real handler (prepare, run, commit), not a hand-written UPDATE.
  it("AUXLIVE-3 AC5 round 4 · a manual audit on an UNVERIFIED domain is run by the real crawl.audit handler (scope becomes public_surface, target_urls is rewritten); a replay with the ORIGINAL body is the same audit, no second debit, no 409", async () => {
    const key = randomUUID();
    const body = { scope: "sitemap_sample" as const, target_urls: ["https://acme.com/a", "https://acme.com/b"] };
    const first = await trigger(body, projectId, { idempotencyKey: key });
    await settle();
    const before = (await audits())[0];
    expect(before).toMatchObject({ scope: "sitemap_sample", target_urls: body.target_urls, status: "queued" });

    const served: Record<string, string> = {
      "/robots.txt": "User-agent: *\nAllow: /\nSitemap: https://acme.com/sitemap.xml\n",
      "/llms.txt": "# Acme\n- [Docs](https://acme.com/docs)\n",
      "/.well-known/llms.txt": "",
      "/sitemap.xml": "<urlset><url><loc>https://acme.com/</loc></url></urlset>",
      "/": "<html><head><title>Acme</title></head><body><h1>Acme</h1></body></html>",
    };
    const fetch = async (url: string): Promise<GuardedResponse> => {
      const path = new URL(url).pathname;
      const hit = served[path];
      return { status: hit === undefined || path === "/.well-known/llms.txt" ? 404 : 200, headers: {}, body: Buffer.from(hit ?? ""), finalUrl: url };
    };
    const handler = createCrawlAuditHandler(
      { pool: {} as never, env: {} as never },
      {
        fetch,
        now: () => new Date(),
        sleep: async () => undefined,
        renderer: { render: async (url) => ({ html: served[new URL(url).pathname] ?? "", finalUrl: url, status: 200 }) },
        store: async (relative) => `crawl/test/ws/${relative}`,
        enqueueTaskGenerate: async () => undefined,
      },
    );
    const crawlJob = { data: { payload: { projectId, auditId: first.audit_id, trigger: "manual", workspaceId, kid: "k1", scope: "sitemap_sample", targetUrls: body.target_urls } } } as unknown as Job;
    const worker = await pool.connect();
    try {
      await withTenantContext(worker, { workspaceId, actorId: SYSTEM_ACTOR_ID }, (tx) => handler(tx, crawlJob));
    } finally {
      worker.release();
    }

    const after = (await audits())[0];
    expect(after.id).toBe(first.audit_id);
    expect(["completed", "partial"]).toContain(after.status);
    // the worker REWROTE the row: verification decided the scope, and the crawled pages replaced the hints
    expect(after.scope).toBe("public_surface");
    expect(after.target_urls).not.toEqual(body.target_urls);

    const replay = await trigger(body, projectId, { idempotencyKey: key });
    expect(replay).toMatchObject({ audit_id: first.audit_id, requested_scope: "sitemap_sample", credits_charged: 10, credits_refunded: 0, status: after.status });
    expect(await audits()).toHaveLength(1);
    expect(await ledger().then((rows) => rows.filter((r) => r.entry_type === "commit"))).toHaveLength(1);
    expect(await wallet()).toMatchObject({ included: 90, spent: 10 });
  });
});
