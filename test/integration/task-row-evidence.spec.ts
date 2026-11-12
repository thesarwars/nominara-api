import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUNTIME_ROLES, BREAKGLASS_ROLE } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { NoopRealtimePublisher } from "../../src/lib/cache/realtime-publisher.js";
import { TasksService } from "../../src/modules/tasks/tasks.service.js";
import { withTenantContext, type TenantContext } from "../../src/tenancy/tenant-context.js";
import { MEASURED_IMPACT_CAVEAT, taskListQuerySchema, taskSchema } from "../../contracts/tasks/index.js";

// STORY-194 AC1 + AC6 - the task row's evidence, measured impact, patch and playbook, real SQL as the real `nominara_app` role under RLS.
describe("STORY-194 · the task row serves evidence, measured impact, patch and playbook_slug", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let seq = 0;
  const service = new TasksService(new NoopRealtimePublisher());
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
  const CTX = (workspaceId: string): TenantContext => ({ workspaceId, actorId: randomUUID() });

  async function createWorkspace(): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'business') RETURNING id", [`Workspace ${seq}`, `workspace-${seq}-${randomUUID()}`])).rows[0]!.id;
  }
  async function createProject(ws: string): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>(
      `INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, 'https://example.com', $4) RETURNING id`,
      [ws, `Project ${seq}`, `project-${seq}`, `example-${seq}.com`])).rows[0]!.id;
  }
  async function createAudit(ws: string, project: string, over: { robotsHash?: Buffer | null } = {}): Promise<string> {
    return (await client.query<{ id: string }>(
      `INSERT INTO aux_audits (workspace_id, project_id, trigger, target_urls, rule_version, tokenizer, status, robots_hash, created_at, finished_at)
       VALUES ($1,$2,'scheduled',ARRAY['https://example.com/'],'test','none','completed',$3,now(),now()) RETURNING id`, [ws, project, over.robotsHash ?? null])).rows[0]!.id;
  }
  async function createFinding(ws: string, project: string, audit: string): Promise<string> {
    seq += 1;
    await client.query(
      `INSERT INTO aux_rule_catalog (code, category, title, description, rationale, severity_default, weight, rule_version)
       VALUES ('AUX-R-001', 'structured_data', 'T', 'D', 'r', 'high', 0.5, 'v1') ON CONFLICT (code) DO NOTHING`);
    return (await client.query<{ id: string }>(
      `INSERT INTO aux_findings (workspace_id, project_id, audit_id, rule_code, severity, status, fingerprint, title, evidence, rule_version)
       VALUES ($1,$2,$3,'AUX-R-001','high','open',$4,'T','{}'::jsonb,'v1') RETURNING id`, [ws, project, audit, sha(`f-${seq}`)])).rows[0]!.id;
  }
  async function createPatch(ws: string, project: string, finding: string, over: { before?: Buffer; created?: string } = {}): Promise<string> {
    const before = over.before ?? sha("robots-v1");
    return (await client.query<{ id: string }>(
      `INSERT INTO patches (workspace_id, project_id, finding_id, rule_code, target_url, kind, content_before_hash, content_after, reversal, preconditions,
                            explanation, derivation, requires_human_review, review_reason, created_at)
       VALUES ($1,$2,$3,'AUX-R-001','https://example.com/robots.txt','robots',$4,'User-agent: GPTBot\nAllow: /\n',$5::jsonb,$6::jsonb,'e','d',false,null,COALESCE($7::timestamptz, now())) RETURNING id`,
      [ws, project, finding, before, JSON.stringify({ operation: "remove_block", content: "x" }),
        JSON.stringify([{ kind: "file_hash", value: `sha256:${before.toString("hex")}` }]), over.created ?? null])).rows[0]!.id;
  }
  async function createDomain(ws: string): Promise<string> {
    seq += 1;
    return (await client.query<{ id: string }>("INSERT INTO source_domains (workspace_id, domain) VALUES ($1,$2) RETURNING id", [ws, `source-${seq}.example.com`])).rows[0]!.id;
  }
  async function createMilestone(ws: string, project: string, impact: unknown): Promise<string> {
    return (await client.query<{ id: string }>(
      `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, measured_impact) VALUES ($1,$2,now(),'task_completed','M',$3::jsonb) RETURNING id`,
      [ws, project, impact === null ? null : JSON.stringify(impact)])).rows[0]!.id;
  }
  interface T { origin: string; status: string; findingId: string | null; displacementId: string | null; domainId: string | null; geo: string | null; playbook: string | null; milestoneId: string | null }
  async function createTask(ws: string, project: string, o: Partial<T> = {}): Promise<string> {
    seq += 1;
    const { origin = "auto", status = "todo", findingId = null, displacementId = null, domainId = null, geo = null, playbook = null, milestoneId = null } = o;
    return (await client.query<{ id: string }>(
      `INSERT INTO tasks (workspace_id, project_id, short_ref, kind, origin, dedupe_fingerprint, title, description, status, source_finding_id,
                          source_displacement_id, source_domain_id, source_geo_analysis, playbook_slug, milestone_id)
       VALUES ($1,$2,$3,'content',$4,$5,'T','D',$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [ws, project, `HUB-${seq}`, origin, sha(`t-${seq}-${randomUUID()}`), status, findingId, displacementId, domainId, geo, playbook, milestoneId])).rows[0]!.id;
  }

  const list = async (ws: string, project: string) =>
    new Map((await inTenant(CTX(ws), () => service.listProjectTasks(project, taskListQuerySchema.parse({})))).items.map((t) => [t.id, t]));
  const IMPACT = {
    visibility_before: 40.5, visibility_after_14d: 47.25, delta: 6.75, window_days: 14, confidence: "medium", method: "aligned_windows_v1",
    scoring_version: "2026.10.1", caveat: MEASURED_IMPACT_CAVEAT, n_before: 30, n_after: 28, other_milestones_nearby: 1,
  };

  it("[STORY-194 AC1] every auto task resolves to exactly one evidence record of the right kind; a manual task has none", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const finding = await createFinding(ws, p, await createAudit(ws, p));
    const domain = await createDomain(ws); const displacement = randomUUID();
    const byFinding = await createTask(ws, p, { findingId: finding });
    const byDisplacement = await createTask(ws, p, { displacementId: displacement });
    const byGeo = await createTask(ws, p, { geo: "a2_entity_disambiguation" });
    const byGap = await createTask(ws, p, { domainId: domain });
    const manual = await createTask(ws, p, { origin: "manual" });
    const tasks = await list(ws, p);
    expect(tasks.get(byFinding)!.evidence).toEqual({ kind: "finding", id: finding });
    expect(tasks.get(byDisplacement)!.evidence).toEqual({ kind: "displacement", id: displacement });
    expect(tasks.get(byGeo)!.evidence).toEqual({ kind: "geo_analysis", id: "a2_entity_disambiguation" });
    expect(tasks.get(byGap)!.evidence).toEqual({ kind: "source_gap", id: domain });
    expect(tasks.get(manual)!.evidence).toBeNull();
    for (const t of tasks.values()) expect(taskSchema.safeParse(t).success).toBe(true);
  });

  it("[STORY-194 AC1] a task recording several sources resolves to exactly one: finding, then displacement, then geo, then source gap", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const finding = await createFinding(ws, p, await createAudit(ws, p));
    const domain = await createDomain(ws); const displacement = randomUUID();
    const all = await createTask(ws, p, { findingId: finding, displacementId: displacement, domainId: domain, geo: "a3" });
    const noFinding = await createTask(ws, p, { displacementId: displacement, domainId: domain, geo: "a3" });
    const geoAndGap = await createTask(ws, p, { domainId: domain, geo: "a3" });
    const tasks = await list(ws, p);
    expect(tasks.get(all)!.evidence).toEqual({ kind: "finding", id: finding });
    expect(tasks.get(noFinding)!.evidence).toEqual({ kind: "displacement", id: displacement });
    expect(tasks.get(geoAndGap)!.evidence).toEqual({ kind: "geo_analysis", id: "a3" });
  });

  it("[STORY-194 AC6] measured impact is the milestone's delta with its caveat once measured, and null (never 0) before", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const measured = await createTask(ws, p, { status: "done", milestoneId: await createMilestone(ws, p, IMPACT) });
    const unmeasured = await createTask(ws, p, { status: "done", milestoneId: await createMilestone(ws, p, null) });
    const noMilestone = await createTask(ws, p, { status: "done" });
    const open = await createTask(ws, p);
    const zeroDelta = await createTask(ws, p, { status: "done", milestoneId: await createMilestone(ws, p, { ...IMPACT, delta: 0, visibility_after_14d: 40.5 }) });
    const tasks = await list(ws, p);
    expect(tasks.get(measured)!.measured_impact).toEqual(IMPACT);
    expect(tasks.get(measured)!.measured_impact!.caveat).toBe(MEASURED_IMPACT_CAVEAT);
    expect(tasks.get(unmeasured)!.measured_impact).toBeNull();
    expect(tasks.get(noMilestone)!.measured_impact).toBeNull();
    expect(tasks.get(open)!.measured_impact).toBeNull();
    expect(tasks.get(zeroDelta)!.measured_impact!.delta).toBe(0);
  });

  it("[STORY-194 AC6] a malformed or caveat-less measured_impact jsonb is served as null, never as a partial figure", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const { caveat: _caveat, ...noCaveat } = IMPACT;
    const bad = await createTask(ws, p, { status: "done", milestoneId: await createMilestone(ws, p, noCaveat) });
    const junk = await createTask(ws, p, { status: "done", milestoneId: await createMilestone(ws, p, { delta: 3 }) });
    const tasks = await list(ws, p);
    expect(tasks.get(bad)!.measured_impact).toBeNull();
    expect(tasks.get(junk)!.measured_impact).toBeNull();
  });

  it("[STORY-194 AC6] the patch is the finding's LATEST one, in the AUX finding's shape with its preconditions and earlier ids; null with no finding or patch", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const robots = sha("robots-v1");
    const audit = await createAudit(ws, p, { robotsHash: robots });
    const finding = await createFinding(ws, p, audit);
    const older = await createPatch(ws, p, finding, { before: robots, created: "2026-10-01T00:00:00Z" });
    const latest = await createPatch(ws, p, finding, { before: robots, created: "2026-10-02T00:00:00Z" });
    const withPatch = await createTask(ws, p, { findingId: finding });
    const findingNoPatch = await createTask(ws, p, { findingId: await createFinding(ws, p, audit) });
    const manual = await createTask(ws, p, { origin: "manual" });
    const tasks = await list(ws, p);
    const patch = tasks.get(withPatch)!.patch!;
    expect(patch.patch_id).toBe(latest);
    expect(patch.earlier_patch_ids).toEqual([older]);
    expect(patch.finding_id).toBe(finding);
    expect(patch.preconditions).toEqual([{ kind: "file_hash", value: `sha256:${robots.toString("hex")}` }]);
    expect(patch.page_matches).toBe(true);
    expect(tasks.get(findingNoPatch)!.patch).toBeNull();
    expect(tasks.get(manual)!.patch).toBeNull();
  });

  it("[STORY-194 AC6] a patch made against a robots.txt that has since changed is not offered on the task, exactly as on the finding", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const finding = await createFinding(ws, p, await createAudit(ws, p, { robotsHash: sha("robots-v2") }));
    await createPatch(ws, p, finding, { before: sha("robots-v1") });
    const task = await createTask(ws, p, { findingId: finding });
    expect((await list(ws, p)).get(task)!.patch).toBeNull();
  });

  it("[STORY-194 AC6] playbook_slug is served on an authority task and null elsewhere", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const authority = await createTask(ws, p, { domainId: await createDomain(ws), playbook: "reddit-seeding" });
    const plain = await createTask(ws, p);
    const tasks = await list(ws, p);
    expect(tasks.get(authority)!.playbook_slug).toBe("reddit-seeding");
    expect(tasks.get(plain)!.playbook_slug).toBeNull();
  });

  it("[STORY-194 AC1/AC6] the single-task read (readTaskById, used after an update) serves the same four fields as the list", async () => {
    const ws = await createWorkspace(); const p = await createProject(ws);
    const robots = sha("robots-v1");
    const finding = await createFinding(ws, p, await createAudit(ws, p, { robotsHash: robots }));
    await createPatch(ws, p, finding, { before: robots });
    const id = await createTask(ws, p, { findingId: finding, status: "done", playbook: "x", milestoneId: await createMilestone(ws, p, IMPACT) });
    const one = await inTenant(CTX(ws), () => service.readTaskById(id));
    expect(one).toEqual((await list(ws, p)).get(id));
    expect(one.evidence).toEqual({ kind: "finding", id: finding });
    expect(one.measured_impact).toEqual(IMPACT);
    expect(one.patch).not.toBeNull();
    expect(one.playbook_slug).toBe("x");
  });

  it("[STORY-194 AC6] another workspace's patch and milestone never reach a task row (RLS)", async () => {
    const wsA = await createWorkspace(); const pA = await createProject(wsA);
    const wsB = await createWorkspace(); const pB = await createProject(wsB);
    const findingB = await createFinding(wsB, pB, await createAudit(wsB, pB));
    await createPatch(wsB, pB, findingB);
    const milestoneB = await createMilestone(wsB, pB, IMPACT);
    // A's task row points at B's finding and milestone ids: a forged/dangling reference must resolve to nothing.
    const task = await createTask(wsA, pA, { findingId: findingB, status: "done", milestoneId: milestoneB });
    const row = (await list(wsA, pA)).get(task)!;
    expect(row.patch).toBeNull();
    expect(row.measured_impact).toBeNull();
  });
});
