import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { ARCHETYPES } from "../../src/lib/promptgen/archetypes.js";
import { emitCandidates } from "../../src/lib/promptgen/emit.js";
import { insertPromptStatement, manualPromptRow, promptRowFromCandidate } from "../../src/lib/promptgen/persist.js";
import { prioritise } from "../../src/lib/promptgen/prioritise.js";
import { resolveSlots } from "../../src/lib/promptgen/slots.js";

// STORY-045 — the statement, EXECUTED.
//
// *** THIS SPEC EXISTS BECAUSE A SHIPPED INSERT COULD NOT RUN. ***
//
// STORY-043's supplied-prompt insert omitted `text_hash`, `intent_archetype`
// and `funnel_stage` — three NOT NULL columns with no default — so
// `POST /v1/projects` with any `prompts` in the body has been answering 500
// since it shipped, on `null value in column "text_hash" violates not-null
// constraint`.
//
// Two suites covered that code and neither could catch it. The unit test
// asserts the SQL STRING contains `'manual'` against a stubbed client
// (projects.service.spec.ts scenario 8) — a statement that can never execute
// satisfies it perfectly. The integration test writes its OWN correct insert
// rather than calling the service (projects-prompts-captures.spec.ts), so the
// service's statement is never the thing under test.
//
// The gap between "the SQL text looks right" and "the SQL runs" is what this
// file closes, for both callers, against real migrations and the real
// constraints. Nothing here asserts on a string.

describe("STORY-045 · tracked_prompts inserts actually execute", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
  }, 240_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  beforeEach(async () => {
    await db.query("TRUNCATE tracked_prompts, projects, workspaces CASCADE");
    workspaceId = randomUUID();
    projectId = randomUUID();
    await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1, 'W', $2, 'growth')", [
      workspaceId,
      `w-${randomUUID().slice(0, 8)}`,
    ]);
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'HubSpot CRM', $3, 'https://hubspot.com', 'hubspot.com')`,
      [projectId, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
  });

  async function run(row: Parameters<typeof insertPromptStatement>[0]): Promise<void> {
    const { sql, params } = insertPromptStatement(row);
    await db.query(sql, [...params]);
  }

  function generated() {
    const bag = resolveSlots({
      brandName: "HubSpot CRM",
      categorySlug: "crm",
      competitors: ["Salesforce"],
      personas: ["marketing_director"],
      verticals: ["b2b_saas"],
      sizeBands: ["mid_market"],
      integrations: ["slack"],
      complianceTerms: ["soc2"],
      capabilities: ["pipeline_automation"],
    });
    return prioritise(emitCandidates({ bag, archetypes: ARCHETYPES, batchSize: 1 }).candidates, 6);
  }

  // ---------------------------------------------------------------------------
  // The regression itself.
  // ---------------------------------------------------------------------------

  it("a MANUAL prompt inserts — the exact statement STORY-043 could not run", async () => {
    await run(manualPromptRow({ workspaceId, projectId, text: "best crm for a 50-rep sales team" }));

    const stored = await db.query<{ text_hash: Buffer; intent_archetype: string; funnel_stage: string; status: string }>(
      "SELECT text_hash, intent_archetype, funnel_stage, status FROM tracked_prompts WHERE project_id = $1",
      [projectId],
    );
    expect(stored.rows).toHaveLength(1);
    // The three columns whose absence was the bug, present and non-null.
    expect(stored.rows[0]?.text_hash).toBeInstanceOf(Buffer);
    expect(stored.rows[0]?.intent_archetype).toBe("custom");
    expect(stored.rows[0]?.funnel_stage).toBe("consideration");
    expect(stored.rows[0]?.status).toBe("active");
  });

  it("a full GENERATED pass inserts, all fifteen rows", async () => {
    const candidates = generated();
    const generationBatchId = randomUUID();
    for (const candidate of candidates) {
      await run(promptRowFromCandidate(candidate, { workspaceId, projectId, generationBatchId }));
    }

    const stored = await db.query<{ n: string }>("SELECT count(*)::text AS n FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(stored.rows[0]?.n).toBe(String(candidates.length));
    expect(candidates).toHaveLength(15);
  });

  // ---------------------------------------------------------------------------
  // Constraints the row builder has to satisfy, proven by the database.
  // ---------------------------------------------------------------------------

  it("every intent_archetype the grammar emits satisfies the column's CHECK", async () => {
    // The CHECK lists sixteen values by name. A grammar that added an
    // archetype without the migration would fail here and nowhere else —
    // a unit test comparing our own enum against our own grammar cannot see
    // it, because both sides would be wrong together.
    const generationBatchId = randomUUID();
    for (const candidate of generated()) {
      await expect(run(promptRowFromCandidate(candidate, { workspaceId, projectId, generationBatchId }))).resolves.toBeUndefined();
    }
  });

  it("`custom` is accepted by the CHECK, so a manual prompt is storable at all", async () => {
    await expect(run(manualPromptRow({ workspaceId, projectId, text: "anything" }))).resolves.toBeUndefined();
  });

  it("generator_meta round-trips as jsonb, not as a string", async () => {
    const [candidate] = generated();
    await run(promptRowFromCandidate(candidate!, { workspaceId, projectId, generationBatchId: randomUUID() }));

    const stored = await db.query<{ meta: Record<string, unknown> }>(
      "SELECT generator_meta AS meta FROM tracked_prompts WHERE project_id = $1",
      [projectId],
    );
    // `pg` returns jsonb as a parsed object. A row that stored the JSON as a
    // quoted string would come back as a string here — which is how a
    // `->>'template_id'` query silently returns nothing later.
    expect(typeof stored.rows[0]?.meta).toBe("object");
    expect(stored.rows[0]?.meta).toMatchObject({ template_id: candidate!.templateId, grammar_version: expect.any(String) });
  });

  it("a duplicate text_hash in the same project is REJECTED by the unique index", async () => {
    // `ux_prompts_project_hash` on (project_id, text_hash) WHERE deleted_at
    // IS NULL. The statement has no ON CONFLICT deliberately: a collision is
    // FR-FAN-01a's `rejected_duplicate`, which the caller has to report and
    // name the kept prompt for. Swallowing it would drop a variant while the
    // response claimed it was accepted.
    await run(manualPromptRow({ workspaceId, projectId, text: "best crm" }));
    await expect(run(manualPromptRow({ workspaceId, projectId, text: "  Best   CRM " }))).rejects.toThrow(/ux_prompts_project_hash|duplicate key/);
  });

  it("the SAME text in a DIFFERENT project is accepted", async () => {
    // The index is scoped to the project, and two customers asking the same
    // question is the normal case — it is what makes L1's cross-tenant
    // sharing worth having.
    const otherProject = randomUUID();
    await db.query(
      `INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain)
       VALUES ($1, $2, 'Other', $3, 'https://other.com', 'other.com')`,
      [otherProject, workspaceId, `p-${randomUUID().slice(0, 8)}`],
    );
    await run(manualPromptRow({ workspaceId, projectId, text: "best crm" }));
    await expect(run(manualPromptRow({ workspaceId, projectId: otherProject, text: "best crm" }))).resolves.toBeUndefined();
  });

  it("an archived generated variant consumes no plan slot", async () => {
    // `PROMPT_OCCUPIES_SLOT` in src/lib/entitlements/structural-usage.ts is
    // `status <> 'archived' AND deleted_at IS NULL`. FR-FAN-01g requires
    // generation to be uncapped, and this is the mechanism that makes it so —
    // asserted against the same predicate the entitlement counter uses.
    const generationBatchId = randomUUID();
    for (const candidate of generated()) {
      await run(promptRowFromCandidate(candidate, { workspaceId, projectId, generationBatchId }));
    }
    const occupying = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tracked_prompts WHERE workspace_id = $1 AND status <> 'archived' AND deleted_at IS NULL",
      [workspaceId],
    );
    expect(occupying.rows[0]?.n).toBe("0");
  });

  it("a manual prompt DOES consume a plan slot", async () => {
    // The other half of the same predicate — and the reason the two callers
    // differ on `status` rather than sharing a default.
    await run(manualPromptRow({ workspaceId, projectId, text: "best crm" }));
    const occupying = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM tracked_prompts WHERE workspace_id = $1 AND status <> 'archived' AND deleted_at IS NULL",
      [workspaceId],
    );
    expect(occupying.rows[0]?.n).toBe("1");
  });
});
