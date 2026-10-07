import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { trackCompetitorResponseSchema } from "../../contracts/projects/index.js";
import { CompetitorTrackingService } from "../../src/modules/projects/competitor-tracking.service.js";
import { ConflictError, EntitlementExceededError, NotFoundError } from "../../src/api/errors/domain-errors.js";
import type { EntitlementResolver } from "../../src/lib/entitlements/entitlement-resolver.js";
import type { QueueProducer } from "../../src/lib/queue/queue-producer.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-C-2 — track / untrack a competitor. STORY-092 scenarios 3, 5 and 6.
//
// Dangerous area: promotion REWRITES parser output (mention_facts.entity_type
// and entity_id). The hazards asserted here: only this project's `other` rows
// that match this competitor move; nothing is charged and nothing is
// captured; the recompute is asked for; removal rewrites no history.

describe("NEW-C-2 · track and untrack a competitor", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;
  let otherProjectId: string;
  let promptId: string;
  let cap = 5;
  let enqueued: { name: string; workspaceId: string; payload: Record<string, unknown>; options: { idempotencyKey: string } }[];

  const resolver = {
    resolveForWorkspace: async () => ({ entitlements: { "competitors.max_per_project": { value: cap } } }),
  } as unknown as EntitlementResolver;
  const queues = {
    enqueueTenantJob: async (name: string, ws: string, payload: Record<string, unknown>, options: { idempotencyKey: string }) => {
      enqueued.push({ name, workspaceId: ws, payload, options });
      return {};
    },
  } as unknown as QueueProducer;
  const service = new CompetitorTrackingService(queues, resolver);

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

  beforeEach(async () => {
    await db.query(
      "TRUNCATE milestones, credit_ledger, mention_facts, answer_captures, tracked_prompts, competitors, project_engines, capture_runs, projects, workspaces, engines CASCADE",
    );
    cap = 5;
    enqueued = [];
    workspaceId = randomUUID();
    projectId = randomUUID();
    otherProjectId = randomUUID();
    promptId = randomUUID();
    await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    for (const [id, domain] of [[projectId, "hubspot.com"], [otherProjectId, "other.com"]] as const) {
      await db.query(
        `INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, workspaceId, domain, `p-${randomUUID().slice(0, 8)}`, `https://${domain}`, domain],
      );
    }
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  async function addFact(
    label: string,
    options: { daysAgo?: number; project?: string; type?: string; alias?: string; entityId?: string } = {},
  ): Promise<void> {
    const capturedAt = new Date(Date.now() - (options.daysAgo ?? 1) * 86_400_000).toISOString();
    await db.query(
      `INSERT INTO mention_facts
         (workspace_id,project_id,result_id,prompt_id,engine_key,captured_at,
          entity_type,entity_id,entity_label,matched_alias,occurrence_index,
          char_start,char_end,first_token_index,prominence,
          sentiment_label,sentiment_score,sentiment_confidence,sentiment_method,render_score)
       VALUES ($1,$2,$3,$4,'chatgpt',$5::timestamptz,$6,$7,$8,$9,0,0,1,0,0.3,'positive',0.5,0.9,'lexicon',0.4)`,
      [
        workspaceId, options.project ?? projectId, randomUUID(), promptId, capturedAt,
        options.type ?? "other", options.entityId ?? null, label, options.alias ?? label,
      ],
    );
  }

  const track = (body: { name: string; root_domain?: string; aliases?: string[] }, project = projectId) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
      service.track(workspaceId, randomUUID(), project, body),
    );
  const untrack = (competitorId: string, project = projectId) =>
    withTenantContext(db, { workspaceId, actorId: randomUUID() }, () =>
      service.untrack(workspaceId, randomUUID(), project, competitorId),
    );

  async function counts() {
    const [ledger, captures] = await Promise.all([
      db.query("SELECT count(*)::int AS n FROM credit_ledger"),
      db.query("SELECT count(*)::int AS n FROM answer_captures"),
    ]);
    return { ledger: ledger.rows[0].n as number, captures: captures.rows[0].n as number };
  }

  it("STORY-092 #3 — promotion re-tags this project's matching `other` facts, in the contract's shape", async () => {
    await addFact("Pipedrive", { daysAgo: 1 });
    await addFact("Pipedrive", { daysAgo: 1 });
    await addFact("pipedrive", { daysAgo: 3 });
    await addFact("Pipedrive", { daysAgo: 5 });
    await addFact("Zoho", { daysAgo: 2 });
    await addFact("Pipedrive", { daysAgo: 2, project: otherProjectId });

    const result = await track({ name: "Pipedrive" });
    expect(trackCompetitorResponseSchema.safeParse(result).success).toBe(true);
    expect(result).toMatchObject({ name: "Pipedrive", backfilled_days: 3, credits_charged: 0 });

    const moved = await db.query(
      "SELECT entity_type, entity_id FROM mention_facts WHERE project_id = $1 AND lower(entity_label) = 'pipedrive'",
      [projectId],
    );
    expect(moved.rows).toHaveLength(4);
    for (const row of moved.rows) expect(row).toEqual({ entity_type: "competitor", entity_id: result.entity_id });

    // Not matched: a different label, and the same label in ANOTHER project.
    const untouched = await db.query(
      "SELECT entity_type, entity_id FROM mention_facts WHERE entity_label = 'Zoho' OR project_id = $1",
      [otherProjectId],
    );
    expect(untouched.rows).toHaveLength(2);
    for (const row of untouched.rows) expect(row).toEqual({ entity_type: "other", entity_id: null });

    const row = await db.query("SELECT name, source, deleted_at FROM competitors WHERE id = $1", [result.entity_id]);
    expect(row.rows[0]).toEqual({ name: "Pipedrive", source: "user", deleted_at: null });
  });

  it("STORY-092 #3 — a fact matched by a supplied alias is re-tagged too; one already tagged is left alone", async () => {
    const other = randomUUID();
    await addFact("HubSpot CRM Rival", { alias: "pipedrive.com" });
    await addFact("Pipedrive", { type: "competitor", entityId: other });
    const result = await track({ name: "Pipedrive", aliases: ["pipedrive.com"] });
    expect(result.backfilled_days).toBe(1);
    const rows = await db.query("SELECT entity_id FROM mention_facts ORDER BY entity_label");
    expect(rows.rows.map((r) => r.entity_id).sort()).toEqual([other, result.entity_id].sort());
  });

  it("STORY-092 #3 — promotion charges nothing, captures nothing, and asks for a recompute of the affected dates", async () => {
    await addFact("Pipedrive", { daysAgo: 10 });
    await addFact("Pipedrive", { daysAgo: 2 });
    const before = await counts();
    const result = await track({ name: "Pipedrive" });
    expect(await counts()).toEqual(before);
    expect(before).toEqual({ ledger: 0, captures: 0 });

    expect(enqueued).toHaveLength(1);
    const [job] = enqueued;
    expect(job!.name).toBe("rollup.metric_daily");
    expect(job!.workspaceId).toBe(workspaceId);
    const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    expect(job!.payload).toMatchObject({ projectId, fromDate: day(10), toDate: day(2) });
    expect(job!.options.idempotencyKey).toContain(result.entity_id);
  });

  it("STORY-092 #3 — nothing stored under the name: backfilled_days is 0 (not absent), and no recompute is enqueued", async () => {
    await addFact("Zoho");
    const result = await track({ name: "Pipedrive" });
    expect(result.backfilled_days).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(await counts()).toEqual({ ledger: 0, captures: 0 });
  });

  it("STORY-092 #5 — adding a competitor inserts a competitor_added milestone", async () => {
    const result = await track({ name: "Pipedrive" });
    const rows = await db.query("SELECT kind, title, detail, project_id FROM milestones");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ kind: "competitor_added", project_id: projectId });
    expect(rows.rows[0].title).toContain("Pipedrive");
    expect(rows.rows[0].title.toLowerCase()).toContain("added");
    expect(result.entity_id).toBeDefined();
  });

  it("STORY-092 #6 — removing a competitor soft-deletes it, inserts a milestone, and re-tags nothing", async () => {
    const { entity_id } = await track({ name: "Pipedrive" });
    await addFact("Pipedrive", { type: "competitor", entityId: entity_id });
    await db.query("DELETE FROM milestones");

    await untrack(entity_id);

    const row = await db.query("SELECT deleted_at FROM competitors WHERE id = $1", [entity_id]);
    expect(row.rows[0].deleted_at).not.toBeNull();
    const fact = await db.query("SELECT entity_type, entity_id FROM mention_facts");
    expect(fact.rows).toEqual([{ entity_type: "competitor", entity_id }]);
    const milestones = await db.query("SELECT kind, title FROM milestones");
    expect(milestones.rows).toHaveLength(1);
    expect(milestones.rows[0].kind).toBe("competitor_added");
    expect(milestones.rows[0].title.toLowerCase()).toContain("removed");
    expect(milestones.rows[0].title).toContain("Pipedrive");
    expect(await counts()).toEqual({ ledger: 0, captures: 0 });
  });

  it("STORY-092 #6 — removing an unknown, foreign-project or already-removed competitor is 404 and writes no milestone", async () => {
    const { entity_id } = await track({ name: "Pipedrive" });
    await db.query("DELETE FROM milestones");
    await expect(untrack(randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    await expect(untrack(entity_id, otherProjectId)).rejects.toBeInstanceOf(NotFoundError);
    await untrack(entity_id);
    await expect(untrack(entity_id)).rejects.toBeInstanceOf(NotFoundError);
    expect((await db.query("SELECT count(*)::int AS n FROM milestones")).rows[0].n).toBe(1);
  });

  it("FR-CO-02 — over the cap: entitlement_exceeded with {key, limit, current}, and nothing written", async () => {
    cap = 2;
    await track({ name: "A" });
    await track({ name: "B" });
    await addFact("Pipedrive");
    await db.query("DELETE FROM milestones");
    enqueued = [];

    const error = await track({ name: "Pipedrive" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EntitlementExceededError);
    expect((error as EntitlementExceededError).details).toEqual({ key: "competitors.max_per_project", limit: 2, current: 2 });
    expect((await db.query("SELECT count(*)::int AS n FROM competitors")).rows[0].n).toBe(2);
    expect((await db.query("SELECT entity_type FROM mention_facts")).rows).toEqual([{ entity_type: "other" }]);
    expect((await db.query("SELECT count(*)::int AS n FROM milestones")).rows[0].n).toBe(0);
    expect(enqueued).toHaveLength(0);
  });

  it("FR-CO-02 — a removed competitor frees its slot at the cap", async () => {
    cap = 1;
    const { entity_id } = await track({ name: "A" });
    await untrack(entity_id);
    await expect(track({ name: "B" })).resolves.toMatchObject({ name: "B" });
  });

  it("FR-CO-02 — tracking a name already tracked (any case) is a 409, not a second row", async () => {
    await track({ name: "Pipedrive" });
    await expect(track({ name: "PIPEDRIVE" })).rejects.toBeInstanceOf(ConflictError);
    expect((await db.query("SELECT count(*)::int AS n FROM competitors")).rows[0].n).toBe(1);
  });

  it("FR-CO-02 — re-tracking a removed competitor revives it under the SAME id, so its earlier history stays connected", async () => {
    const first = await track({ name: "Pipedrive" });
    await addFact("Pipedrive", { type: "competitor", entityId: first.entity_id });
    await untrack(first.entity_id);
    const second = await track({ name: "Pipedrive" });
    expect(second.entity_id).toBe(first.entity_id);
    expect((await db.query("SELECT deleted_at FROM competitors")).rows).toEqual([{ deleted_at: null }]);
  });

  it("tracking into a project the caller cannot see is 404", async () => {
    await expect(track({ name: "X" }, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });
});
