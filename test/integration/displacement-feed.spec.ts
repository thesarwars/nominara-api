import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { displacementFeedQuerySchema, displacementItemSchema } from "../../contracts/analytics/index.js";
import { DEMO_SEED_MARKER } from "../../src/db/seed/demo/constants.js";
import { uuidV7 } from "../../src/lib/ids/uuidv7.js";
import { DisplacementService } from "../../src/modules/displacement/displacement.service.js";
import { withTenantContext } from "../../src/tenancy/tenant-context.js";

// NEW-C-5 — GET /v1/projects/{id}/displacements, POST /v1/displacements/{id}/dismiss and /restore.
// STORY-092 scenarios 7, 8 and 15 (backend half). Migration 0099 adds dismissed_at / dismissed_by.
//
// EVERY TENANCY ASSERTION RUNS UNDER `SET ROLE nominara_app`: the owning role bypasses RLS and would pass
// "another workspace gets 404" for the wrong reason.
const MIGRATION = "0099_displacement_dismissal";

describe("NEW-C-5 · displacement feed, dismiss and restore", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let otherWorkspaceId: string;
  let projectId: string;
  let promptId: string;
  let actorId: string;
  const service = new DisplacementService();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db, MIGRATIONS_DIR);
  }, 300_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE displacement_events, source_domains, answer_captures, tracked_prompts, projects, workspaces CASCADE");
    await db.query("TRUNCATE users CASCADE");
    actorId = (await db.query("INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id", [`a-${randomUUID()}@example.com`])).rows[0].id;
    workspaceId = randomUUID();
    otherWorkspaceId = randomUUID();
    projectId = randomUUID();
    promptId = randomUUID();
    for (const id of [workspaceId, otherWorkspaceId]) {
      await db.query("INSERT INTO workspaces (id,name,slug,plan_key,timezone) VALUES ($1,'W',$2,'growth','UTC')", [id, `w-${id.slice(0, 8)}`]);
    }
    await db.query(
      "INSERT INTO projects (id,workspace_id,name,slug,root_url,root_domain) VALUES ($1,$2,'P',$3,'https://p.com','p.com')",
      [projectId, workspaceId, `p-${projectId.slice(0, 8)}`],
    );
    await db.query(
      `INSERT INTO tracked_prompts (id,workspace_id,project_id,text,text_hash,intent_archetype,funnel_stage,is_priority,status)
       VALUES ($1,$2,$3,'q',sha256('q'::bytea),'recommendation','consideration',false,'active')`,
      [promptId, workspaceId, projectId],
    );
  });

  async function capture(normalizer = "n1"): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO answer_captures
         (id,workspace_id,project_id,run_id,prompt_id,engine_key,captured_at,capture_mode,adapter_version,
          normalizer_version,content_hash,payload,flags,cache_layer,status,brand_present)
       VALUES ($1,$2,$3,$4,$5,'gemini',now(),'api','1.0.0',$6,$7,'{}'::jsonb,'{}','live','parsed',true)`,
      [id, workspaceId, projectId, uuidV7(), promptId, normalizer, createHash("sha256").update(id).digest()],
    );
    return id;
  }

  const taker = { entity_label: "Rival", entity_id: null, is_tracked: false, position: 1, prominence: 0.4, position_class: "recommendation", citations: [] };
  const gapEntry = (domain: string) => ({ url: `https://${domain}/x`, domain, source_class: "blog", held_by: ["Rival"], brand_present: false });

  async function displacement(
    options: {
      impact?: number;
      engine?: string;
      kind?: string;
      recovered?: boolean;
      dismissed?: boolean;
      normalizer?: string;
      citationGap?: unknown[];
      conceptGap?: unknown[];
      before?: string;
      after?: string;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    const before = options.before ?? (await capture(options.normalizer));
    const after = options.after ?? (await capture(options.normalizer));
    await db.query(
      `INSERT INTO displacement_events
         (id,workspace_id,project_id,prompt_id,engine_key,kind,before_result_id,after_result_id,
          displaced_by,citation_gap,concept_gap,impact_score,recovered_at,dismissed_at,dismissed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15)`,
      [
        id, workspaceId, projectId, promptId, options.engine ?? "gemini", options.kind ?? "position_lost", before, after,
        JSON.stringify([taker]), JSON.stringify(options.citationGap ?? []), JSON.stringify(options.conceptGap ?? []),
        options.impact ?? 0.5,
        options.recovered ? new Date().toISOString() : null,
        options.dismissed ? new Date().toISOString() : null,
        options.dismissed ? actorId : null,
      ],
    );
    return id;
  }

  const feed = (raw: Record<string, string> = {}, ws = workspaceId, project = projectId) =>
    withTenantContext(db, { workspaceId: ws, actorId }, () => service.feed(project, displacementFeedQuerySchema.parse(raw)));
  const dismiss = (id: string, ws = workspaceId) => withTenantContext(db, { workspaceId: ws, actorId }, () => service.dismiss(id));
  const restore = (id: string, ws = workspaceId) => withTenantContext(db, { workspaceId: ws, actorId }, () => service.restore(id));

  it("STORY-092 #7 — the feed is ordered by impact_score descending, and engine and kind filters narrow it", async () => {
    const low = await displacement({ impact: 0.2 });
    const high = await displacement({ impact: 0.9, engine: "chatgpt", kind: "presence_lost" });
    const mid = await displacement({ impact: 0.5, kind: "render_downgraded" });

    const all = await feed();
    expect(all.items.map((i) => i.id)).toEqual([high, mid, low]);
    for (const item of all.items) expect(displacementItemSchema.safeParse(item).success).toBe(true);

    expect((await feed({ engine: "chatgpt" })).items.map((i) => i.id)).toEqual([high]);
    expect((await feed({ kind: "render_downgraded" })).items.map((i) => i.id)).toEqual([mid]);
    expect((await feed({ engine: "gemini", kind: "position_lost" })).items.map((i) => i.id)).toEqual([low]);
  });

  it("STORY-092 #7 — paging by (impact_score, id) neither skips nor repeats a row, including equal scores", async () => {
    const ids = [] as string[];
    for (const impact of [0.5, 0.5, 0.5, 0.7, 0.1]) ids.push(await displacement({ impact }));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await feed({ limit: "2", ...(cursor === undefined ? {} : { cursor }) });
      seen.push(...result.items.map((i) => i.id));
      cursor = result.pagination.cursor_next ?? undefined;
      if (cursor === undefined) break;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it("STORY-092 #8 — a recovered loss is included and marked with recovered_at; an open one has null", async () => {
    const open = await displacement({ impact: 0.4 });
    const recovered = await displacement({ impact: 0.6, recovered: true });
    const items = (await feed()).items;
    expect(items.map((i) => i.id)).toEqual([recovered, open]);
    expect(items[0]!.recovered_at).not.toBeNull();
    expect(items[1]!.recovered_at).toBeNull();
  });

  it("NEW-C-5 AC2 — dismissed rows are left out unless include_dismissed=true", async () => {
    const kept = await displacement({ impact: 0.4 });
    const gone = await displacement({ impact: 0.8, dismissed: true });
    expect((await feed()).items.map((i) => i.id)).toEqual([kept]);
    const withDismissed = (await feed({ include_dismissed: "true" })).items;
    expect(withDismissed.map((i) => i.id)).toEqual([gone, kept]);
    expect(withDismissed[0]!.dismissed_at).not.toBeNull();
  });

  it("NEW-C-5 AC1 — a row whose before or after capture is not stored does not render", async () => {
    const ok = await displacement({});
    await displacement({ before: randomUUID() });
    await displacement({ after: randomUUID() });
    expect((await feed()).items.map((i) => i.id)).toEqual([ok]);
  });

  it("NEW-C-5 AC1 — takers, citation_gap and recovery_task_count: one task per concept, one per SEEDABLE citation gap", async () => {
    await db.query("INSERT INTO source_domains (workspace_id, domain, is_seedable) VALUES ($1,'seed.com',true),($1,'closed.com',false)", [workspaceId]);
    const id = await displacement({
      citationGap: [gapEntry("seed.com"), gapEntry("closed.com"), gapEntry("unknown.com")],
      conceptGap: [{ concept: "pricing", prevalence: 0.6, evidence_url: "https://e.com" }],
    });
    const [item] = (await feed()).items;
    expect(item!.id).toBe(id);
    expect(item!.takers).toEqual([taker]);
    expect(item!.citation_gap.map((g) => g.domain)).toEqual(["seed.com", "closed.com", "unknown.com"]);
    expect(Object.keys(item!.citation_gap[0]!).sort()).toEqual(["brand_present", "domain", "held_by", "source_class", "url"]);
    expect(item!.recovery_task_count).toBe(2);
  });

  it("NEW-C-5 AC1 — a seedable domain of ANOTHER workspace does not count", async () => {
    await db.query("INSERT INTO source_domains (workspace_id, domain, is_seedable) VALUES ($1,'seed.com',true)", [otherWorkspaceId]);
    await displacement({ citationGap: [gapEntry("seed.com")] });
    expect((await feed()).items[0]!.recovery_task_count).toBe(0);
  });

  it("NEW-C-5 AC1 — data_source: seeded captures read demo, real ones live, one of each mixed", async () => {
    await displacement({ normalizer: DEMO_SEED_MARKER, impact: 0.3 });
    await displacement({ normalizer: "n1", impact: 0.2 });
    await displacement({ before: await capture(DEMO_SEED_MARKER), after: await capture("n1"), impact: 0.1 });
    expect((await feed()).items.map((i) => i.data_source)).toEqual(["demo", "live", "mixed"]);
  });

  it("NEW-C-5 AC1 — an empty feed is an empty page, not an error", async () => {
    const page = await feed();
    expect(page.items).toEqual([]);
    expect(page.pagination).toMatchObject({ has_more: false, cursor_next: null });
  });

  it("STORY-092 #15 — dismiss then restore: reversible, and the actor and time are recorded", async () => {
    const id = await displacement({});
    const dismissed = await dismiss(id);
    expect(dismissed.dismissed_at).not.toBeNull();
    const row = (await db.query("SELECT dismissed_at, dismissed_by FROM displacement_events WHERE id = $1", [id])).rows[0];
    expect(row.dismissed_by).toBe(actorId);
    expect(row.dismissed_at).not.toBeNull();
    expect((await feed()).items).toEqual([]);

    const restored = await restore(id);
    expect(restored).toEqual({ id, dismissed_at: null });
    const after = (await db.query("SELECT dismissed_at, dismissed_by FROM displacement_events WHERE id = $1", [id])).rows[0];
    expect(after).toEqual({ dismissed_at: null, dismissed_by: null });
    expect((await feed()).items.map((i) => i.id)).toEqual([id]);
  });

  it("NEW-C-5 AC3 — restoring a row that is not dismissed is 409", async () => {
    const id = await displacement({});
    await expect(restore(id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("NEW-C-5 AC3 — dismissing twice keeps the first timestamp", async () => {
    const id = await displacement({});
    const first = await dismiss(id);
    const second = await dismiss(id);
    expect(second.dismissed_at).toBe(first.dismissed_at);
  });

  it("NEW-C-5 AC3 — concurrent restores: exactly one succeeds, the other is 409", async () => {
    const id = await displacement({ dismissed: true });
    const other = new Client({ connectionString: container.getConnectionUri() });
    await other.connect();
    try {
      const run = (client: Client) => withTenantContext(client, { workspaceId, actorId }, () => service.restore(id));
      const results = await Promise.allSettled([run(db), run(other)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    } finally {
      await other.end();
    }
  });

  it("NEW-C-5 AC5 — under nominara_app, another workspace's displacement id is 404 on dismiss and restore, and the row is untouched", async () => {
    const id = await displacement({ dismissed: true });
    const open = await displacement({});
    await db.query("SET ROLE nominara_app");
    try {
      await expect(dismiss(open, otherWorkspaceId)).rejects.toMatchObject({ code: "not_found" });
      await expect(restore(id, otherWorkspaceId)).rejects.toMatchObject({ code: "not_found" });
      await expect(dismiss(open)).resolves.toBeDefined();
    } finally {
      await db.query("RESET ROLE");
    }
    const row = (await db.query("SELECT dismissed_at FROM displacement_events WHERE id = $1", [id])).rows[0];
    expect(row.dismissed_at).not.toBeNull();
  });

  it("NEW-C-5 AC5 — under nominara_app, another workspace reading this project's feed gets 404, never an empty page", async () => {
    await displacement({});
    await db.query("SET ROLE nominara_app");
    try {
      await expect(feed({}, otherWorkspaceId)).rejects.toMatchObject({ code: "not_found" });
      await expect(feed({}, workspaceId)).resolves.toBeDefined();
    } finally {
      await db.query("RESET ROLE");
    }
  });

  it("NEW-C-5 AC5 — a scoped member outside the project's scope gets 403 on dismiss", async () => {
    const id = await displacement({});
    await db.query("SET ROLE nominara_app");
    try {
      await expect(
        withTenantContext(db, { workspaceId, actorId, scopeProjectIds: [randomUUID()] }, () => service.dismiss(id)),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      await db.query("RESET ROLE");
    }
  });

  async function rollbackThisMigration(): Promise<void> {
    for (let step = 0; step < 200; step += 1) {
      const name = await rollbackLast(db, MIGRATIONS_DIR);
      if (name === MIGRATION) return;
      expect(name).not.toBeNull();
    }
    throw new Error(`${MIGRATION} was never rolled back`);
  }

  it("NEW-C-5 migration — 0099 down removes both columns, keeps the rows, and up re-applies", async () => {
    const id = await displacement({ dismissed: true });
    await rollbackThisMigration();
    const columns = await db.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'displacement_events' AND column_name IN ('dismissed_at','dismissed_by')",
    );
    expect(columns.rows).toEqual([]);
    expect((await db.query("SELECT id FROM displacement_events WHERE id = $1", [id])).rowCount).toBe(1);
    const applied = await migrateUp(db, MIGRATIONS_DIR);
    expect(applied).toContain(MIGRATION);
    expect((await db.query("SELECT dismissed_at FROM displacement_events WHERE id = $1", [id])).rows[0].dismissed_at).toBeNull();
  });
});
