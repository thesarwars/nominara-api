import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NotFoundError } from "../../src/api/errors/domain-errors.js";
import { ProjectOutOfScopeException } from "../../src/tenancy/errors.js";
import { AuxService } from "../../src/modules/aux/aux.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { auxFindingSchema, auxPatchSchema } from "../../contracts/aux/index.js";

// STORY-053 — the patch table and its read path, real SQL as the real `nominara_app` role under RLS.
// (The audit that WRITES patches is test/integration/crawl-audit-handler.spec.ts.)
describe("STORY-053 · patches — real SQL under RLS", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const service = new AuxService();
  const sha = (s: string): Buffer => createHash("sha256").update(s).digest();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
  }, 120_000);
  afterAll(async () => { await container.stop(); });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
    seq = 0;
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(resolvePassword(role, {}))}`);
    }
  });
  afterEach(async () => { await client.end(); });

  async function inTenant<T>(context: TenantContext, fn: () => Promise<T>): Promise<T> {
    const app = new Client({
      host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(),
      user: "nominara_app", password: resolvePassword("nominara_app", {}),
    });
    await app.connect();
    try { return await withTenantContext(app, context, fn); } finally { await app.end(); }
  }
  const CTX = (workspaceId: string, actorId: string, scope?: readonly string[]): TenantContext => ({
    workspaceId, actorId, ...(scope !== undefined ? { scopeProjectIds: scope } : {}),
  });

  async function createWorkspace(): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id", [`W${seq}`, `w-${seq}-${randomUUID()}`])).rows[0]!.id;
  }
  async function createUser(): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u${seq}-${randomUUID()}@example.com`])).rows[0]!.id;
  }
  async function createProject(ws: string): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,$3,'https://example.com',$4) RETURNING id",
      [ws, `P${seq}`, `p-${seq}`, `example-${seq}.com`])).rows[0]!.id;
  }
  async function createAudit(ws: string, project: string, over: { robotsHash?: Buffer | null; llms?: boolean | null; status?: string; created?: string } = {}): Promise<string> {
    return (await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer, status, robots_hash, llms_txt_present, created_at, finished_at)
       VALUES ($1,$2,'scheduled',ARRAY['https://example.com/'],'test','none',$3,$4,$5,COALESCE($6::timestamptz, now()),COALESCE($6::timestamptz, now())) RETURNING id`,
      [ws, project, over.status ?? "completed", over.robotsHash ?? null, over.llms ?? null, over.created ?? null])).rows[0]!.id;
  }
  async function createFinding(ws: string, project: string, audit: string, rule = "AUX-R-001"): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, url, severity, fingerprint, title, evidence, rule_version)
       VALUES ($1,$2,$3,$4,'https://example.com/robots.txt','high',$5,'T','{"selector":null,"snippet":null,"measured":null,"expected":null}'::jsonb,'test') RETURNING id`,
      [ws, project, audit, rule, sha(`f-${seq}-${randomUUID()}`)])).rows[0]!.id;
  }
  async function createPatch(ws: string, project: string, finding: string | null, over: { kind?: string; before?: Buffer; after?: string; created?: string; precondition?: unknown; review?: boolean; reason?: string | null } = {}): Promise<string> {
    const before = over.before ?? sha("robots-v1");
    return (await client.query<{ id: string }>(
      `INSERT INTO patches (workspace_id, project_id, finding_id, rule_code, target_url, kind, content_before_hash, content_after, reversal, preconditions,
                            explanation, derivation, requires_human_review, review_reason, created_at)
       VALUES ($1,$2,$3,'AUX-R-001','https://example.com/robots.txt',$4,$5,$6,$7::jsonb,$8::jsonb,'e','d',$9,$10,COALESCE($11::timestamptz, now())) RETURNING id`,
      [ws, project, finding, over.kind ?? "robots", before, over.after ?? "User-agent: GPTBot\nAllow: /\n",
        JSON.stringify({ operation: "remove_block", content: "x" }),
        JSON.stringify(over.precondition ?? [{ kind: "file_hash", value: `sha256:${before.toString("hex")}` }]),
        over.review ?? false, over.reason ?? null, over.created ?? null])).rows[0]!.id;
  }

  it("STORY-053 scenario 1 · GET /patches/{id} reads the patch with its reversal, precondition and hash, in the contract's shape", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    const id = await createPatch(ws, p, f);
    const read = await inTenant(CTX(ws, actor), () => service.getPatch(id));
    expect(auxPatchSchema.parse(read)).toEqual(read);
    expect(read).toMatchObject({
      patch_id: id, finding_id: f, project_id: p, rule_code: "AUX-R-001", kind: "robots",
      content_before_hash: `sha256:${sha("robots-v1").toString("hex")}`,
      reversal: { operation: "remove_block", content: "x" }, preconditions: [{ kind: "file_hash", value: `sha256:${sha("robots-v1").toString("hex")}` }],
    });
  });

  it("STORY-053 scenario 11 · every patch read says it is free and charged nothing, and reading one writes no ledger row", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    const id = await createPatch(ws, p, f);
    const before = (await client.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n;
    const read = await inTenant(CTX(ws, actor), () => service.getPatch(id));
    expect(read).toMatchObject({ free: true, credits_charged: 0 });
    const page = await inTenant(CTX(ws, actor), () => service.listProjectFindings(p, { limit: 10 }));
    expect(page.items[0]!.patch).toMatchObject({ free: true, credits_charged: 0 });
    expect((await client.query("SELECT count(*)::int AS n FROM credit_ledger")).rows[0].n).toBe(before);
  });

  it("STORY-053 scenario 8 · a patch cannot be updated, so the artifact a customer copied is always reconstructable", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    const id = await createPatch(ws, p, f);
    for (const sql of [
      "UPDATE patches SET content_after = 'tampered' WHERE id = $1",
      "UPDATE patches SET content_before_hash = '\\x00' WHERE id = $1",
      "UPDATE patches SET risk_flags = '[\"x\"]' WHERE id = $1",
      "UPDATE patches SET finding_id = gen_random_uuid() WHERE id = $1",
      "UPDATE patches SET requires_human_review = true, review_reason = 'x' WHERE id = $1",
    ]) {
      await expect(client.query(sql, [id]), sql).rejects.toMatchObject({ code: "23000" });
    }
    expect((await client.query("SELECT content_after FROM patches WHERE id = $1", [id])).rows[0].content_after).toBe("User-agent: GPTBot\nAllow: /\n");
  });

  it("STORY-053 scenario 8 · the same holds for the runtime role under RLS, which is how the application writes", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    const id = await createPatch(ws, p, f);
    await expect(inTenant(CTX(ws, actor), async () => {
      const app = (await import("../../src/tenancy/tenant-context.js")).currentTenantStore()!.client;
      await app.query("UPDATE patches SET content_after = 'tampered' WHERE id = $1", [id]);
    })).rejects.toMatchObject({ code: "23000" });
  });

  it("STORY-053 scenario 8 · deleting the finding is NOT blocked by the trigger: finding_id goes NULL and the patch survives, unchanged", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    const id = await createPatch(ws, p, f);
    await client.query("DELETE FROM aux_findings WHERE id = $1", [f]);
    const row = (await client.query("SELECT finding_id, content_after FROM patches WHERE id = $1", [id])).rows[0];
    expect(row).toEqual({ finding_id: null, content_after: "User-agent: GPTBot\nAllow: /\n" });
  });

  it("STORY-053 scenario 8 · deleting the project still removes its patches (a delete is not an update)", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    await createPatch(ws, p, null);
    await client.query("DELETE FROM projects WHERE id = $1", [p]);
    expect((await client.query("SELECT count(*)::int AS n FROM patches")).rows[0].n).toBe(0);
  });

  it("STORY-053 scenario 8 · regenerating inserts a new row; the original stays retrievable and the finding shows the latest with the earlier ids", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    const first = await createPatch(ws, p, f, { created: "2026-10-01T00:00:00Z" });
    const second = await createPatch(ws, p, f, { created: "2026-10-02T00:00:00Z", after: "User-agent: ClaudeBot\nAllow: /\n" });
    const page = await inTenant(CTX(ws, actor), () => service.listProjectFindings(p, { limit: 10 }));
    expect(page.items[0]!.patch).toMatchObject({ patch_id: second, earlier_patch_ids: [first] });
    const original = await inTenant(CTX(ws, actor), () => service.getPatch(first));
    expect(original.content_after).toBe("User-agent: GPTBot\nAllow: /\n");
    expect(original.earlier_patch_ids).toEqual([]);
    expect((await inTenant(CTX(ws, actor), () => service.getPatch(second))).earlier_patch_ids).toEqual([first]);
  });

  it("STORY-053 scenario 9 · page_matches: the latest audit's robots hash equal -> true, different -> false, unreadable -> null, none yet -> null", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    // The finding's own audit is the OLDEST: the audits below are dated after it, so each in turn is "the latest".
    const f = await createFinding(ws, p, await createAudit(ws, p, { created: "2026-10-01T00:00:00Z" }));
    const id = await createPatch(ws, p, f, { before: sha("robots-v1") });
    const read = (): Promise<boolean | null> => inTenant(CTX(ws, actor), async () => (await service.getPatch(id)).page_matches);
    // createFinding's audit has no robots hash and counts as "could not read": null, not false.
    expect(await read()).toBeNull();
    await createAudit(ws, p, { robotsHash: sha("robots-v1"), created: "2026-10-05T00:00:00Z" });
    expect(await read()).toBe(true);
    await createAudit(ws, p, { robotsHash: sha("robots-v2"), created: "2026-10-06T00:00:00Z" });
    expect(await read()).toBe(false);
    await createAudit(ws, p, { robotsHash: null, created: "2026-10-07T00:00:00Z" });
    expect(await read()).toBeNull();
    await createAudit(ws, p, { robotsHash: sha("robots-v2"), status: "failed", created: "2026-10-08T00:00:00Z" });
    expect(await read()).toBeNull(); // a failed audit observed nothing
  });

  it("STORY-053 scenario 9 · a project with no finished audit reads null", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const id = await createPatch(ws, p, null);
    expect((await inTenant(CTX(ws, actor), () => service.getPatch(id))).page_matches).toBeNull();
  });

  it("STORY-053 scenario 9 · an llms.txt patch (file_absent) holds while the audit finds none and breaks once one exists", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const id = await createPatch(ws, p, null, { kind: "markdown", before: sha(""), precondition: [{ kind: "file_absent", value: null }] });
    await createAudit(ws, p, { llms: false, created: "2026-10-05T00:00:00Z" });
    expect((await inTenant(CTX(ws, actor), () => service.getPatch(id))).page_matches).toBe(true);
    await createAudit(ws, p, { llms: true, created: "2026-10-06T00:00:00Z" });
    expect((await inTenant(CTX(ws, actor), () => service.getPatch(id))).page_matches).toBe(false);
  });

  it("STORY-053 scenario 3 · a claim-bearing patch reads with its review flag and reason; a flag with no reason is refused by the table", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const id = await createPatch(ws, p, null, { kind: "jsonld", review: true, reason: "Compliance claims must be confirmed accurate before publishing." });
    const read = await inTenant(CTX(ws, actor), () => service.getPatch(id));
    expect(read).toMatchObject({ requires_human_review: true, review_reason: "Compliance claims must be confirmed accurate before publishing." });
    await expect(createPatch(ws, p, null, { review: true, reason: null })).rejects.toMatchObject({ code: "23514" });
  });

  it("STORY-053 scenario 10 · a finding of a non-fixable rule carries guidance and an alignment link, and no patch", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    await client.query(
      `INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, auto_fixable, thresholds, task_threshold, rule_version)
       VALUES ('AUX-R-021','context_fitness','t','d','r','high',0.22,false,'{}'::jsonb,'high','test') ON CONFLICT (code) DO NOTHING`);
    await createFinding(ws, p, await createAudit(ws, p), "AUX-R-021");
    const page = await inTenant(CTX(ws, actor), () => service.listProjectFindings(p, { limit: 10 }));
    const f = auxFindingSchema.parse(page.items[0]);
    expect(f.patch).toBeNull();
    expect(f.guidance!.steps.length).toBeGreaterThan(0);
    expect(f.guidance!.alignment_link).toEqual({ path: "/geo/alignment", target_url: "https://example.com/robots.txt" });
  });

  it("STORY-053 scenario 10 · a finding that HAS a patch carries no guidance", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const f = await createFinding(ws, p, await createAudit(ws, p));
    await createPatch(ws, p, f);
    const page = await inTenant(CTX(ws, actor), () => service.listProjectFindings(p, { limit: 10 }));
    expect(page.items[0]!.guidance).toBeNull();
    expect(page.items[0]!.patch).not.toBeNull();
  });

  it("STORY-053 · a finding with nothing to offer reads patch null and guidance null (the honest empty)", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    await createFinding(ws, p, await createAudit(ws, p));
    const page = await inTenant(CTX(ws, actor), () => service.listProjectFindings(p, { limit: 10 }));
    expect(page.items[0]).toMatchObject({ patch: null, guidance: null });
  });

  it("STORY-053 · another workspace's patch is a 404 under RLS, and a scoped caller outside the project gets a 403 naming nothing about the patch", async () => {
    const wsA = await createWorkspace(); const wsB = await createWorkspace(); const actorB = await createUser();
    const pA = await createProject(wsA); const pOther = await createProject(wsA);
    const idA = await createPatch(wsA, pA, null);
    await expect(inTenant(CTX(wsB, actorB), () => service.getPatch(idA))).rejects.toBeInstanceOf(NotFoundError);
    const actorA = await createUser();
    await expect(inTenant(CTX(wsA, actorA, [pOther]), () => service.getPatch(idA))).rejects.toBeInstanceOf(ProjectOutOfScopeException);
    await expect(inTenant(CTX(wsA, actorA, [pA]), () => service.getPatch(idA))).resolves.toMatchObject({ patch_id: idA });
  });

  it("STORY-053 · a patch of a soft-deleted project is gone, like the project", async () => {
    const ws = await createWorkspace(); const actor = await createUser(); const p = await createProject(ws);
    const id = await createPatch(ws, p, null);
    await client.query("UPDATE projects SET deleted_at = now() WHERE id = $1", [p]);
    await expect(inTenant(CTX(ws, actor), () => service.getPatch(id))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("STORY-053 · the migration is a pure expand: the pre-existing columns and a row written without the new ones still work", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    await client.query(
      `INSERT INTO patches (workspace_id, project_id, target_url, kind, content_before_hash, content_after) VALUES ($1,$2,'https://example.com/','markdown',$3,'x')`,
      [ws, p, sha("x")]);
    const row = (await client.query("SELECT rule_code, requires_human_review, review_reason, explanation, derivation, preconditions FROM patches")).rows[0];
    expect(row).toEqual({ rule_code: null, requires_human_review: false, review_reason: null, explanation: null, derivation: null, preconditions: [] });
  });
});
