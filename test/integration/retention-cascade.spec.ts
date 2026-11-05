import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECHAINED_MARKER_ACTION } from "../../src/lib/crypto/audit-chain.js";
import { pseudonymiseWorkspaceId } from "../../src/lib/crypto/pseudonymise.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { SYSTEM_ACTOR_ID } from "../../src/tenancy/constants.js";
import { SessionService } from "../../src/modules/identity/session.service.js";
import { InMemoryCacheAdapter } from "../../src/lib/cache/in-memory-cache.adapter.js";
import { MembershipService } from "../../src/modules/workspaces/membership.service.js";
import { MembershipCacheService } from "../../src/tenancy/membership-cache.js";
import { importEd25519PublicKeyFromDer, verifyAccessToken } from "../../src/lib/auth/access-token.js";
import { applyFakeApiEnv } from "../support/fake-env.js";
import { HARNESS_PUBLIC_KEY_DER } from "../support/api-harness.js";
import {
  collectComplianceExport,
  executeWorkspaceHardDelete,
  expireAttributionDaily,
  expireDerivedAnalyses,
  expireRawCaptures,
  expireRollups,
  expireToolSnapshotsForWorkspace,
  hardDeleteProject,
  requestIndividualErasure,
  requestWorkspaceDeletion,
  resolveRetentionCutoff,
  resolveWorkspaceRetention,
  runDailyPurgeCycle,
  runOrphanScan,
  scanForOrphans,
  SOLE_OWNER_ERASURE_BLOCK_REASON,
  softDeleteProject,
  tryPurgeProject,
  withExportLock,
  workspaceProjectsWithOpenExports,
} from "../../src/workers/rollup/retention.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";

// STORY-013 · retention cascade + orphan scan — Test Scenarios 8-15 + widen
// pass. One shared container, full migration chain applied ONCE.
//
// Runtime-role discipline (qa-reviewer blocking #4, fix pass): `client`
// (superuser) is used ONLY to fabricate fixtures and to inspect DB state
// after a call — NEVER to exercise a function this story's own PRIVILEGE
// CONTRACT (retention.ts's header comment) says is safe on the ordinary
// `nominara_worker` runtime role. Every genuinely workspace/project-scoped
// function (softDeleteProject, hardDeleteProject, requestWorkspaceDeletion,
// the five expire* functions, tryPurgeProject, withExportLock) is called
// below on `workerClient`, a real `nominara_worker` connection — a
// superuser bypasses RLS by an entirely different mechanism than FORCE ROW
// LEVEL SECURITY addresses, so asserting against a superuser connection
// would pass vacuously regardless of whether any policy actually works.
//
// The functions that genuinely CANNOT run on `nominara_worker` — cross-
// tenant discovery with no context set (scanForOrphans/runOrphanScan,
// workspaceProjectsWithOpenExports, resolveWorkspaceRetention,
// collectComplianceExport) and the two DDL-privileged erasure functions
// (executeWorkspaceHardDelete, requestIndividualErasure) — stay on `client`,
// with a dedicated proof test each demonstrating exactly why `nominara_worker`
// cannot do their job, rather than merely asserting it in a comment.
describe("STORY-013 · retention cascade, sole-owner block, orphan scan, export lock", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;
  let workerClient: Client;
  let seq = 0;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client, MIGRATIONS_DIR);

    await client.query(`ALTER ROLE nominara_worker PASSWORD ${client.escapeLiteral(resolvePassword("nominara_worker", {}))}`);
    workerClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_worker",
      resolvePassword("nominara_worker", {}),
    );
  }, 180_000);

  afterAll(async () => {
    await workerClient.end();
    await client.end();
    await container.stop();
  });

  async function createWorkspace(planKey = "free"): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, $3) RETURNING id",
      [`Workspace ${seq}`, `ws-${seq}-${Math.random().toString(36).slice(2)}`, planKey],
    );
    return result.rows[0]!.id;
  }

  async function createProject(workspaceId: string): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [workspaceId, `Project ${seq}`, `project-${seq}-${Math.random().toString(36).slice(2)}`, "https://example.com", "example.com"],
    );
    return result.rows[0]!.id;
  }

  async function createUser(): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [
      `user-${seq}-${Math.random().toString(36).slice(2)}@example.com`,
    ]);
    return result.rows[0]!.id;
  }

  async function addOwner(workspaceId: string, userId: string): Promise<void> {
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')", [
      workspaceId,
      userId,
    ]);
  }

  async function insertCapture(
    workspaceId: string,
    projectId: string,
    capturedAt: Date,
    overrides: Partial<{ rawObjectKey: string | null; responseExcerpt: string }> = {},
  ): Promise<string> {
    seq += 1;
    const { rawObjectKey = `raw/${seq}.json`, responseExcerpt = "excerpt text" } = overrides;
    const result = await client.query<{ id: string }>(
      `INSERT INTO answer_captures
         (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
          capture_mode, adapter_version, normalizer_version, content_hash, raw_object_key, response_excerpt)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', $3, 'api', 'v1', 'v1', decode('00', 'hex'), $4, $5)
       RETURNING id`,
      [workspaceId, projectId, capturedAt.toISOString(), rawObjectKey, responseExcerpt],
    );
    return result.rows[0]!.id;
  }

  async function insertMentionFactOrphan(workspaceId: string, projectId: string, capturedAt: Date): Promise<void> {
    await client.query(
      `INSERT INTO mention_facts
         (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at,
          entity_type, entity_label, matched_alias, occurrence_index, char_start, char_end,
          first_token_index, prominence, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', $3,
               'brand', 'Acme', 'acme', 0, 0, 4, 0, 0.5, 'neutral', 0, 1, 'heuristic')`,
      [workspaceId, projectId, capturedAt.toISOString()],
    );
  }

  async function insertMilestone(workspaceId: string, projectId: string, createdBy?: string): Promise<string> {
    const result = await client.query<{ id: string }>(
      `INSERT INTO milestones (workspace_id, project_id, occurred_at, kind, title, created_by)
       VALUES ($1, $2, now(), 'annotation', 'Milestone', $3) RETURNING id`,
      [workspaceId, projectId, createdBy ?? null],
    );
    return result.rows[0]!.id;
  }

  async function insertMetricDaily(workspaceId: string, projectId: string, metricDate: string): Promise<void> {
    await client.query(
      `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date)
       VALUES ($1, $2, 'chatgpt', 'brand', gen_random_uuid(), $3)`,
      [workspaceId, projectId, metricDate],
    );
  }

  async function insertToolRun(workspaceId: string, expiresAt: Date): Promise<string> {
    seq += 1;
    const result = await client.query<{ id: string }>(
      `INSERT INTO tool_runs
         (workspace_id, tool_key, brand_name, query_text, engine_keys, input_hash, result_json,
          sov_estimate, citation_count, brand_present, expires_at)
       VALUES ($1, 'visibility_scan', 'Acme', 'acme reviews', ARRAY['chatgpt'], $2, '{"raw":"payload"}'::jsonb,
               0.42, 3, true, $3)
       RETURNING id`,
      [workspaceId, createHash("sha256").update(`tool-${seq}`).digest(), expiresAt.toISOString()],
    );
    return result.rows[0]!.id;
  }

  async function insertGeoAnalysis(workspaceId: string, projectId: string, computedAt: Date): Promise<void> {
    await client.query(
      `INSERT INTO geo_analyses (workspace_id, project_id, analysis, window_start, window_days, computed_at)
       VALUES ($1, $2, 'entity', '2020-01-01', 30, $3)`,
      [workspaceId, projectId, computedAt.toISOString()],
    );
  }

  async function insertAttributionDaily(workspaceId: string, projectId: string, metricDate: string): Promise<void> {
    await client.query(
      `INSERT INTO attribution_daily
         (workspace_id, project_id, metric_date, landing_url_hash, landing_url, referrer_class, country, device)
       VALUES ($1, $2, $3, decode('00', 'hex'), 'https://example.com/', 'chatgpt', 'US', 'desktop')`,
      [workspaceId, projectId, metricDate],
    );
  }

  async function insertAuditLog(workspaceId: string, actorId: string): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (workspace_id, actor_type, actor_id, action, resource_type, request_id, prev_hash, row_hash)
       VALUES ($1, 'user', $2, 'test.action', 'workspace', 'req-1', decode('00', 'hex'), decode('00', 'hex'))`,
      [workspaceId, actorId],
    );
  }

  async function insertCreditLedger(workspaceId: string, actorId: string): Promise<void> {
    seq += 1;
    await client.query(
      // `bucket` since STORY-073's migration 0023: a `grant` that does not
      // say which of the two balances it moved cannot be replayed, and
      // `ck_credit_ledger_bucket_scope` refuses it.
      `INSERT INTO credit_ledger
         (workspace_id, actor_id, entry_type, credits, bucket, included_after, purchased_after, reserved_after,
          idempotency_key)
       VALUES ($1, $2, 'grant', 10, 'included', 10, 0, 0, $3)`,
      [workspaceId, actorId, `idem-${seq}`],
    );
  }

  // -- Test Scenario 8 — raw-capture expiry ----------------------------------

  it("T8 · raw-capture expiry nulls the object key and marks expired, retaining rollup and excerpt", async () => {
    const workspaceId = await createWorkspace("free"); // raw_captures_days = 30
    const projectId = await createProject(workspaceId);
    const oldCapture = await insertCapture(workspaceId, projectId, new Date("2020-01-01T00:00:00.000Z"));
    await insertMetricDaily(workspaceId, projectId, "2020-01-01");

    const count = await expireRawCaptures(workerClient, workspaceId, 30, new Date("2020-06-01T00:00:00.000Z"));
    expect(count).toBe(1);

    const row = await client.query<{ raw_object_key: string | null; payload: { raw_expired?: boolean }; response_excerpt: string }>(
      "SELECT raw_object_key, payload, response_excerpt FROM answer_captures WHERE id = $1",
      [oldCapture],
    );
    expect(row.rows[0]!.raw_object_key).toBeNull();
    expect(row.rows[0]!.payload.raw_expired).toBe(true);
    expect(row.rows[0]!.response_excerpt).toBe("excerpt text");

    const rollup = await client.query("SELECT 1 FROM metric_daily WHERE workspace_id = $1", [workspaceId]);
    expect(rollup.rowCount).toBe(1);
  });

  it("T8 widen · null retention (no active subscription) never purges raw captures — asserted directly", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const captureId = await insertCapture(workspaceId, projectId, new Date("2000-01-01T00:00:00.000Z"));

    const count = await expireRawCaptures(workerClient, workspaceId, null, new Date());
    expect(count).toBe(0);
    const row = await client.query<{ raw_object_key: string | null }>("SELECT raw_object_key FROM answer_captures WHERE id = $1", [
      captureId,
    ]);
    expect(row.rows[0]!.raw_object_key).not.toBeNull();
  });

  it("T8 widen · a capture exactly at the retention boundary instant is retained, not purged", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const referenceDate = new Date("2026-01-31T00:00:00.000Z");
    const boundaryInstant = new Date(referenceDate.getTime() - 30 * 86_400_000); // exactly the cutoff
    const captureId = await insertCapture(workspaceId, projectId, boundaryInstant);

    const count = await expireRawCaptures(workerClient, workspaceId, 30, referenceDate);
    expect(count).toBe(0);
    const row = await client.query<{ raw_object_key: string | null }>("SELECT raw_object_key FROM answer_captures WHERE id = $1", [
      captureId,
    ]);
    expect(row.rows[0]!.raw_object_key).not.toBeNull();
  });

  // -- Test Scenario 9 — tool-snapshot expiry --------------------------------

  it("T9 · tool-snapshot expiry nulls the payload, retains headline metrics", async () => {
    const workspaceId = await createWorkspace();
    const toolRunId = await insertToolRun(workspaceId, new Date("2020-01-01T00:00:00.000Z"));

    const count = await expireToolSnapshotsForWorkspace(workerClient, workspaceId, new Date("2020-06-01T00:00:00.000Z"));
    expect(count).toBe(1);

    const row = await client.query<{
      status: string;
      result_json: unknown;
      sov_estimate: number;
      citation_count: number;
      brand_present: boolean;
    }>("SELECT status, result_json, sov_estimate, citation_count, brand_present FROM tool_runs WHERE id = $1", [toolRunId]);
    expect(row.rows[0]!.status).toBe("expired");
    expect(row.rows[0]!.result_json).toBeNull();
    expect(row.rows[0]!.sov_estimate).toBeCloseTo(0.42);
    expect(row.rows[0]!.citation_count).toBe(3);
    expect(row.rows[0]!.brand_present).toBe(true);
  });

  // -- Test Scenario 10 — rollup expiry ---------------------------------------

  it("T10 · rollup expiry deletes metric_daily but retains milestones", async () => {
    const workspaceId = await createWorkspace("starter"); // rollups_days = 395
    const projectId = await createProject(workspaceId);
    await insertMetricDaily(workspaceId, projectId, "2020-01-01");
    const milestoneId = await insertMilestone(workspaceId, projectId);

    const count = await expireRollups(workerClient, workspaceId, 395, new Date("2025-01-01T00:00:00.000Z"));
    expect(count).toBe(1);

    const rollup = await client.query("SELECT 1 FROM metric_daily WHERE workspace_id = $1", [workspaceId]);
    expect(rollup.rowCount).toBe(0);
    const milestone = await client.query("SELECT 1 FROM milestones WHERE id = $1", [milestoneId]);
    expect(milestone.rowCount).toBe(1);
  });

  it("derived-analysis expiry (geo_analyses) at rollup-retention cadence, recomputable from facts", async () => {
    const workspaceId = await createWorkspace("starter");
    const projectId = await createProject(workspaceId);
    await insertGeoAnalysis(workspaceId, projectId, new Date("2020-01-01T00:00:00.000Z"));

    const result = await expireDerivedAnalyses(workerClient, workspaceId, 395, new Date("2025-01-01T00:00:00.000Z"));
    expect(result.geoAnalyses).toBe(1);
    const remaining = await client.query("SELECT 1 FROM geo_analyses WHERE workspace_id = $1", [workspaceId]);
    expect(remaining.rowCount).toBe(0);
  });

  it("attribution_daily expiry at rollup-retention cadence", async () => {
    const workspaceId = await createWorkspace("starter");
    const projectId = await createProject(workspaceId);
    await insertAttributionDaily(workspaceId, projectId, "2020-01-01");

    const count = await expireAttributionDaily(workerClient, workspaceId, 395, new Date("2025-01-01T00:00:00.000Z"));
    expect(count).toBe(1);
    const remaining = await client.query("SELECT 1 FROM attribution_daily WHERE workspace_id = $1", [workspaceId]);
    expect(remaining.rowCount).toBe(0);
  });

  it("null/unlimited rollup retention never purges rollups, derived analyses, or attribution_daily", async () => {
    const workspaceId = await createWorkspace("free"); // rollups_days = null
    const projectId = await createProject(workspaceId);
    await insertMetricDaily(workspaceId, projectId, "2000-01-01");
    await insertGeoAnalysis(workspaceId, projectId, new Date("2000-01-01T00:00:00.000Z"));
    await insertAttributionDaily(workspaceId, projectId, "2000-01-01");

    // resolveWorkspaceRetention is a cross-tenant-callable helper with no
    // context of its own (see retention.ts's PRIVILEGE CONTRACT comment) —
    // stays on the privileged `client`, unlike the expire* calls below.
    expect(await resolveRetentionCutoff((await resolveWorkspaceRetention(client, workspaceId)).rollupsDays, new Date())).toBeNull();
    expect(await expireRollups(workerClient, workspaceId, null, new Date())).toBe(0);
    expect((await expireDerivedAnalyses(workerClient, workspaceId, null, new Date())).geoAnalyses).toBe(0);
    expect(await expireAttributionDaily(workerClient, workspaceId, null, new Date())).toBe(0);
  });

  // -- Test Scenario 11 — sole-owner erasure block ---------------------------
  //
  // requestIndividualErasure genuinely requires a privileged (table-owner-
  // class) connection — it disables/re-enables audit_log/credit_ledger's
  // append-only trigger, which needs table ownership `nominara_worker` never
  // has, regardless of tenant context. Kept on `client` (privileged) below;
  // "privilege proof" further down demonstrates nominara_worker's actual
  // failure on that specific step rather than only asserting it in a comment.

  it("T11 · an erasure request from the sole owner of a workspace is blocked, with the exact reason returned", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await addOwner(workspaceId, userId);

    const result = await requestIndividualErasure(client, userId);
    expect(result).toEqual({ blocked: true, reason: SOLE_OWNER_ERASURE_BLOCK_REASON });

    const user = await client.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [userId]);
    expect(user.rows[0]!.status).not.toBe("deleted");
  });

  it("individual erasure succeeds for a non-owner: anonymises users, reassigns task_events/milestones, pseudonymises audit_log/credit_ledger", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')", [
      workspaceId,
      userId,
    ]);
    const milestoneId = await insertMilestone(workspaceId, projectId, userId);
    await insertAuditLog(workspaceId, userId);
    await insertCreditLedger(workspaceId, userId);

    const result = await requestIndividualErasure(client, userId);
    expect(result).toEqual({ blocked: false });

    const user = await client.query<{ email: string; status: string; full_name: string | null }>(
      "SELECT email, status, full_name FROM users WHERE id = $1",
      [userId],
    );
    expect(user.rows[0]!.status).toBe("deleted");
    expect(user.rows[0]!.email).toContain("deleted+");
    expect(user.rows[0]!.full_name).toBeNull();

    const milestone = await client.query<{ created_by: string }>("SELECT created_by FROM milestones WHERE id = $1", [milestoneId]);
    expect(milestone.rows[0]!.created_by).toBe(SYSTEM_ACTOR_ID);

    const audit = await client.query<{ actor_id: string }>(
      "SELECT actor_id FROM audit_log WHERE workspace_id = $1 AND action <> $2",
      [workspaceId, RECHAINED_MARKER_ACTION],
    );
    expect(audit.rows[0]!.actor_id).toBe(SYSTEM_ACTOR_ID);

    // ⚠ PSEUDONYMISED, NOT REASSIGNED TO THE SYSTEM ACTOR. This used to
    // assert `SYSTEM_ACTOR_ID`, which is erasure of the actor rather than
    // pseudonymisation of it: after two people are erased their spend is
    // indistinguishable, and indistinguishable from entries the system
    // genuinely caused. `credit_ledger` is an ACCOUNTING record kept for the
    // invoice-dispute window (data-model.md §7), and a dispute asks who
    // authorised a charge — "the system" is not an answer to that.
    const ledger = await client.query<{ actor_id: string | null; actor_pseudonym: string | null }>(
      "SELECT actor_id, actor_pseudonym FROM credit_ledger WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(ledger.rows[0]!.actor_id).toBeNull();
    expect(ledger.rows[0]!.actor_pseudonym).not.toBeNull();
    expect(ledger.rows[0]!.actor_pseudonym).not.toBe(userId);

    // The append-only trigger still protects every OTHER workspace's rows.
    const otherWorkspace = await createWorkspace();
    const otherActor = await createUser();
    await insertAuditLog(otherWorkspace, otherActor);
    await expect(client.query("UPDATE audit_log SET actor_id = $1 WHERE workspace_id = $2", [SYSTEM_ACTOR_ID, otherWorkspace])).rejects.toThrow(
      /append-only/,
    );
  });

  // -- STORY-020 D-4 — erasure appends a re-chain marker per affected workspace

  it("STORY-073 AC13 · two erased people stay distinguishable in the ledger, and neither is identifiable", async () => {
    // ⚠ THE FIRST VERSION OF THIS TEST NAMED A PROPERTY IT DID NOT CHECK —
    // it asserted only `pseudonym !== rawUserId`, which a plain hash of the
    // user id also satisfies. It did, and the second-engineer review
    // inverted that hash in one query. This one ATTEMPTS the
    // re-identification, the same way an attacker holding the database
    // would.
    const workspaceId = await createWorkspace();
    const first = await createUser();
    const second = await createUser();
    for (const member of [first, second]) {
      await client.query(
        "INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')",
        [workspaceId, member],
      );
    }
    await insertCreditLedger(workspaceId, first);
    await insertCreditLedger(workspaceId, first);
    await insertCreditLedger(workspaceId, second);

    expect(await requestIndividualErasure(client, first)).toEqual({ blocked: false });
    expect(await requestIndividualErasure(client, second)).toEqual({ blocked: false });

    const rows = await client.query<{ actor_pseudonym: string | null; actor_id: string | null }>(
      "SELECT actor_id, actor_pseudonym FROM credit_ledger WHERE workspace_id = $1",
      [workspaceId],
    );
    const pseudonyms = rows.rows.map((row) => row.actor_pseudonym!);

    // Nobody is named...
    expect(rows.rows.every((row) => row.actor_id === null)).toBe(true);
    expect(pseudonyms).not.toContain(first);
    expect(pseudonyms).not.toContain(second);

    // ...and the two people are still two people: 2 rows and 1 row.
    expect(new Set(pseudonyms).size).toBe(2);
    const counts = [...new Set(pseudonyms)].map((p) => pseudonyms.filter((q) => q === p).length).sort();
    expect(counts).toEqual([1, 2]);
  });

  it("⚠ STORY-073 AC13 · the pseudonym cannot be inverted by anyone holding the database", async () => {
    // ⚠ THE ATTACK THE REVIEW RAN. `requestIndividualErasure` ANONYMISES the
    // `users` row rather than deleting it, because every FK in the product
    // points at that id — so a pseudonym DERIVED from the id has a candidate
    // space of `SELECT id FROM users`, sitting in the same database. A hash
    // was inverted in one query. A stored random value cannot be.
    const workspaceId = await createWorkspace();
    const userId = await createUser();
    await client.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')",
      [workspaceId, userId],
    );
    await insertCreditLedger(workspaceId, userId);

    // ⚠ THE JOIN TARGET HAS TO EXIST FOR ATTACK 3 TO MEAN ANYTHING. Without
    // this row the assertion below counts zero either way and passes against
    // a version that leaves the id in place — which it did, until a mutant
    // showed it.
    const projectId = await createProject(workspaceId);
    await client.query(
      `INSERT INTO capture_runs
         (workspace_id, project_id, trigger, engine_keys, prompt_scope, planned_cells, skipped_cells,
          captured_cells, failed_cells, scoring_version, status, triggered_by)
       VALUES ($1, $2, 'manual', ARRAY['chatgpt'], 'all', 1, 0, 1, 0, 'v1', 'completed', $3)`,
      [workspaceId, projectId, userId],
    );

    await requestIndividualErasure(client, userId);

    const row = await client.query<{ actor_pseudonym: string }>(
      "SELECT actor_pseudonym FROM credit_ledger WHERE workspace_id = $1",
      [workspaceId],
    );
    const pseudonym = row.rows[0]!.actor_pseudonym;

    // ATTACK 1 — hash every id that survived erasure and look for a match.
    // This is what killed the digest version.
    const survivors = await client.query<{ id: string }>("SELECT id FROM users");
    for (const prefix of ["credit-ledger-actor-pseudonym:", "audit-log-workspace-pseudonym:", ""]) {
      const matched = survivors.rows.some((candidate) => {
        const digest = createHash("sha256").update(prefix).update(candidate.id).digest("hex");
        const shaped = [
          digest.slice(0, 8),
          digest.slice(8, 12),
          digest.slice(12, 16),
          digest.slice(16, 20),
          digest.slice(20, 32),
        ].join("-");
        return shaped === pseudonym;
      });
      expect(matched, `the pseudonym is a sha256 of a surviving id under prefix "${prefix}"`).toBe(false);
    }

    // ATTACK 2 — the pseudonym is not the id, nor anything trivially derived.
    expect(pseudonym).not.toBe(userId);
    expect(survivors.rows.map((candidate) => candidate.id)).not.toContain(pseudonym);

    // ATTACK 3 — follow the ledger's own references back to a person.
    // STORY-073B began recording `reference_id` (the capture run) on every
    // debit, and `capture_runs.triggered_by` held the raw user id, so a
    // scrubbed row re-identified its person one hop away. This story opened
    // that path, so this story closes it.
    const leaks = await client.query<{ triggered_by: string | null }>(
      "SELECT triggered_by FROM capture_runs WHERE triggered_by = $1",
      [userId],
    );
    expect(leaks.rowCount, "capture_runs still names the erased user").toBe(0);
  });

  it("⚠ STORY-073 AC13 · the pseudonym satisfies the contract the route publishes for it", async () => {
    // ⚠ 87% OF THE DIGEST VERSION DID NOT. `actor_pseudonym` is published as
    // `z.string().uuid()`, and a sha256 slice has arbitrary version and
    // variant nibbles — so most erased actors would have been written, into
    // an APPEND-ONLY table, as a value the route's own contract rejects and
    // `@nominara/client` would refuse to parse. It cannot be corrected
    // afterwards without disabling the append-only trigger.
    //
    // The contract test in `credit-ledger-read.spec.ts` passed vacuously: it
    // never seeded a pseudonymised row, which is the only state this column
    // exists for.
    const workspaceId = await createWorkspace();
    const userId = await createUser();
    await client.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')",
      [workspaceId, userId],
    );
    await insertCreditLedger(workspaceId, userId);
    await requestIndividualErasure(client, userId);

    const row = await client.query<{ actor_pseudonym: string }>(
      "SELECT actor_pseudonym FROM credit_ledger WHERE workspace_id = $1",
      [workspaceId],
    );
    expect(z.string().uuid().safeParse(row.rows[0]!.actor_pseudonym).success).toBe(true);
  });

  it("STORY-073 AC13 · a row cannot name a person and carry a pseudonym at once", async () => {
    // The constraint is what makes "pseudonymised" a state the database can
    // express rather than a convention the erasure function happens to follow.
    const workspaceId = await createWorkspace();
    const actorId = await createUser();
    await insertCreditLedger(workspaceId, actorId);

    await client.query("ALTER TABLE credit_ledger DISABLE TRIGGER reject_update_delete");
    try {
      await expect(
        client.query("UPDATE credit_ledger SET actor_pseudonym = $1 WHERE workspace_id = $2", [
          randomUUID(),
          workspaceId,
        ]),
      ).rejects.toThrow(/ck_credit_ledger_actor_exclusive/u);
    } finally {
      await client.query("ALTER TABLE credit_ledger ENABLE TRIGGER reject_update_delete");
    }
  });

  it("STORY-020 · individual erasure appends one audit.chain.rechained marker row to each workspace whose audit_log rows had this actor", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')", [
      workspaceId,
      userId,
    ]);
    await insertAuditLog(workspaceId, userId);

    const result = await requestIndividualErasure(client, userId);
    expect(result).toEqual({ blocked: false });

    const marker = await client.query<{ actor_type: string }>(
      "SELECT actor_type FROM audit_log WHERE workspace_id = $1 AND action = $2",
      [workspaceId, RECHAINED_MARKER_ACTION],
    );
    expect(marker.rowCount).toBe(1);
    expect(marker.rows[0]!.actor_type).toBe("system");
  });

  it("STORY-020 · individual erasure appends no re-chain marker anywhere when the erased user has no audit_log rows", async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace();
    await client.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1, $2, 'analyst', 'active')", [
      workspaceId,
      userId,
    ]);

    const before = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_log WHERE action = $1",
      [RECHAINED_MARKER_ACTION],
    );
    await requestIndividualErasure(client, userId);
    const after = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM audit_log WHERE action = $1",
      [RECHAINED_MARKER_ACTION],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it("privilege proof (qa-reviewer blocking #4) · nominara_worker CANNOT disable audit_log's append-only trigger — the exact reason executeWorkspaceHardDelete/requestIndividualErasure need a privileged connection, not a claim taken on faith", async () => {
    await expect(workerClient.query("ALTER TABLE audit_log DISABLE TRIGGER reject_update_delete")).rejects.toThrow(/owner/i);
  });

  // -- Test Scenario 12 — orphan scan pages -----------------------------------
  //
  // scanForOrphans/runOrphanScan issue a cross-tenant SELECT with NO tenant
  // context set — kept on the privileged `client` below (see retention.ts's
  // PRIVILEGE CONTRACT comment); the proof test right after demonstrates
  // WHY, rather than only asserting it.

  it("T12 · a fact row without its parent is detected by the orphan scan, which pages (throws) on non-zero", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await insertMentionFactOrphan(workspaceId, projectId, new Date());

    const reports = await scanForOrphans(client);
    expect(reports.some((r) => r.table === "mention_facts" && r.orphanCount > 0)).toBe(true);

    await expect(runOrphanScan(client)).rejects.toThrow(/orphan fact row/);
  });

  it("privilege proof (qa-reviewer blocking #4) · nominara_worker reads ZERO rows directly where the privileged connection's scanForOrphans sees the real orphan, and scanForOrphans itself is REFUSED (42501) for the worker", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await insertMentionFactOrphan(workspaceId, projectId, new Date());

    const privileged = await scanForOrphans(client);
    expect(privileged.some((r) => r.table === "mention_facts" && r.orphanCount > 0)).toBe(true);

    // FORCE ROW LEVEL SECURITY + no app.current_workspace_id set: every
    // row in every fact table is filtered out for nominara_worker, so the
    // exact same orphan is invisible — this is NOT nominara_worker "working
    // correctly and finding nothing", it is RLS making cross-tenant
    // discovery impossible without a privileged connection.
    const directUnderWorker = await workerClient.query<{ n: string }>("SELECT count(*)::text AS n FROM mention_facts");
    expect(directUnderWorker.rows[0]!.n).toBe("0");
    // STORY-013 r2 (ADR-0004): the scan now goes through a count-only definer function whose EXECUTE belongs to the maintenance
    // identity alone. A tenant runtime role is REFUSED (42501) rather than handed a count.
    await expect(scanForOrphans(workerClient)).rejects.toMatchObject({ code: "42501" });
  });

  // -- Test Scenario 13 — export lock blocks purge ---------------------------
  //
  // withExportLock/tryPurgeProject are plain pg_advisory_lock wrappers — no
  // RLS-governed table read happens on the path these two tests exercise
  // (the callbacks below throw/no-op rather than touch data), so both run on
  // real `nominara_worker` connections, per this story's PRIVILEGE CONTRACT.

  it("T13 · an active export's advisory lock causes the purge job to skip that project", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);

    let releaseExport: () => void = () => undefined;
    const exportHeld = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    const exportPromise = withExportLock(workerClient, projectId, async () => exportHeld);

    // Give the lock a moment to actually be acquired before the purge attempt races it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const purgeClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_worker",
      resolvePassword("nominara_worker", {}),
    );
    try {
      const outcome = await tryPurgeProject(purgeClient, projectId, async () => {
        throw new Error("should never run while the export lock is held");
      });
      expect(outcome).toEqual({ scope: "project", scopeId: projectId, reason: "export-lock-held" });
    } finally {
      releaseExport();
      await exportPromise;
      await purgeClient.end();
    }
  });

  it("R4 · a project the purge skipped for an open export is purged on the NEXT cycle, once the export lock releases", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const referenceDate = new Date("2026-06-01T00:00:00.000Z");
    await client.query("UPDATE projects SET deleted_at = $2 WHERE id = $1", [projectId, new Date(referenceDate.getTime() - 31 * 86_400_000).toISOString()]);
    const purged: string[] = [];
    const options = { referenceDate, deleteObjectPrefix: async (prefix: string) => void purged.push(prefix) };

    let releaseExport: () => void = () => undefined;
    const exportHeld = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    const exportPromise = withExportLock(workerClient, projectId, async () => exportHeld);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const first = await runDailyPurgeCycle(client, options);
    expect(first.skipped).toContainEqual({ scope: "project", scopeId: projectId, reason: "export-lock-held" });
    expect(first.projectsPurged).not.toContain(projectId);
    expect((await client.query("SELECT 1 FROM projects WHERE id = $1", [projectId])).rowCount, "still there: the export held it").toBe(1);

    releaseExport();
    await exportPromise;

    const second = await runDailyPurgeCycle(client, options);
    expect(second.projectsPurged).toContain(projectId);
    expect(second.skipped.map((s) => s.scopeId)).not.toContain(projectId);
    expect((await client.query("SELECT 1 FROM projects WHERE id = $1", [projectId])).rowCount).toBe(0);
  });

  it("widen · two simultaneous exports on the same project — the second waits, it does not race or error", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    const order: string[] = [];

    let releaseFirst: () => void = () => undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = withExportLock(workerClient, projectId, async () => {
      order.push("first-start");
      await firstHeld;
      order.push("first-end");
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const secondClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_worker",
      resolvePassword("nominara_worker", {}),
    );
    const second = withExportLock(secondClient, projectId, async () => {
      order.push("second-start");
    });

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(order).toEqual(["first-start"]); // second has not started — it is waiting on the lock

    releaseFirst();
    await first;
    await second;
    await secondClient.end();
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  // -- Project soft delete / hard delete -------------------------------------

  it("project soft delete: deleted_at set, active prompts paused, queued runs cancelled, data retained", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await client.query(
      `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, status)
       VALUES ($1, $2, 'prompt', decode('00', 'hex'), 'recommendation', 'awareness', 'active')`,
      [workspaceId, projectId],
    );
    await client.query(
      `INSERT INTO capture_runs (workspace_id, project_id, trigger, engine_keys, status)
       VALUES ($1, $2, 'manual', ARRAY['chatgpt'], 'queued')`,
      [workspaceId, projectId],
    );

    await softDeleteProject(workerClient, workspaceId, projectId);

    const project = await client.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM projects WHERE id = $1", [projectId]);
    expect(project.rows[0]!.deleted_at).not.toBeNull();
    const prompt = await client.query<{ status: string }>("SELECT status FROM tracked_prompts WHERE project_id = $1", [projectId]);
    expect(prompt.rows[0]!.status).toBe("paused");
    const run = await client.query<{ status: string }>("SELECT status FROM capture_runs WHERE project_id = $1", [projectId]);
    expect(run.rows[0]!.status).toBe("canceled");
  });

  it("project hard delete: no-FK fact rows deleted directly, everything else cascades via ON DELETE CASCADE, S3-prefix delete invoked", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await insertCapture(workspaceId, projectId, new Date());
    await insertMilestone(workspaceId, projectId);

    const deletedPrefixes: string[] = [];
    await hardDeleteProject(workerClient, workspaceId, projectId, {
      env: "test",
      deleteObjectPrefix: async (prefix) => {
        deletedPrefixes.push(prefix);
      },
    });

    expect(deletedPrefixes).toEqual([`test/${workspaceId}/projects/${projectId}/`]);
    const project = await client.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);
    expect(project.rowCount).toBe(0);
    const captures = await client.query("SELECT 1 FROM answer_captures WHERE project_id = $1", [projectId]);
    expect(captures.rowCount).toBe(0);
    const milestones = await client.query("SELECT 1 FROM milestones WHERE project_id = $1", [projectId]);
    expect(milestones.rowCount).toBe(0); // cascaded via ON DELETE CASCADE, not deleted by this function directly
  });

  it("hardDeleteProject throws when no deleteObjectPrefix callback is supplied — discloses the missing object-storage client rather than silently skipping it", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await expect(hardDeleteProject(workerClient, workspaceId, projectId)).rejects.toThrow(/deleteObjectPrefix/);
  });

  // -- Workspace deletion request / execution --------------------------------

  it("workspace deletion request: pending_deletion status, 30-day grace, share tokens revoked", async () => {
    const workspaceId = await createWorkspace();
    const userId = await createUser();
    await client.query(
      `INSERT INTO share_tokens (workspace_id, label, token_hash, token_prefix, scope_project_ids, created_by)
       VALUES ($1, 'Label', decode('00', 'hex'), 'abcdefgh', ARRAY[gen_random_uuid()], $2)`,
      [workspaceId, userId],
    );

    const referenceDate = new Date("2026-01-01T00:00:00.000Z");
    await requestWorkspaceDeletion(workerClient, workspaceId, referenceDate);

    const workspace = await client.query<{ status: string; deletion_execute_at: Date }>(
      "SELECT status, deletion_execute_at FROM workspaces WHERE id = $1",
      [workspaceId],
    );
    expect(workspace.rows[0]!.status).toBe("pending_deletion");
    expect(workspace.rows[0]!.deletion_execute_at.toISOString()).toBe("2026-01-31T00:00:00.000Z");

    const token = await client.query<{ revoked_at: Date | null }>("SELECT revoked_at FROM share_tokens WHERE workspace_id = $1", [
      workspaceId,
    ]);
    expect(token.rows[0]!.revoked_at).not.toBeNull();
  });

  // executeWorkspaceHardDelete genuinely requires a privileged (table-owner-
  // class) connection (ALTER TABLE ... DISABLE/ENABLE TRIGGER) — stays on
  // `client` below; see the privilege-proof test near T11 for why
  // `nominara_worker` cannot do this.
  it("workspace hard delete: exports audit_log + credit_ledger BEFORE the cascade, order enforced in code", async () => {
    const workspaceId = await createWorkspace();
    const userId = await createUser();
    await insertAuditLog(workspaceId, userId);
    await insertCreditLedger(workspaceId, userId);

    const events: string[] = [];
    await executeWorkspaceHardDelete(client, workspaceId, {
      exportComplianceRecords: async (records) => {
        events.push("exported");
        expect(records.find((r) => r.table === "audit_log")!.rows).toHaveLength(1);
        expect(records.find((r) => r.table === "credit_ledger")!.rows).toHaveLength(1);
      },
    });
    events.push("cascaded");

    expect(events).toEqual(["exported", "cascaded"]);
    const workspace = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
    expect(workspace.rowCount).toBe(0);

    // The append-only trigger is re-enabled afterward for every other workspace.
    const otherWorkspace = await createWorkspace();
    const otherUser = await createUser();
    await insertAuditLog(otherWorkspace, otherUser);
    await expect(client.query("DELETE FROM audit_log WHERE workspace_id = $1", [otherWorkspace])).rejects.toThrow(/append-only/);
  });

  // -- STORY-020 D-6 — audit_log has no FK cascade from workspaces, so hard
  // delete must explicitly delete it, and the exported copy's workspace_id
  // must be pseudonymised (AC "rows are retained only in the immutable
  // export, with the workspace identifier pseudonymised").

  it("STORY-020 · workspace hard delete: audit_log rows do not survive live, and the exported copy has workspace_id pseudonymised", async () => {
    const workspaceId = await createWorkspace();
    const userId = await createUser();
    await insertAuditLog(workspaceId, userId);

    let exportedAuditRows: readonly Record<string, unknown>[] = [];
    await executeWorkspaceHardDelete(client, workspaceId, {
      exportComplianceRecords: async (records) => {
        exportedAuditRows = records.find((r) => r.table === "audit_log")!.rows;
      },
    });

    expect(exportedAuditRows).toHaveLength(1);
    expect(exportedAuditRows[0]!.workspace_id).toBe(pseudonymiseWorkspaceId(workspaceId));
    expect(exportedAuditRows[0]!.workspace_id).not.toBe(workspaceId);

    const live = await client.query("SELECT 1 FROM audit_log WHERE workspace_id = $1", [workspaceId]);
    expect(live.rowCount).toBe(0);
  });

  // STORY-170 review finding [minor] — migration 0029's `sessions
  // .active_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL`
  // is load-bearing for this exact function: with a plain `REFERENCES
  // workspaces(id)` (no action), hard-deleting ANY workspace a session had
  // ever switched into would raise a foreign-key violation on
  // `DELETE FROM workspaces` and fail the whole retention purge — nothing in
  // this file exercised that until now.
  it("STORY-170 · executeWorkspaceHardDelete on a workspace a live session switched into: the delete succeeds, active_workspace_id is cleared (ON DELETE SET NULL), and the next SessionService.refresh mints ws:null", async () => {
    const originalEnv = { ...process.env };
    // SessionService.mintAccessAndCsrf calls loadEnv() for the Ed25519
    // signing key and CSRF secret only — this file's own `client`/`pool`
    // stay pointed at the real container regardless of what this sets.
    applyFakeApiEnv();

    const pool = new Pool({ connectionString: container.getConnectionUri() });
    try {
      const sessionService = new SessionService(pool, new MembershipService(new MembershipCacheService()), new InMemoryCacheAdapter());

      const workspaceId = await createWorkspace();
      const userId = await createUser();
      await addOwner(workspaceId, userId);

      const session = await sessionService.createSession(userId);
      await client.query("UPDATE sessions SET active_workspace_id = $2 WHERE id = $1", [session.sid, workspaceId]);

      const before = await client.query<{ active_workspace_id: string | null }>(
        "SELECT active_workspace_id FROM sessions WHERE id = $1",
        [session.sid],
      );
      expect(before.rows[0]!.active_workspace_id).toBe(workspaceId);

      await executeWorkspaceHardDelete(client, workspaceId, {
        exportComplianceRecords: async () => {},
      });

      const workspaceRow = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [workspaceId]);
      expect(workspaceRow.rowCount).toBe(0);

      const after = await client.query<{ active_workspace_id: string | null }>(
        "SELECT active_workspace_id FROM sessions WHERE id = $1",
        [session.sid],
      );
      expect(after.rows[0]!.active_workspace_id).toBeNull();

      const refreshed = await sessionService.refresh(session.refreshToken);
      const publicKey = importEd25519PublicKeyFromDer(HARNESS_PUBLIC_KEY_DER);
      const claims = await verifyAccessToken(refreshed.accessToken, () => publicKey);
      expect(claims.ws).toBeNull();
    } finally {
      await pool.end();
      process.env = originalEnv;
    }
  });

  // collectComplianceExport, like the cross-tenant discovery functions
  // above, issues its SELECT with no tenant context set — stays on the
  // privileged `client` (see retention.ts's PRIVILEGE CONTRACT comment).
  it("collectComplianceExport reads exactly the workspace's own audit_log + credit_ledger rows", async () => {
    const workspaceId = await createWorkspace();
    const userId = await createUser();
    await insertAuditLog(workspaceId, userId);
    const records = await collectComplianceExport(client, workspaceId);
    expect(records.map((r) => r.table).sort()).toEqual(["audit_log", "credit_ledger"]);
  });

  it("widen · workspace-level deletion execution racing a still-open project-level export honors the lock", async () => {
    const workspaceId = await createWorkspace();
    const projectId = await createProject(workspaceId);
    await client.query(
      "UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1",
      [workspaceId],
    );

    // Advisory locks are per-SESSION and reentrant — checking from the SAME
    // connection that holds the lock would always see it as "available".
    // The export holder and the workspace-deletion checker must be genuinely
    // separate sessions, exactly as they would be in production.
    // withExportLock itself is a plain advisory-lock wrapper — real
    // nominara_worker connection. workspaceProjectsWithOpenExports, like
    // scanForOrphans, reads `projects` with no tenant context set and stays
    // on the privileged `client`.
    const exportClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_worker",
      resolvePassword("nominara_worker", {}),
    );

    let releaseExport: () => void = () => undefined;
    const exportHeld = new Promise<void>((resolve) => {
      releaseExport = resolve;
    });
    const exportPromise = withExportLock(exportClient, projectId, async () => exportHeld);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const openExports = await workspaceProjectsWithOpenExports(client, workspaceId);
    expect(openExports).toEqual([projectId]);

    releaseExport();
    await exportPromise;
    await exportClient.end();

    const openExportsAfter = await workspaceProjectsWithOpenExports(client, workspaceId);
    expect(openExportsAfter).toEqual([]);
  });

  // -- Test Scenario 3 (finding #3, code review) — per-project error isolation

  it("runDailyPurgeCycle end-to-end: one project's purge failure does not abort the remaining due projects or the workspace-purge loop after it", async () => {
    const referenceDate = new Date("2026-06-01T00:00:00.000Z");
    const oldDeletedAt = new Date(referenceDate.getTime() - 31 * 86_400_000);

    // This file shares ONE container/database across every test, and
    // runDailyPurgeCycle's own workspace scan is deliberately cross-tenant
    // (no workspaceId filter — it discovers every due workspace platform-
    // wide, by design). An earlier test in this same file ("workspace
    // deletion request") leaves a workspace at status='pending_deletion'
    // with deletion_execute_at in the past (2026-01-31) relative to this
    // test's referenceDate — pushing every already-pending-deletion
    // workspace's deletion_execute_at safely past this test's referenceDate
    // first means the workspace this test purges below is the ONLY one due,
    // without weakening the production query itself.
    await client.query(
      "UPDATE workspaces SET deletion_execute_at = $1 WHERE status = 'pending_deletion' AND deletion_execute_at <= $2",
      [new Date(referenceDate.getTime() + 365 * 86_400_000).toISOString(), referenceDate.toISOString()],
    );

    const failingProjectId = await createProject(await createWorkspace());
    const okProjectId1 = await createProject(await createWorkspace());
    const okProjectId2 = await createProject(await createWorkspace());
    for (const projectId of [failingProjectId, okProjectId1, okProjectId2]) {
      await client.query("UPDATE projects SET deleted_at = $2 WHERE id = $1", [projectId, oldDeletedAt.toISOString()]);
    }

    const dueWorkspaceId = await createWorkspace();
    await client.query(
      "UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = $2 WHERE id = $1",
      [dueWorkspaceId, new Date(referenceDate.getTime() - 86_400_000).toISOString()],
    );
    const dueWorkspaceUserId = await createUser();
    await insertAuditLog(dueWorkspaceId, dueWorkspaceUserId);

    const result = await runDailyPurgeCycle(client, {
      referenceDate,
      deleteObjectPrefix: async (prefix) => {
        if (prefix.includes(failingProjectId)) {
          throw new Error("simulated object-storage failure");
        }
      },
      exportComplianceRecords: async () => undefined,
    });

    // The failing project is neither purged nor reported as export-locked —
    // its own hardDeleteProject rejected. The two other due projects, and
    // the due workspace AFTER them in the run, still completed.
    expect([...result.projectsPurged].sort()).toEqual([okProjectId1, okProjectId2].sort());
    expect(result.workspacesPurged).toEqual([dueWorkspaceId]);

    const failure = await client.query<{ scope: string; scope_id: string }>(
      "SELECT scope, scope_id FROM purge_failures WHERE scope_id = $1",
      [failingProjectId],
    );
    expect(failure.rowCount).toBe(1);
    expect(failure.rows[0]!.scope).toBe("project");

    const workspace = await client.query("SELECT 1 FROM workspaces WHERE id = $1", [dueWorkspaceId]);
    expect(workspace.rowCount).toBe(0);
  });
});
