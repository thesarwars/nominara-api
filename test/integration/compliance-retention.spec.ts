import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subjectExportSchema } from "../../contracts/compliance/index.js";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { TENANT_TABLES } from "../../src/db/rls/tenant-tables.generated.js";
import { appendComplianceAudit } from "../../src/lib/compliance/compliance-audit.js";
import { activeHolds, LegalHoldError, placeLegalHold, releaseExpiredHolds, releaseLegalHold } from "../../src/lib/compliance/legal-hold.js";
import { InMemoryJournalStore, PurgeJournal } from "../../src/lib/compliance/purge-journal.js";
import { reapplyPurgesAfterRestore } from "../../src/lib/compliance/restore-replay.js";
import { COMPLIANCE_EXPORT_CLASSES, writeComplianceExports } from "../../src/lib/compliance/storage-adapters.js";
import { SUBJECT_INVENTORY } from "../../src/lib/compliance/subject-inventory.js";
import { ERASURE_QUEUE_LOCK, executePendingErasures, processAccessRequest, processErasureRequest, releaseLegalHoldAndRunQueue, subjectColumnsFor } from "../../src/lib/compliance/subject-request.js";
import type { ObjectStoragePort, PutObjectRequest } from "../../src/lib/storage/storage.port.js";
import { runSubjectCommand } from "../../src/db/subject-cli.js";
import { executeWorkspaceHardDelete, runDailyPurgeCycle, runNightlySweep } from "../../src/workers/rollup/retention.js";

// STORY-111 - subject requests, legal hold, purge journal, restore across a purge, no archive. One container, migrations applied once, the
// owner (superuser) connection throughout: these are the owner-connection jobs retention.ts's PRIVILEGE CONTRACT describes.
describe("STORY-111 · compliance mechanics against a real database", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let seq = 0;
  const DAY = 86_400_000;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db, MIGRATIONS_DIR);
  }, 180_000);

  afterAll(async () => {
    await db.end();
    await container.stop();
  });

  async function workspace(): Promise<string> {
    seq += 1;
    return (await db.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1,$2,'free') RETURNING id", [`WS ${seq}`, `ws-${seq}-${randomUUID().slice(0, 8)}`])).rows[0]!.id;
  }
  async function user(): Promise<string> {
    seq += 1;
    return (await db.query<{ id: string }>("INSERT INTO users (email) VALUES ($1) RETURNING id", [`u${seq}-${randomUUID().slice(0, 8)}@example.com`])).rows[0]!.id;
  }
  async function member(ws: string, u: string, role: "owner" | "viewer" = "viewer"): Promise<void> {
    await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,$3,'active')", [ws, u, role]);
  }
  async function project(ws: string, createdBy: string | null = null, name = "Project"): Promise<string> {
    seq += 1;
    return (
      await db.query<{ id: string }>(
        "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain, created_by) VALUES ($1,$2,$3,'https://example.com','example.com',$4) RETURNING id",
        [ws, name, `p-${seq}-${randomUUID().slice(0, 8)}`, createdBy],
      )
    ).rows[0]!.id;
  }
  async function capture(ws: string, proj: string, excerpt: string): Promise<void> {
    await db.query(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash, raw_object_key, response_excerpt, payload)
       VALUES ($1,$2,gen_random_uuid(),gen_random_uuid(),'chatgpt',now(),'api','v1','v1',decode('00','hex'),$4,$3,jsonb_build_object('text',$3::text))`,
      [ws, proj, excerpt, `raw/${randomUUID()}.json`],
    );
  }
  async function dueProject(ws: string, daysAgo = 40): Promise<string> {
    const p = await project(ws);
    await db.query("UPDATE projects SET deleted_at = now() - ($2 || ' days')::interval WHERE id = $1", [p, String(daysAgo)]);
    return p;
  }
  /** One row in `table`, every NOT NULL column without a default filled by type; `overrides` win. */
  async function seedRow(table: string, overrides: Record<string, unknown>): Promise<void> {
    const cols = (
      await db.query<{ column_name: string; data_type: string; udt_name: string }>(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER' ORDER BY ordinal_position`,
        [table],
      )
    ).rows;
    const names: string[] = [];
    const values: unknown[] = [];
    const filler = (c: { data_type: string; udt_name: string }): unknown =>
      c.udt_name === "uuid"
        ? randomUUID()
        : c.data_type === "boolean"
          ? false
          : ["integer", "smallint", "bigint", "real", "numeric"].includes(c.data_type)
            ? 0
            : c.data_type.startsWith("timestamp") || c.data_type === "date"
              ? new Date()
              : c.udt_name === "bytea"
                ? Buffer.from("00", "hex")
                : c.data_type === "ARRAY"
                  ? []
                  : c.data_type === "jsonb"
                    ? "{}"
                    : `seed-${randomUUID().slice(0, 8)}`;
    for (const c of cols) {
      names.push(c.column_name);
      values.push(c.column_name in overrides ? overrides[c.column_name] : filler(c));
    }
    for (const [k, v] of Object.entries(overrides)) {
      if (!names.includes(k)) {
        names.push(k);
        values.push(v);
      }
    }
    await db.query(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(",")})`, values);
  }
  const exists = async (table: string, id: string): Promise<boolean> => (await db.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id])).rowCount === 1;
  const auditActions = async (ws: string): Promise<string[]> => (await db.query<{ action: string }>("SELECT action FROM audit_log WHERE workspace_id = $1 ORDER BY seq", [ws])).rows.map((r) => r.action);
  const noop = async (): Promise<void> => undefined;

  // ------------------------------------------------------------------ legal hold
  describe("legal hold (scenarios 23, 24)", () => {
    it("S23 a held project is skipped and REPORTED, two people and an audit entry are on record, and an unheld project still purges", async () => {
      const ws = await workspace();
      const [a, b] = [await user(), await user()];
      const held = await dueProject(ws);
      const free = await dueProject(ws);
      const hold = await placeLegalHold(db, { scope: "project", scopeId: held, reason: "Litigation hold, matter 42", requestedBy: a, approvedBy: b, expiresAt: new Date(Date.now() + 30 * DAY) });

      const result = await runDailyPurgeCycle(db, { deleteObjectPrefix: noop });
      expect(result.held).toContainEqual({ scope: "project", scopeId: held, reason: "legal-hold" });
      expect(result.projectsPurged).toContain(free);
      expect(result.projectsPurged).not.toContain(held);
      expect(await exists("projects", held)).toBe(true);

      const row = (await db.query("SELECT requested_by, approved_by, reason, expires_at FROM legal_holds WHERE id = $1", [hold.id])).rows[0]!;
      expect([row.requested_by, row.approved_by].sort()).toEqual([a, b].sort());
      expect(await auditActions(ws)).toContain("legal_hold.placed");
      const run = (await db.query("SELECT skipped_legal_hold FROM purge_runs ORDER BY started_at DESC LIMIT 1")).rows[0]!;
      expect(run.skipped_legal_hold).toBeGreaterThanOrEqual(1);
    });

    it("S23 a hold needs two DIFFERENT people, a real reason and a future expiry (library and database both refuse)", async () => {
      const ws = await workspace();
      const p = await project(ws);
      const [a, b] = [await user(), await user()];
      const base = { scope: "project" as const, scopeId: p, reason: "Litigation hold, matter 43", requestedBy: a, approvedBy: b, expiresAt: new Date(Date.now() + DAY) };
      await expect(placeLegalHold(db, { ...base, approvedBy: a })).rejects.toMatchObject({ code: "same_person" });
      await expect(placeLegalHold(db, { ...base, reason: "short" })).rejects.toMatchObject({ code: "reason_too_short" });
      await expect(placeLegalHold(db, { ...base, expiresAt: new Date(Date.now() - 1000) })).rejects.toMatchObject({ code: "expiry_not_in_future" });
      await expect(placeLegalHold(db, { ...base, scopeId: randomUUID() })).rejects.toBeInstanceOf(LegalHoldError);
      // The database refuses too: a raw insert that skips the library.
      await expect(db.query("INSERT INTO legal_holds (scope, scope_id, workspace_id, reason, requested_by, approved_by, expires_at) VALUES ('project',$1,$2,'a long enough reason',$3,$3, now() + interval '1 day')", [p, ws, a])).rejects.toThrow(/ck_legal_holds_two_person/);
      await expect(db.query("INSERT INTO legal_holds (scope, scope_id, workspace_id, reason, requested_by, approved_by, expires_at) VALUES ('project',$1,$2,'a long enough reason',$3,$4, NULL)", [p, ws, a, b])).rejects.toThrow();
      expect((await activeHolds(db, new Date())).projects.has(p)).toBe(false); // none of the refused attempts left a hold behind
    });

    it("S24 a lapsed hold releases by itself: the subject purges on its normal schedule and the release is recorded and audited", async () => {
      const ws = await workspace();
      const [a, b] = [await user(), await user()];
      const proj = await dueProject(ws);
      const t0 = new Date(Date.now() - 2 * DAY);
      await placeLegalHold(db, { scope: "project", scopeId: proj, reason: "Short hold for the test", requestedBy: a, approvedBy: b, expiresAt: new Date(t0.getTime() + DAY), now: t0 });

      const result = await runDailyPurgeCycle(db, { deleteObjectPrefix: noop });
      expect(result.held.map((h) => h.scopeId)).not.toContain(proj);
      expect(result.projectsPurged).toContain(proj);
      // The register row goes with the purged project (exactly three record sets survive); the audit row is the record.
      expect((await db.query("SELECT 1 FROM legal_holds WHERE scope_id = $1", [proj])).rowCount).toBe(0);
      expect(await auditActions(ws)).toContain("legal_hold.expired");
      expect(await releaseExpiredHolds(db)).toBe(0); // idempotent
    });

    it("S23 a manual release is audited and ends the exemption; a second release refuses", async () => {
      const ws = await workspace();
      const [a, b] = [await user(), await user()];
      const proj = await dueProject(ws);
      const hold = await placeLegalHold(db, { scope: "project", scopeId: proj, reason: "Hold to be released", requestedBy: a, approvedBy: b, expiresAt: new Date(Date.now() + 5 * DAY) });
      await releaseLegalHold(db, hold.id, b);
      expect(await auditActions(ws)).toContain("legal_hold.released");
      await expect(releaseLegalHold(db, hold.id, b)).rejects.toMatchObject({ code: "not_active" });
      expect((await runDailyPurgeCycle(db, { deleteObjectPrefix: noop })).projectsPurged).toContain(proj);
    });

    it("S23 a held project blocks its WORKSPACE's hard delete, and the nightly sweep skips and reports the workspace", async () => {
      const ws = await workspace();
      const [a, b] = [await user(), await user()];
      const proj = await project(ws);
      await db.query("UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1", [ws]);
      await placeLegalHold(db, { scope: "project", scopeId: proj, reason: "Hold on one project", requestedBy: a, approvedBy: b, expiresAt: new Date(Date.now() + DAY) });
      const result = await runDailyPurgeCycle(db, { exportComplianceRecords: noop, deleteObjectPrefix: noop });
      expect(result.held).toContainEqual({ scope: "workspace", scopeId: ws, reason: "legal-hold" });
      expect(await exists("workspaces", ws)).toBe(true);
      await db.query("UPDATE workspaces SET status = 'active' WHERE id = $1", [ws]);
      expect((await runNightlySweep(db)).held).toContainEqual({ scope: "workspace", scopeId: ws, reason: "legal-hold" });
    });
  });

  // ------------------------------------------------------------------ journal, idempotence, no archive
  describe("purge journal, idempotence and no content archive (scenarios 16, 17, 18, 19, 20, 21)", () => {
    it("S20 each purge appends an entry to the journal outside the database: identifiers, a timestamp, a reason, no content", async () => {
      const ws = await workspace();
      const proj = await dueProject(ws);
      await capture(ws, proj, "SECRETCONTENT-J1 customer words");
      const store = new InMemoryJournalStore();
      await runDailyPurgeCycle(db, { deleteObjectPrefix: noop, journal: new PurgeJournal(store, "test") });
      const mine = [...store.objects.values()].map((v) => JSON.parse(v) as Record<string, unknown>).filter((e) => e.scope_id === proj);
      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({ scope: "project", workspace_id: ws, reason: "project_hard_deleted" });
      expect(JSON.stringify([...store.objects.values()])).not.toMatch(/SECRETCONTENT|customer words/);
    });

    it("S16 a second purge run is idempotent: nothing more is purged, no second journal entry, and BOTH runs are recorded", async () => {
      const ws = await workspace();
      const proj = await dueProject(ws);
      const store = new InMemoryJournalStore();
      const journal = new PurgeJournal(store, "idem");
      const before = (await db.query("SELECT count(*)::int AS n FROM purge_runs")).rows[0]!.n as number;
      const first = await runDailyPurgeCycle(db, { deleteObjectPrefix: noop, journal });
      const second = await runDailyPurgeCycle(db, { deleteObjectPrefix: noop, journal });
      expect(first.projectsPurged).toContain(proj);
      expect(second.projectsPurged).toEqual([]);
      expect([...store.objects.values()].filter((v) => (JSON.parse(v) as { scope_id: string }).scope_id === proj)).toHaveLength(1);
      const runs = (await db.query("SELECT projects_purged, status FROM purge_runs ORDER BY started_at, id OFFSET $1", [before])).rows;
      expect(runs).toHaveLength(2);
      expect(runs[1]).toMatchObject({ projects_purged: 0, status: "ok" });
    });

    it("S20 a journal that cannot be written is a recorded purge failure, not a silent success", async () => {
      const ws = await workspace();
      const proj = await dueProject(ws);
      const broken = new PurgeJournal({ putNew: () => Promise.reject(new Error("bucket down")), list: () => Promise.resolve([]), get: () => Promise.reject(new Error("x")) }, "t");
      const result = await runDailyPurgeCycle(db, { deleteObjectPrefix: noop, journal: broken });
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect((await db.query("SELECT 1 FROM purge_failures WHERE scope_id = $1 AND resolved_at IS NULL", [proj])).rowCount).toBe(1);
    });

    it("S17 after a workspace hard delete, no TABLE still holds its content and the reports objects are gone (raw/crawl objects are STORY-182); only identifiers in the three record sets remain", async () => {
      const ws = await workspace();
      const u = await user();
      await member(ws, u, "owner");
      const proj = await project(ws, u, "SENTINEL-PROJECTNAME-17");
      await capture(ws, proj, "SENTINEL-ANSWER-17 about acme");
      // Every table the cascade does not reach by foreign key holds a row for this workspace.
      await seedRow("mention_facts", { workspace_id: ws, project_id: proj, entity_type: "brand", sentiment_label: "neutral", sentiment_method: "lexicon", entity_label: "SENTINEL-LABEL-17", matched_alias: "SENTINEL-ALIAS-17" });
      await seedRow("citation_facts", { workspace_id: ws, project_id: proj, raw_url: "https://SENTINEL-17.example/x" });
      await seedRow("source_domains", { workspace_id: ws, domain: "SENTINEL-17.example" });
      await seedRow("notifications", { workspace_id: ws, severity: "info", title: "SENTINEL-NOTE-17" });
      await seedRow("report_artifacts", { workspace_id: ws, object_key: "SENTINEL-OBJECT-17.pdf" });
      await db.query("UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1", [ws]);

      const bucket = new Map<string, string>([[`test/${ws}/raw/a.json`, "SENTINEL-ANSWER-17"], [`test/${ws}/reports/r.pdf`, "SENTINEL-PROJECTNAME-17"]]);
      const store = new InMemoryJournalStore();
      const exports: string[] = [];
      const result = await runDailyPurgeCycle(db, {
        journal: new PurgeJournal(store, "n"),
        exporterFor: () => async (records) => void exports.push(...records.map((r) => r.table)),
        // PRODUCTION-FAITHFUL: retention-purge.handler.ts wires deleteWorkspaceReports ONLY (the reports bucket). The raw and crawl prefixes are
        // STORY-182's, so the stub removes the reports prefix and nothing else.
        deleteWorkspaceObjects: (w) => {
          for (const k of [...bucket.keys()]) if (k.includes(`/${w}/reports/`)) bucket.delete(k);
          return Promise.resolve();
        },
      });
      expect(result.workspacesPurged).toContain(ws);
      expect(exports.sort()).toEqual(["audit_log", "credit_ledger", "credit_purchases", "invoices", "subscription_addons", "subscriptions"]);

      // EVERY base table, searched as text for the sentinels and for the workspace id.
      const tables = (await db.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition")).rows.map((r) => r.t);
      const offenders: string[] = [];
      for (const t of tables) {
        const hit = await db.query(`SELECT count(*)::int AS n FROM "${t}" x WHERE x::text LIKE '%SENTINEL-%' OR x::text LIKE $1`, [`%${ws}%`]);
        if ((hit.rows[0]!.n as number) > 0) offenders.push(t);
      }
      // audit_chain_marks keeps a TOMBSTONE: the workspace id and a reason, no content (STORY-143). That is the only database row that names it.
      expect(offenders).toEqual(["audit_chain_marks"]);
      expect((await db.query("SELECT reason FROM audit_chain_marks WHERE workspace_id = $1", [ws])).rows.map((r) => r.reason)).toEqual(["tombstone"]);
      // The reports object is gone. The RAW object is NOT (STORY-182 owns the raw and crawl prefixes): stated, not hidden - the AC "no purge path
      // leaves content behind" is Partial for objects until that story wires the prefix deletes.
      expect([...bucket.keys()]).toEqual([`test/${ws}/raw/a.json`]);
      expect([...store.objects.values()].join("")).not.toMatch(/SENTINEL/);
    });

    it("S18 the export runs BEFORE the cascade and sees the rows; an export that fails leaves the workspace and its records intact", async () => {
      const ws = await workspace();
      await db.query("UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1", [ws]);
      await appendOneAudit(ws);
      let seen = 0;
      await executeWorkspaceHardDelete(db, ws, { exportComplianceRecords: (records) => { seen = records.find((r) => r.table === "audit_log")!.rows.length; return Promise.resolve(); } });
      expect(seen).toBeGreaterThan(0);

      const ws2 = await workspace();
      await appendOneAudit(ws2);
      await expect(executeWorkspaceHardDelete(db, ws2, { exportComplianceRecords: () => Promise.reject(new Error("bucket down")) })).rejects.toThrow("bucket down");
      expect(await exists("workspaces", ws2)).toBe(true);
      expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1", [ws2])).rows[0]!.n).toBeGreaterThan(0);
    });

    async function appendOneAudit(ws: string): Promise<void> {
      await appendComplianceAudit(db, { workspaceId: ws, actorType: "system", actorId: null, action: "test.seed", resourceType: "workspace", resourceId: ws, afterState: {} });
    }

    it("S19 both surviving exports carry an expiry and a retention class, and the financial export pseudonymises actor and workspace ids", async () => {
      const puts: PutObjectRequest[] = [];
      const port = { put: (r: PutObjectRequest) => { puts.push(r); return Promise.resolve(); } } as unknown as ObjectStoragePort;
      const ws = randomUUID();
      const actor = randomUUID();
      const now = new Date("2026-11-06T00:00:00Z");
      await writeComplianceExports(port, "prod", ws, () => now)([
        { table: "audit_log", rows: [{ seq: 1, workspace_id: "pseudonymised-upstream" }] },
        { table: "credit_ledger", rows: [{ id: 1, workspace_id: ws, actor_id: actor }, { id: 2, workspace_id: ws, actor_id: actor }, { id: 3, workspace_id: ws, actor_id: null }] },
      ]);
      expect(puts).toHaveLength(2);
      for (const p of puts) {
        expect(p.metadata?.expires_at).toBe("2033-11-06T00:00:00.000Z");
        expect(p.key).not.toContain(ws);
      }
      expect(puts[0]!.key.startsWith(COMPLIANCE_EXPORT_CLASSES.audit_log)).toBe(true);
      expect(puts[1]!.key.startsWith(COMPLIANCE_EXPORT_CLASSES.credit_ledger)).toBe(true);
      const ledger = (JSON.parse(String(puts[1]!.body)) as { rows: { workspace_id: string; actor_id: string | null }[] }).rows;
      expect(JSON.stringify(ledger)).not.toContain(actor);
      expect(JSON.stringify(ledger)).not.toContain(ws);
      expect(ledger[0]!.actor_id).toBe(ledger[1]!.actor_id); // groups within the export
      expect(ledger[2]!.actor_id).toBeNull();
    });

    it("S21 purge a workspace, restore a snapshot that predates the purge: replaying the journal makes the workspace unreadable again, and a re-run is a no-op", async () => {
      const ws = await workspace();
      const proj = await project(ws);
      await capture(ws, proj, "RESTORE-ME");
      await db.query("UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1", [ws]);
      const snapshotAt = new Date(Date.now() - 1000);
      const store = new InMemoryJournalStore();
      const journal = new PurgeJournal(store, "restore");
      await runDailyPurgeCycle(db, { journal, exportComplianceRecords: noop, deleteWorkspaceObjects: noop });
      expect(await exists("workspaces", ws)).toBe(false);

      // THE RESTORE: the snapshot predates the purge, so the workspace, its project and its capture come back. The database holds no memory of the purge.
      await db.query("INSERT INTO workspaces (id, name, slug, plan_key) VALUES ($1,'Restored',$2,'free')", [ws, `restored-${randomUUID().slice(0, 8)}`]);
      await db.query("INSERT INTO projects (id, workspace_id, name, slug, root_url, root_domain) VALUES ($1,$2,'P',$3,'https://example.com','example.com')", [proj, ws, `rp-${randomUUID().slice(0, 8)}`]);
      await capture(ws, proj, "RESTORE-ME");
      expect(await exists("workspaces", ws)).toBe(true);

      const replay = await reapplyPurgesAfterRestore(db, journal, snapshotAt);
      expect(replay.failed).toEqual([]);
      expect(replay.replayed).toBeGreaterThanOrEqual(1);
      expect(await exists("workspaces", ws)).toBe(false);
      expect((await db.query("SELECT 1 FROM answer_captures WHERE workspace_id = $1", [ws])).rowCount).toBe(0);
      expect((await reapplyPurgesAfterRestore(db, journal, snapshotAt)).failed).toEqual([]);
    });

    it("S21 a purge recorded BEFORE the snapshot is not replayed", async () => {
      const ws = await workspace();
      const store = new InMemoryJournalStore();
      await new PurgeJournal(store, "old", () => new Date(Date.now() - 10 * DAY)).append({ scope: "workspace", scopeId: ws, workspaceId: ws, reason: "workspace_deletion_executed" });
      const replay = await reapplyPurgesAfterRestore(db, new PurgeJournal(store, "old"), new Date(Date.now() - DAY));
      expect(replay.replayed).toBe(0);
      expect(await exists("workspaces", ws)).toBe(true);
    });
  });

  // ------------------------------------------------------------------ subject requests
  describe("subject requests (scenarios 1-7)", () => {
    it("S2 (live) every table registered as exempt has NO foreign key to users, so an exemption cannot go stale; every tenant table has a verdict", async () => {
      for (const table of TENANT_TABLES) {
        const entry = SUBJECT_INVENTORY[table];
        expect(entry, `${table} has no inventory entry`).toBeDefined();
      }
      const fk = await db.query<{ t: string; c: string }>(
        `SELECT t.relname AS t, a.attname AS c FROM pg_constraint k JOIN pg_class t ON t.oid = k.conrelid JOIN pg_class f ON f.oid = k.confrelid
           JOIN LATERAL unnest(k.conkey) AS u(n) ON true JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n
          WHERE k.contype = 'f' AND f.relname = 'users'`,
      );
      const stale = fk.rows.filter((r) => SUBJECT_INVENTORY[r.t]?.disposition === "exempt").map((r) => `${r.t}.${r.c}`);
      expect(stale, "exempt tables that reference users").toEqual([]);
      expect(await subjectColumnsFor(db, "audit_log")).toEqual(["actor_id"]);
      expect(await subjectColumnsFor(db, "workspace_members")).toContain("user_id");
    });

    it("S1 S6 S7 an access request returns a machine-readable export, is traced received -> processed -> completed with the actor, and every metric carries its six facts", async () => {
      const ws = await workspace();
      const u = await user();
      await member(ws, u, "owner");
      const proj = await project(ws, u);
      await db.query(
        `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, cells_total, live_capture_ratio, visibility_score, scoring_version)
         VALUES ($1,$2,'all','brand',gen_random_uuid(), CURRENT_DATE, 12, 0.5, 41.250, (SELECT scoring_version FROM workspaces WHERE id = $1)),
                ($1,$2,'gemini','brand',gen_random_uuid(), CURRENT_DATE, 12, 0.5, 41.250, (SELECT scoring_version FROM workspaces WHERE id = $1))`,
        [ws, proj],
      );
      const requestId = randomUUID();
      const out = await processAccessRequest(db, u, { requestedBy: u, requestId });

      expect(() => subjectExportSchema.parse(JSON.parse(JSON.stringify(out)))).not.toThrow();
      expect(out.tables.map((t) => t.table)).toContain("workspace_members");
      const metric = out.metrics.find((m) => m.project_id === proj)!;
      expect(metric.value).toBe(41.25);
      expect(Object.keys(metric.metadata).sort()).toEqual(["data_through", "engines", "live_capture_ratio", "sample_size", "scoring_version", "timeframe"]);
      expect(metric.metadata).toMatchObject({ engines: ["gemini"], sample_size: 12, live_capture_ratio: 0.5, timeframe: "30d" });
      expect(metric.metadata.data_through).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      const trail = (await db.query("SELECT action, actor_id, actor_type, resource_id FROM audit_log WHERE workspace_id = $1 AND resource_type = 'subject_request' ORDER BY seq", [ws])).rows;
      expect(trail.map((r) => r.action)).toEqual(["subject_request.received", "subject_request.processed", "subject_request.completed"]);
      expect(trail.every((r) => r.actor_id === u && r.resource_id === requestId)).toBe(true);
    });

    it("S1 a subject with no data still gets a valid, empty export; a project with no score exports value null, not 0", async () => {
      const lonely = await user();
      const empty = await processAccessRequest(db, lonely, { requestedBy: null });
      expect(subjectExportSchema.parse(empty).tables.map((t) => t.table)).toEqual([]);
      const ws = await workspace();
      const u = await user();
      await member(ws, u);
      const proj = await project(ws, u);
      const out = await processAccessRequest(db, u, { requestedBy: u });
      const metric = out.metrics.find((m) => m.project_id === proj)!;
      expect(metric.value).toBeNull();
      expect(metric.metadata).toMatchObject({ sample_size: 0, live_capture_ratio: null, data_through: null, engines: [] });
    });

    it("S1 secret-bearing columns are named as omitted and never exported", async () => {
      const ws = await workspace();
      const u = await user();
      await member(ws, u, "owner");
      const cols = (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name = 'api_keys' AND is_nullable = 'NO' AND column_default IS NULL")).rows.map((r) => r.column_name);
      expect(cols.length).toBeGreaterThan(0);
      const out = await processAccessRequest(db, u, { requestedBy: u });
      for (const t of out.tables) for (const row of t.rows) for (const omitted of t.omitted_columns) expect(row).not.toHaveProperty(omitted);
    });

    it("S5 erasure by the SOLE OWNER of a workspace is blocked, the requester is told why and what to do, nothing is changed, and the trail says blocked", async () => {
      const ws = await workspace();
      const u = await user();
      await member(ws, u, "owner");
      const out = await processErasureRequest(db, u, { requestedBy: u });
      expect(out.status).toBe("blocked");
      expect(out.reason).toContain("sole owner");
      expect(out.reason).toContain("Transfer ownership");
      expect((await db.query("SELECT email FROM users WHERE id = $1", [u])).rows[0]!.email).not.toContain("deleted+");
      expect((await auditActions(ws)).filter((a) => a.startsWith("subject_request."))).toEqual(["subject_request.received", "subject_request.blocked"]);
    });

    it("S3 S4 S6 erasure of a non-owner anonymises the user, RETAINS the audit and ledger rows with the actor pseudonymised, and the trail is complete", async () => {
      const ws = await workspace();
      const owner = await user();
      const u = await user();
      await member(ws, owner, "owner");
      await member(ws, u);
      await db.query(
        "INSERT INTO credit_ledger (workspace_id, actor_id, entry_type, bucket, credits, included_after, purchased_after, reserved_after, idempotency_key) VALUES ($1,$2,'grant','included',5,5,0,0,$3)",
        [ws, u, `k-${randomUUID()}`],
      );
      const requestId = randomUUID();
      const out = await processErasureRequest(db, u, { requestedBy: u, requestId });
      expect(out).toMatchObject({ status: "completed", reason: null });
      expect((await db.query("SELECT email FROM users WHERE id = $1", [u])).rows[0]!.email).toMatch(/^deleted\+.*@nominara\.invalid$/);
      expect((await db.query("SELECT 1 FROM audit_log WHERE workspace_id = $1 AND actor_id = $2", [ws, u])).rowCount).toBe(0);
      expect((await db.query("SELECT count(*)::int AS n FROM audit_log WHERE workspace_id = $1 AND resource_id = $2", [ws, requestId])).rows[0]!.n).toBe(3);
      expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1", [ws])).rowCount).toBe(1);
      expect((await db.query("SELECT 1 FROM credit_ledger WHERE workspace_id = $1 AND actor_id = $2", [ws, u])).rowCount).toBe(0);
      expect((await auditActions(ws)).filter((a) => a.startsWith("subject_request."))).toEqual(["subject_request.received", "subject_request.processed", "subject_request.completed"]);
    });
  });

  // ------------------------------------------------------------------ review round 1
  describe("review round 1", () => {
    const hold = (scope: "project" | "workspace", scopeId: string, a: string, b: string) =>
      placeLegalHold(db, { scope, scopeId, reason: "Litigation hold, matter 77", requestedBy: a, approvedBy: b, expiresAt: new Date(Date.now() + 30 * DAY) });

    it("S23 RACE a hold placed AFTER the cycle read the holds still protects a due PROJECT: the data and the hold both survive", async () => {
      const ws = await workspace();
      const [a, b] = [await user(), await user()];
      const p = await dueProject(ws);
      await capture(ws, p, "HOLD-RACE-PROJECT");
      let holdId = "";
      const result = await runDailyPurgeCycle(db, {
        deleteObjectPrefix: noop,
        afterHoldsRead: async () => void (holdId = (await hold("project", p, a, b)).id),
      });
      expect(result.projectsPurged).not.toContain(p);
      expect(result.held).toContainEqual({ scope: "project", scopeId: p, reason: "legal-hold" });
      expect(await exists("projects", p)).toBe(true);
      expect((await db.query("SELECT 1 FROM answer_captures WHERE project_id = $1", [p])).rowCount).toBe(1);
      expect((await db.query("SELECT 1 FROM legal_holds WHERE id = $1 AND released_at IS NULL", [holdId])).rowCount).toBe(1);
    });

    it("S23 RACE a hold placed AFTER the cycle read the holds still protects a due WORKSPACE: the workspace, its data and the hold survive, and nothing is exported", async () => {
      const ws = await workspace();
      const [a, b] = [await user(), await user()];
      const p = await project(ws);
      await capture(ws, p, "HOLD-RACE-WORKSPACE");
      await db.query("UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1", [ws]);
      let holdId = "";
      const objects: string[] = [];
      const exported: string[] = [];
      const journal = new InMemoryJournalStore();
      const result = await runDailyPurgeCycle(db, {
        journal: new PurgeJournal(journal, "race"),
        exportComplianceRecords: (r) => { exported.push(...r.map((x) => x.table)); return Promise.resolve(); },
        deleteWorkspaceObjects: (w) => { objects.push(w); return Promise.resolve(); },
        afterHoldsRead: async () => void (holdId = (await hold("workspace", ws, a, b)).id),
      });
      expect(result.workspacesPurged).not.toContain(ws);
      expect(result.held).toContainEqual({ scope: "workspace", scopeId: ws, reason: "legal-hold" });
      expect(await exists("workspaces", ws)).toBe(true);
      expect((await db.query("SELECT 1 FROM answer_captures WHERE workspace_id = $1", [ws])).rowCount).toBe(1);
      expect((await db.query("SELECT 1 FROM legal_holds WHERE id = $1", [holdId])).rowCount).toBe(1);
      expect(objects).toEqual([]);
      expect(journal.objects.size).toBe(0);
    });

    it("S23 a RELEASED hold row is cleaned up with its workspace, an ACTIVE one is never deleted by the cleanup", async () => {
      const ws = await workspace();
      const [a, b] = [await user(), await user()];
      const h = await hold("workspace", ws, a, b);
      await releaseLegalHold(db, h.id, a);
      await db.query("UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1", [ws]);
      await runDailyPurgeCycle(db, { exportComplianceRecords: noop, deleteWorkspaceObjects: noop });
      expect(await exists("workspaces", ws)).toBe(false);
      expect((await db.query("SELECT 1 FROM legal_holds WHERE id = $1", [h.id])).rowCount).toBe(0);
    });

    it("S1 an access export never carries credential material: a subject who created a GSC connection and a GA4 attribution config gets neither *_enc value", async () => {
      const ws = await workspace();
      const u = await user();
      await member(ws, u, "owner");
      const proj = await project(ws, u);
      await seedRow("gsc_connections", { workspace_id: ws, project_id: proj, created_by: u, property_type: "domain", credentials_enc: "ENC-SECRET-GSC-CRED", refresh_enc: "ENC-SECRET-GSC-REFRESH", dek_id: "dek-1" });
      await seedRow("attribution_configs", { workspace_id: ws, project_id: proj, created_by: u, method: "ga4", ga4_credentials_enc: "ENC-SECRET-GA4", site_token: "SITE-TOKEN-X" });
      const out = await processAccessRequest(db, u, { requestedBy: u });
      const text = JSON.stringify(out);
      expect(text).not.toMatch(/ENC-SECRET/);
      expect(text).not.toContain("SITE-TOKEN-X");
      const gsc = out.tables.find((t) => t.table === "gsc_connections")!;
      expect(gsc.rows).toHaveLength(1);
      expect(gsc.omitted_columns).toEqual(expect.arrayContaining(["credentials_enc", "refresh_enc"]));
    });

    it("S1 DEFAULT-DENY every column of every exported table is classified (exportable or omitted): a new column fails here until a person decides", async () => {
      const unclassified: string[] = [];
      for (const [table, entry] of Object.entries(SUBJECT_INVENTORY)) {
        if (entry.disposition !== "export") continue;
        const live = (await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table])).rows.map((r) => r.column_name);
        const declared = new Set([...entry.columns, ...entry.omit]);
        for (const c of live) if (!declared.has(c)) unclassified.push(`${table}.${c}`);
        for (const c of declared) if (!live.includes(c)) unclassified.push(`${table}.${c} (declared, not in the database)`);
        for (const c of entry.columns) if (entry.omit.includes(c)) unclassified.push(`${table}.${c} (both exportable and omitted)`);
      }
      expect(unclassified).toEqual([]);
    });

    it("S1 an access export holds NO other person's data: a subject who invited V gets neither V's email nor V's id", async () => {
      const ws = await workspace();
      const u = await user();
      const v = await user();
      const vEmail = `victim-${randomUUID().slice(0, 8)}@third-party.example`;
      await db.query("UPDATE users SET email = $2, full_name = 'Vera Victim' WHERE id = $1", [v, vEmail]);
      await member(ws, u, "owner");
      await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status, invited_by) VALUES ($1,$2,'viewer','active',$3)", [ws, v, u]);
      await db.query("INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,'viewer',decode('01','hex'),$3, now() + interval '1 day')", [ws, `invitee-${randomUUID().slice(0, 8)}@third-party.example`, u]);
      const proj = await project(ws, u);
      await seedRow("tasks", { workspace_id: ws, project_id: proj, kind: "content", completed_by: u, assignee_id: v });
      const out = await processAccessRequest(db, u, { requestedBy: u });
      const text = JSON.stringify(out);
      expect(text).not.toContain(vEmail);
      expect(text).not.toContain(v);
      expect(text).not.toContain("Vera Victim");
      expect(text).not.toContain("invitee-");
      // The task the subject completed is exported, with the OTHER person's id nulled.
      const tasks = out.tables.find((t) => t.table === "tasks")!;
      expect(tasks.rows).toHaveLength(1);
      expect(tasks.rows[0]!.assignee_id).toBeNull();
      expect(tasks.rows[0]!.completed_by).toBe(u);
      // The subject's OWN membership is still there.
      expect(out.tables.find((t) => t.table === "workspace_members")!.rows.map((r) => r.user_id)).toEqual([u]);
    });

    it("S7 a REMOVED member's export holds no metric for the workspace they left", async () => {
      const ws = await workspace();
      const owner = await user();
      const u = await user();
      await member(ws, owner, "owner");
      await db.query("INSERT INTO workspace_members (workspace_id, user_id, role, status) VALUES ($1,$2,'viewer','removed')", [ws, u]);
      const proj = await project(ws, u);
      await db.query(
        `INSERT INTO metric_daily (workspace_id, project_id, engine_key, entity_type, entity_id, metric_date, cells_total, live_capture_ratio, visibility_score, scoring_version)
         VALUES ($1,$2,'all','brand',gen_random_uuid(), CURRENT_DATE, 12, 0.5, 77.000, (SELECT scoring_version FROM workspaces WHERE id = $1))`,
        [ws, proj],
      );
      const out = await processAccessRequest(db, u, { requestedBy: u });
      // Structure, not a substring: the document carries random UUIDs and a millisecond timestamp, any of which can contain "77".
      expect(out.metrics.filter((m) => m.workspace_id === ws)).toEqual([]);
      expect(out.metrics.filter((m) => m.value === 77)).toEqual([]);
    });

    it("S3 S4 erasure is COMPLETE: the subject's email survives in no base table except the pseudonymised audit and ledger sets", async () => {
      const ws = await workspace();
      const owner = await user();
      const u = await user();
      const email = `erase-me-${randomUUID().slice(0, 8)}@sweep.example`;
      await db.query("UPDATE users SET email = $2, full_name = 'Erin Erasable' WHERE id = $1", [u, email]);
      await member(ws, owner, "owner");
      await member(ws, u);
      await db.query("INSERT INTO workspace_invitations (workspace_id, email, role, token_hash, invited_by, expires_at) VALUES ($1,$2,'viewer',decode('02','hex'),$3, now() + interval '1 day')", [ws, email, owner]);
      await seedRow("scheduled_reports", { workspace_id: ws, created_by: owner, cadence: "weekly", recipients: [email, "other@sweep.example"], project_ids: [] });
      await seedRow("downgrade_notices", { workspace_id: ws, kind: "paused", recipient: email, subject: "Your plan", text_body: `Hi Erin Erasable, a note for ${email}` });
      const out = await processErasureRequest(db, u, { requestedBy: u });
      expect(out.status).toBe("completed");
      const tables = (await db.query<{ t: string }>("SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition")).rows.map((r) => r.t);
      const offenders: string[] = [];
      for (const t of tables) {
        if (t === "audit_log" || t === "credit_ledger") continue;
        const hit = await db.query(`SELECT count(*)::int AS n FROM "${t}" x WHERE x::text ILIKE $1 OR x::text LIKE '%Erin Erasable%'`, [`%${email}%`]);
        if ((hit.rows[0]!.n as number) > 0) offenders.push(t);
      }
      expect(offenders).toEqual([]);
      // Another recipient of the report is untouched.
      expect((await db.query("SELECT recipients::text AS r FROM scheduled_reports WHERE workspace_id = $1", [ws])).rows[0]!.r).toContain("other@sweep.example");
    });

    it("S17 PROJECT scope: a hard-deleted project leaves no notification (no foreign key reaches it) and no content behind", async () => {
      const ws = await workspace();
      const p = await dueProject(ws);
      const keep = await project(ws);
      await seedRow("notifications", { workspace_id: ws, project_id: p, severity: "info", title: "PROJECT-SENTINEL-17" });
      await seedRow("notifications", { workspace_id: ws, project_id: keep, severity: "info", title: "KEEP-17" });
      const result = await runDailyPurgeCycle(db, { deleteObjectPrefix: noop });
      expect(result.projectsPurged).toContain(p);
      expect((await db.query("SELECT 1 FROM notifications WHERE title = 'PROJECT-SENTINEL-17'")).rowCount).toBe(0);
      expect((await db.query("SELECT 1 FROM notifications WHERE title = 'KEEP-17'")).rowCount).toBe(1);
    });

    it("S18 S19 the FINANCIAL export carries invoices, subscriptions and credit purchases before the cascade, with every person id pseudonymised", async () => {
      const ws = await workspace();
      const u = await user();
      await db.query("UPDATE workspaces SET status = 'pending_deletion', deletion_execute_at = now() - interval '1 day' WHERE id = $1", [ws]);
      await db.query(
        `INSERT INTO invoices (workspace_id, stripe_invoice_id, number, status, subtotal, total, period_start, period_end) VALUES ($1,$2,'INV-7','paid',10.00,10.00,now(),now())`,
        [ws, `in_${randomUUID()}`],
      );
      await db.query(`INSERT INTO credit_purchases (workspace_id, pack_key, credits, amount_usd, purchased_by) VALUES ($1,(SELECT key FROM credit_packs LIMIT 1),100,5.00,$2)`, [ws, u]);
      const seen: Record<string, number> = {};
      await executeWorkspaceHardDelete(db, ws, { exportComplianceRecords: (records) => { for (const r of records) seen[r.table] = r.rows.length; return Promise.resolve(); } });
      expect(seen.invoices).toBe(1);
      expect(seen.credit_purchases).toBe(1);
      expect(Object.keys(seen)).toEqual(expect.arrayContaining(["subscriptions", "subscription_addons"]));
      // And the writer pseudonymises the person id of a purchase.
      const puts: PutObjectRequest[] = [];
      const port = { put: (r: PutObjectRequest) => { puts.push(r); return Promise.resolve(); } } as unknown as ObjectStoragePort;
      await writeComplianceExports(port, "prod", ws)([{ table: "credit_purchases", rows: [{ id: 1, workspace_id: ws, purchased_by: u }] }, { table: "invoices", rows: [{ id: 2, workspace_id: ws, total: "10.00" }] }]);
      expect(puts.map((p) => p.key.startsWith(COMPLIANCE_EXPORT_CLASSES.invoices))).toEqual([true, true]);
      const text = puts.map((p) => String(p.body)).join("");
      expect(text).not.toContain(u);
      expect(text).not.toContain(ws);
    });

    it("S6 post-erasure audit rows are written by the SYSTEM actor (no actor id), and a subject with no workspace is still traced by request id in the log", async () => {
      const ws = await workspace();
      const owner = await user();
      const u = await user();
      await member(ws, owner, "owner");
      await member(ws, u);
      const requestId = randomUUID();
      await processErasureRequest(db, u, { requestedBy: u, requestId });
      const rows = (await db.query("SELECT action, actor_type, actor_id FROM audit_log WHERE workspace_id = $1 AND resource_id = $2 ORDER BY seq", [ws, requestId])).rows;
      expect(rows.map((r) => [r.action, r.actor_type])).toEqual([["subject_request.received", "user"], ["subject_request.processed", "system"], ["subject_request.completed", "system"]]);
      expect(rows[1]!.actor_id).toBeNull();
    });
  });

  // ------------------------------------------------------------------ decision 68: a legal hold DEFERS individual erasure; operator CLI
  describe("decision 68 (b) a legal hold defers individual erasure; (a) the operator CLI", () => {
    const hold = (scope: "project" | "workspace", scopeId: string, a: string, b: string, days = 30) =>
      placeLegalHold(db, { scope, scopeId, reason: "Litigation hold, matter 88", requestedBy: a, approvedBy: b, expiresAt: new Date(Date.now() + days * DAY) });
    const email = async (u: string): Promise<string> => (await db.query<{ email: string }>("SELECT email FROM users WHERE id = $1", [u])).rows[0]!.email;
    const queue = async (u: string) => (await db.query<{ status: string; request_id: string }>("SELECT status, request_id FROM subject_erasure_queue WHERE user_id = $1", [u])).rows;
    const queueById = async (requestId: string) =>
      (await db.query<{ status: string; user_id: string | null; requested_by: string | null }>("SELECT status, user_id, requested_by FROM subject_erasure_queue WHERE request_id = $1", [requestId])).rows;
    const deferredCount = async (ws: string) => (await auditActions(ws)).filter((x) => x === "subject_request.deferred").length;
    async function held() {
      const ws = await workspace();
      const [a, b, owner, u] = [await user(), await user(), await user(), await user()];
      await member(ws, owner, "owner");
      await member(ws, u);
      return { ws, a, b, owner, u };
    }

    it("S23 D1 erasure inside a held workspace is QUEUED, not run: nothing is erased, the reason is stated, the trail says deferred, a repeat request does not queue twice", async () => {
      const { ws, a, b, u } = await held();
      await hold("workspace", ws, a, b);
      const before = await email(u);
      const out = await processErasureRequest(db, u, { requestedBy: u });
      expect(out.status).toBe("deferred");
      expect(out.reason).toContain("legal hold");
      expect(out.heldWorkspaces).toEqual([ws]);
      expect(await email(u)).toBe(before);
      expect(await queue(u)).toEqual([{ status: "pending", request_id: out.requestId }]);
      expect((await auditActions(ws)).filter((x) => x.startsWith("subject_request."))).toEqual(["subject_request.received", "subject_request.deferred"]);
      const again = await processErasureRequest(db, u, { requestedBy: u });
      expect(again).toMatchObject({ status: "deferred", requestId: out.requestId });
      expect(await queue(u)).toHaveLength(1);
    });

    it("S23 D2 releasing the hold runs the queued erasure under the SAME request id, once, and the trail is complete", async () => {
      const { ws, a, b, u } = await held();
      const h = await hold("workspace", ws, a, b);
      const out = await processErasureRequest(db, u, { requestedBy: u });
      const run = await releaseLegalHoldAndRunQueue(db, h.id, b);
      expect(run).toMatchObject({ executed: 1 });
      expect(await email(u)).toMatch(/^deleted\+.*@nominara\.invalid$/);
      // An executed row no longer names the subject (or the person who raised it - here the subject themself): the surviving audit rows carry
      // this request id, and a row that re-linked it to the erased user's id would defeat the pseudonymisation.
      expect(await queueById(out.requestId)).toEqual([{ status: "executed", user_id: null, requested_by: null }]);
      expect(await queue(u)).toEqual([]);
      expect((await auditActions(ws)).filter((x) => x.startsWith("subject_request."))).toEqual(["subject_request.received", "subject_request.deferred", "subject_request.processed", "subject_request.completed"]);
      expect(await executePendingErasures(db)).toMatchObject({ executed: 0 }); // idempotent
    });

    it("S23 D3 a still-active hold leaves the queue alone; a LAPSED hold lets the nightly run execute it", async () => {
      const { ws, a, b, u } = await held();
      await placeLegalHold(db, { scope: "workspace", scopeId: ws, reason: "Short hold for the queue", requestedBy: a, approvedBy: b, expiresAt: new Date(Date.now() + DAY) });
      await processErasureRequest(db, u, { requestedBy: u });
      const first = await executePendingErasures(db); // the queue is shared with the other cases' pending rows, whose holds are also active
      expect(first.executed).toBe(0);
      expect(first.stillHeld).toBeGreaterThanOrEqual(1);
      expect((await queue(u))[0]!.status).toBe("pending");
      // A pass over a still-held row is not a new deferral: the trail and the counter record the deferral once, when the request was queued.
      expect(await deferredCount(ws)).toBe(1);
      await executePendingErasures(db);
      expect(await deferredCount(ws)).toBe(1);
      const later = new Date(Date.now() + 2 * DAY);
      await releaseExpiredHolds(db, later);
      expect(await executePendingErasures(db, later)).toMatchObject({ executed: 1 });
      expect(await email(u)).toContain("deleted+");
    });

    it("S23 D4 a hold on a PROJECT of the workspace defers too; a hold elsewhere does not", async () => {
      const { ws, a, b, u } = await held();
      const p = await project(ws);
      await hold("project", p, a, b);
      expect((await processErasureRequest(db, u, { requestedBy: u })).status).toBe("deferred");
      const other = await held();
      const unrelated = await workspace();
      await hold("workspace", unrelated, other.a, other.b);
      expect((await processErasureRequest(db, other.u, { requestedBy: other.u })).status).toBe("completed");
    });

    it("S23 D5 a queued erasure whose subject has meanwhile become a sole owner is marked blocked on release, not erased", async () => {
      const { ws, a, b, owner, u } = await held();
      const h = await hold("workspace", ws, a, b);
      await processErasureRequest(db, u, { requestedBy: u });
      await db.query("UPDATE workspace_members SET status = 'removed' WHERE workspace_id = $1 AND user_id = $2", [ws, owner]);
      await db.query("UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2", [ws, u]);
      const before = await email(u);
      expect(await releaseLegalHoldAndRunQueue(db, h.id, b)).toMatchObject({ executed: 0, blocked: 1 });
      expect(await email(u)).toBe(before);
      expect((await queue(u))[0]!.status).toBe("blocked");
    });

    it("S23 D6 RACE a hold placed AFTER the hold read but before the erasure still blocks it: the subject, the membership and the audit actor are untouched, the request is queued", async () => {
      const { ws, a, b, u } = await held();
      const before = await email(u);
      let holdId = "";
      const out = await processErasureRequest(db, u, { requestedBy: u, afterHoldsRead: async () => void (holdId = (await hold("workspace", ws, a, b)).id) });
      expect(out.status).toBe("deferred");
      expect(out.heldWorkspaces).toEqual([ws]);
      expect(await email(u)).toBe(before);
      expect((await db.query("SELECT status FROM workspace_members WHERE workspace_id = $1 AND user_id = $2", [ws, u])).rows[0]!.status).toBe("active");
      expect((await db.query("SELECT 1 FROM audit_log WHERE workspace_id = $1 AND actor_id = $2", [ws, u])).rowCount).toBeGreaterThan(0);
      expect(await queueById(out.requestId)).toEqual([{ status: "pending", user_id: u, requested_by: u }]);
      expect(await deferredCount(ws)).toBe(1);
      expect((await db.query("SELECT 1 FROM legal_holds WHERE id = $1 AND released_at IS NULL", [holdId])).rowCount).toBe(1);
    });

    it("S23 D7 a hold on a workspace the subject LEFT (removed membership) still defers the whole erasure - pinned conservative reading, owner to confirm", async () => {
      const { ws, a, b, u } = await held();
      await db.query("UPDATE workspace_members SET status = 'removed' WHERE workspace_id = $1 AND user_id = $2", [ws, u]);
      await hold("workspace", ws, a, b);
      expect((await processErasureRequest(db, u, { requestedBy: u })).status).toBe("deferred");
    });

    it("S23 D8 an operator-supplied request id that is already on a queue row is a named failure, not a silent merge", async () => {
      const first = await held();
      await hold("workspace", first.ws, first.a, first.b);
      const queued = await processErasureRequest(db, first.u, { requestedBy: first.u });
      const second = await held();
      await hold("workspace", second.ws, second.a, second.b);
      await expect(processErasureRequest(db, second.u, { requestedBy: second.u, requestId: queued.requestId })).rejects.toMatchObject({ name: "RequestIdInUseError" });
      expect(await queue(second.u)).toEqual([]);
    });

    it("S23 D9 the queue runner is serialised: a second run waits for the first instead of processing the same row twice", async () => {
      const other = new Client({ connectionString: container.getConnectionUri() });
      await other.connect();
      try {
        await other.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [ERASURE_QUEUE_LOCK]);
        let finished = false;
        const run = executePendingErasures(db).then((r) => ((finished = true), r));
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(finished).toBe(false);
        await other.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [ERASURE_QUEUE_LOCK]);
        await run;
        expect(finished).toBe(true);
      } finally {
        await other.end();
      }
    });

    // -------- CLI
    const sink = () => {
      const lines: string[] = [];
      return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
    };

    it("CLI export writes the document to a 0600 file, prints a summary with no personal data, refuses to overwrite, and audits with the operator as actor", async () => {
      const { ws, owner, u } = await held();
      const { mkdtemp, readFile, stat } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const dir = await mkdtemp(`${tmpdir()}/dsar-`);
      const file = `${dir}/out.json`;
      const operator = await user();
      const s = sink();
      const code = await runSubjectCommand(db, ["export", "--user", u, "--requested-by", operator, "--out", file], s.io);
      expect(code).toBe(0);
      expect(subjectExportSchema.parse(JSON.parse(await readFile(file, "utf8"))).subject_user_id).toBe(u);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const printed = s.lines.join("\n");
      expect(printed).toMatch(/request_id/);
      expect(printed).not.toContain(await email(u));
      expect(printed).not.toContain(await email(owner));
      const s2 = sink();
      expect(await runSubjectCommand(db, ["export", "--user", u, "--requested-by", operator, "--out", file], s2.io)).toBe(1);
      const actor = (await db.query("SELECT actor_id FROM audit_log WHERE workspace_id = $1 AND action = 'subject_request.received' ORDER BY seq LIMIT 1", [ws])).rows[0]!;
      expect(actor.actor_id).toBe(operator);
    });

    it("CLI export that fails leaves no empty file behind, so the same --out can be retried", async () => {
      const { u } = await held();
      const { mkdtemp, access } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const file = `${await mkdtemp(`${tmpdir()}/dsar-`)}/out.json`;
      const operator = await user();
      const failing = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "query") return Reflect.get(target, prop, receiver) as unknown;
          return (text: unknown, ...rest: unknown[]) => {
            if (typeof text === "string" && text.includes("email_verified_at")) return Promise.reject(new Error("boom"));
            return (target.query as (...a: unknown[]) => Promise<unknown>)(text, ...rest);
          };
        },
      });
      const s = sink();
      expect(await runSubjectCommand(failing, ["export", "--user", u, "--requested-by", operator, "--out", file], s.io)).toBe(1);
      expect(s.lines.join("\n")).toContain("request failed");
      await expect(access(file)).rejects.toThrow();
      expect(await runSubjectCommand(db, ["export", "--user", u, "--requested-by", operator, "--out", file], sink().io)).toBe(0);
    });

    it("CLI erase needs --confirm equal to the user id: without it, or with a different one, nothing changes", async () => {
      const { u } = await held();
      const operator = await user();
      const before = await email(u);
      for (const extra of [[], ["--confirm", randomUUID()]]) {
        const s = sink();
        expect(await runSubjectCommand(db, ["erase", "--user", u, "--requested-by", operator, ...extra], s.io)).toBe(2);
        expect(s.lines.join("\n")).toContain("--confirm");
      }
      expect(await email(u)).toBe(before);
      expect(await queue(u)).toEqual([]);
    });

    it("CLI erase with the confirmation erases, prints the request id and no address; under a hold it exits 0 and reports the delay reason; a sole owner exits 3 with the way forward", async () => {
      const a1 = await held();
      const operator = await user();
      const s = sink();
      expect(await runSubjectCommand(db, ["erase", "--user", a1.u, "--requested-by", operator, "--confirm", a1.u], s.io)).toBe(0);
      expect(s.lines.join("\n")).toContain("completed");
      expect(s.lines.join("\n")).not.toContain("@");
      expect(await email(a1.u)).toContain("deleted+");

      const h = await held();
      await hold("workspace", h.ws, h.a, h.b);
      const s2 = sink();
      expect(await runSubjectCommand(db, ["erase", "--user", h.u, "--requested-by", operator, "--confirm", h.u], s2.io)).toBe(0);
      expect(s2.lines.join("\n")).toMatch(/deferred/);
      expect(s2.lines.join("\n")).toMatch(/legal hold/);
      expect((await queue(h.u))[0]!.status).toBe("pending");

      const solo = await workspace();
      const only = await user();
      await member(solo, only, "owner");
      const s3 = sink();
      expect(await runSubjectCommand(db, ["erase", "--user", only, "--requested-by", operator, "--confirm", only], s3.io)).toBe(3);
      expect(s3.lines.join("\n")).toContain("Transfer ownership");
    });

    it("CLI refuses an unknown operator and an unknown subject without touching anything, and never prints a connection string or SQL", async () => {
      const { u } = await held();
      const s = sink();
      expect(await runSubjectCommand(db, ["erase", "--user", u, "--requested-by", randomUUID(), "--confirm", u], s.io)).toBe(2);
      expect(await runSubjectCommand(db, ["erase", "--user", randomUUID(), "--requested-by", u, "--confirm", u], s.io)).toBe(2);
      expect(await email(u)).not.toContain("deleted+");
      expect(s.lines.join("\n")).not.toMatch(/postgres:\/\/|SELECT |INSERT /);
    });
  });
});
