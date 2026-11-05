import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { computeRecallAtK, detectDefaultPartitionRows } from "../../src/workers/rollup/maintenance.js";
import { scanForOrphans } from "../../src/workers/rollup/retention.js";

// STORY-013 round 2 · owner decision 58(a) · ADR-0004. The nightly integrity checks read FORCE-RLS tenant tables from the owner
// connection. Under the documented production role (NOSUPERUSER NOBYPASSRLS) they saw nothing. They now go through three count-only
// SECURITY DEFINER functions owned by nominara_maintenance (migration 0160). EVERY case here runs as a real NOSUPERUSER NOBYPASSRLS
// login role: the harness's own superuser would pass each of them vacuously.
const OWNER = "nominara_maintenance";
const FUNCTIONS = [
  "app.maintenance_default_partition_rows()",
  "app.maintenance_orphan_counts()",
  "app.maintenance_recall_overlap(text, halfvec, integer)",
] as const;
const PROD_LIKE = "maint_prod_like";

describe("STORY-013 r2 · count-only maintenance definer (ADR-0004)", () => {
  let container: StartedPostgreSqlContainer;
  let admin: Client;
  let seq = 0;

  const connectAs = async (user: string, password: string): Promise<Client> => {
    const client = new Client({ host: container.getHost(), port: container.getPort(), database: "nominara_test", user, password });
    await client.connect();
    return client;
  };

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    admin = new Client({ connectionString: container.getConnectionUri() });
    await admin.connect();
    await migrateUp(admin, MIGRATIONS_DIR);
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      await admin.query(`ALTER ROLE ${role} PASSWORD ${admin.escapeLiteral(resolvePassword(role, {}))}`);
    }
    // The documented production maintenance identity: a plain login role that is a member of nominara_owner. NOT a superuser, NOT BYPASSRLS.
    await admin.query(`CREATE ROLE ${PROD_LIKE} LOGIN PASSWORD 'pl' NOSUPERUSER NOBYPASSRLS`);
    await admin.query(`GRANT nominara_owner TO ${PROD_LIKE} WITH INHERIT TRUE`);
    // In production nominara_owner OWNS the tables (a direct SELECT returns 0 rows under FORCE RLS). The test schema is owned by the
    // superuser, so this grant stands in for that ownership and makes the blind-control read below return 0 rather than a permission error.
    await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO nominara_owner");
  }, 300_000);

  afterAll(async () => {
    await admin.end();
    await container.stop();
  });

  async function workspace(): Promise<{ workspaceId: string; projectId: string }> {
    seq += 1;
    const ws = await admin.query<{ id: string }>("INSERT INTO workspaces (name, slug, plan_key) VALUES ($1, $2, 'free') RETURNING id", [`MD Secret Name ${seq}`, `md-${seq}-${randomUUID()}`]);
    const pr = await admin.query<{ id: string }>(
      "INSERT INTO projects (workspace_id, name, slug, root_url, root_domain) VALUES ($1, $2, $3, 'https://example.com', 'example.com') RETURNING id",
      [ws.rows[0]!.id, `P ${seq}`, `p-${seq}-${randomUUID()}`],
    );
    return { workspaceId: ws.rows[0]!.id, projectId: pr.rows[0]!.id };
  }

  async function capture(w: { workspaceId: string; projectId: string }, at: string): Promise<{ id: string; at: Date }> {
    const r = await admin.query<{ id: string; captured_at: Date }>(
      `INSERT INTO answer_captures (workspace_id, project_id, run_id, prompt_id, engine_key, captured_at, capture_mode, adapter_version, normalizer_version, content_hash)
       VALUES ($1, $2, gen_random_uuid(), gen_random_uuid(), 'chatgpt', $3, 'api', 'v1', 'v1', decode('00', 'hex')) RETURNING id, captured_at`,
      [w.workspaceId, w.projectId, at],
    );
    return { id: r.rows[0]!.id, at: r.rows[0]!.captured_at };
  }

  async function mention(w: { workspaceId: string; projectId: string }, resultId: string, at: string | Date): Promise<void> {
    await admin.query(
      `INSERT INTO mention_facts (workspace_id, project_id, result_id, prompt_id, engine_key, captured_at, entity_type, entity_label, matched_alias, occurrence_index, char_start, char_end, first_token_index, prominence, sentiment_label, sentiment_score, sentiment_confidence, sentiment_method)
       VALUES ($1, $2, $3, gen_random_uuid(), 'chatgpt', $4, 'brand', 'Acme', 'acme', 0, 0, 4, 0, 0.5, 'neutral', 0, 1, 'heuristic')`,
      [w.workspaceId, w.projectId, resultId, at],
    );
  }

  async function prompts(w: { workspaceId: string; projectId: string }, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      let state = seq >>> 0 || 1;
      const values = Array.from({ length: 1536 }, () => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return (state / 0xffffffff) * 2 - 1;
      });
      await admin.query(
        `INSERT INTO tracked_prompts (workspace_id, project_id, text, text_hash, intent_archetype, funnel_stage, embedding) VALUES ($1, $2, $3, $4, 'recommendation', 'awareness', $5::halfvec)`,
        [w.workspaceId, w.projectId, `prompt ${seq}`, createHash("sha256").update(`md-${seq}`).digest(), `[${values.join(",")}]`],
      );
    }
  }

  it("MD-1 · as a NOSUPERUSER NOBYPASSRLS role the checks see the REAL counts across three tenants, while a direct SELECT on the same tables sees none", async () => {
    await admin.query("TRUNCATE mention_facts, citation_facts, answer_captures, tracked_prompts CASCADE");
    const [a, b, c] = [await workspace(), await workspace(), await workspace()];
    // Tenant A: 2 orphans. Tenant B: 1 orphan. Tenant C: a healthy capture + fact. A default-partition capture and fact for B and C.
    await mention(a, randomUUID(), new Date().toISOString());
    await mention(a, randomUUID(), new Date().toISOString());
    await mention(b, randomUUID(), new Date().toISOString());
    const healthy = await capture(c, new Date().toISOString());
    await mention(c, healthy.id, healthy.at);
    const stranded = await capture(b, "2031-03-15T00:00:00Z");
    await capture(c, "2031-03-16T00:00:00Z");
    await mention(b, stranded.id, stranded.at);
    await prompts(a, 12);

    const client = await connectAs(PROD_LIKE, "pl");
    try {
      // Control: this role is genuinely blind to the tables (FORCE RLS). Without this the cases below could pass for the wrong reason.
      const attrs = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(attrs.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
      const direct = await client.query<{ n: string }>("SELECT count(*)::text AS n FROM answer_captures");
      expect(direct.rows[0]!.n).toBe("0");

      const orphans = await scanForOrphans(client);
      expect(orphans.reduce((sum, r) => sum + r.orphanCount, 0)).toBe(3);
      expect(orphans.every((r) => r.table === "mention_facts")).toBe(true);

      const defaults = await detectDefaultPartitionRows(client);
      expect(defaults).toEqual(
        expect.arrayContaining([
          { table: "answer_captures", defaultPartition: "answer_captures_default", rowCount: 2 },
          { table: "mention_facts", defaultPartition: "mention_facts_default", rowCount: 1 },
        ]),
      );
      expect(defaults.find((d) => d.table === "citation_facts")).toBeUndefined();

      const recall = await computeRecallAtK(client, "tracked_prompts", "embedding");
      expect(recall).not.toBeNull();
      expect(recall!).toBeGreaterThan(0);
      // Too few rows is still null (not 0) on the definer path.
      expect(await computeRecallAtK(client, "topic_clusters", "centroid")).toBeNull();
    } finally {
      await client.end();
    }
  }, 120_000);

  it("MD-2 · the functions return COUNTS ONLY: every output column is text/bigint/integer, and no function takes a predicate or an arbitrary relation", async () => {
    const r = await admin.query<{ proname: string; args: string; outs: string[] | null; outtypes: string[] | null; rettype: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args, p.proargnames::text[] AS outs,
              (SELECT array_agg(format_type(t, NULL) ORDER BY ord) FROM unnest(p.proallargtypes) WITH ORDINALITY AS u(t, ord)) AS outtypes,
              format_type(p.prorettype, NULL) AS rettype
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%' ORDER BY p.proname`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual(["maintenance_default_partition_rows", "maintenance_orphan_counts", "maintenance_recall_overlap"]);
    const allowed = new Set(["text", "bigint", "integer", "halfvec"]);
    for (const row of r.rows) {
      for (const t of row.outtypes ?? [row.rettype]) {
        expect(allowed.has(t), `${row.proname} exposes a ${t} column`).toBe(true);
      }
    }
    // Inputs: the only free-text input is the recall function's table name, validated against a fixed list (MD-2b). The other two take nothing.
    expect(r.rows.find((x) => x.proname === "maintenance_default_partition_rows")!.args).toBe("");
    expect(r.rows.find((x) => x.proname === "maintenance_orphan_counts")!.args).toBe("");
    expect(r.rows.find((x) => x.proname === "maintenance_recall_overlap")!.args).toBe("p_table text, p_query halfvec, p_k integer");
  });

  it("MD-2b · a caller cannot steer the recall function at another table or smuggle a predicate through its text argument", async () => {
    const client = await connectAs(PROD_LIKE, "pl");
    try {
      const zero = `[${new Array(1536).fill(0.1).join(",")}]`;
      for (const hostile of ["users", "tracked_prompts WHERE true", "tracked_prompts; SELECT 1", "public.tracked_prompts", "workspaces", ""]) {
        await expect(client.query("SELECT * FROM app.maintenance_recall_overlap($1, $2::halfvec, 10)", [hostile, zero])).rejects.toThrow(/not an allowed|invalid/i);
      }
      await expect(client.query("SELECT * FROM app.maintenance_recall_overlap('tracked_prompts', $1::halfvec, 0)", [zero])).rejects.toThrow(/p_k/i);
      await expect(client.query("SELECT * FROM app.maintenance_recall_overlap('tracked_prompts', $1::halfvec, 100000)", [zero])).rejects.toThrow(/p_k/i);
      // And the outputs of the real call carry numbers only, never a row id or vector.
      const ok = await client.query("SELECT * FROM app.maintenance_recall_overlap('tracked_prompts', $1::halfvec, 10)", [zero]);
      for (const row of ok.rows) for (const value of Object.values(row)) expect(["number", "string"]).toContain(typeof value);
      expect(Object.keys(ok.rows[0] ?? {}).sort()).toEqual(["candidate_rows", "overlap"]);
    } finally {
      await client.end();
    }
  }, 60_000);

  it("MD-3 · the owner role holds COLUMN-level SELECT only on the seven tables it needs: no table grant, no write, and none of the content columns", async () => {
    const tableLevel = await admin.query<{ table_name: string; privilege_type: string }>(
      "SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = $1",
      [OWNER],
    );
    expect(tableLevel.rows).toEqual([]);
    const cols = await admin.query<{ table_name: string; column_name: string; privilege_type: string }>(
      "SELECT table_name, column_name, privilege_type FROM information_schema.role_column_grants WHERE grantee = $1 AND table_schema = 'public' ORDER BY 1, 2",
      [OWNER],
    );
    expect(cols.rows.every((x) => x.privilege_type === "SELECT")).toBe(true);
    expect([...new Set(cols.rows.map((x) => x.table_name))].sort()).toEqual(["answer_captures", "citation_facts", "content_chunks", "corpus_passages", "mention_facts", "topic_clusters", "tracked_prompts"]);
    const names = cols.rows.map((x) => x.column_name);
    for (const content of ["entity_label", "text", "raw_text", "normalized_text", "matched_alias", "url", "content_hash"]) expect(names).not.toContain(content);
  });

  it("MD-4 · a tenant runtime role, and PUBLIC, cannot EXECUTE any of the functions (permission denied, SQLSTATE 42501)", async () => {
    for (const role of [...RUNTIME_ROLES, BREAKGLASS_ROLE]) {
      const client = await connectAs(role, resolvePassword(role, {}));
      try {
        for (const call of ["SELECT * FROM app.maintenance_default_partition_rows()", "SELECT * FROM app.maintenance_orphan_counts()", `SELECT * FROM app.maintenance_recall_overlap('tracked_prompts', '[${new Array(1536).fill(0.1).join(",")}]'::halfvec, 10)`]) {
          if (role === BREAKGLASS_ROLE) continue; // breakglass is BYPASSRLS and reads rows directly; it is not a tenant role and is not asserted here
          await expect(client.query(call), `${role}: ${call.slice(0, 60)}`).rejects.toMatchObject({ code: "42501" });
        }
      } finally {
        await client.end();
      }
    }
    for (const fn of FUNCTIONS) {
      const pub = await admin.query<{ x: boolean }>(`SELECT has_function_privilege('public', '${fn}', 'EXECUTE') AS x`);
      expect(pub.rows[0]!.x, fn).toBe(false);
    }
  }, 60_000);

  it("MD-5 · the owner is NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT with no members; each function is SECURITY DEFINER, search_path pinned, EXECUTE for nominara_owner only", async () => {
    const role = await admin.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>(
      "SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1",
      [OWNER],
    );
    expect(Object.values(role.rows[0]!)).toEqual([false, false, false, false, false, false, false]);
    const members = await admin.query("SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid WHERE r.rolname = $1", [OWNER]);
    expect(members.rowCount).toBe(0);
    const fns = await admin.query<{ proname: string; owner: string; secdef: boolean; config: string[] | null; holders: string[] | null }>(
      `SELECT p.proname, o.rolname::text AS owner, p.prosecdef AS secdef, p.proconfig AS config,
              (SELECT array_agg(x.rolname::text ORDER BY x.rolname) FROM pg_roles x WHERE has_function_privilege(x.oid, p.oid, 'EXECUTE') AND x.rolname LIKE 'nominara\\_%' AND NOT x.rolsuper AND x.oid <> p.proowner) AS holders
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%'`,
    );
    expect(fns.rowCount).toBe(3);
    for (const f of fns.rows) {
      expect(f.owner).toBe(OWNER);
      expect(f.secdef).toBe(true);
      expect(f.config).toContain("search_path=pg_catalog, pg_temp");
      expect(f.holders).toEqual(["nominara_owner"]);
    }
  });

  it("MD-6 · the owner is admitted by exactly one FOR SELECT policy per table it reads, TO that role only, USING (true); the ws_isolation policies are untouched", async () => {
    const policies = await admin.query<{ tablename: string; policyname: string; cmd: string; roles: string; qual: string; with_check: string | null }>(
      "SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE schemaname = 'public' AND $1 = ANY(roles) ORDER BY tablename",
      [OWNER],
    );
    expect(policies.rows.map((p) => p.tablename)).toEqual(["answer_captures", "citation_facts", "content_chunks", "corpus_passages", "mention_facts", "topic_clusters", "tracked_prompts"]);
    for (const p of policies.rows) {
      expect([p.cmd, p.roles, p.qual, p.with_check]).toEqual(["SELECT", `{${OWNER}}`, "true", null]);
    }
    const iso = await admin.query("SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'mention_facts' AND policyname = 'ws_isolation_mention_facts' AND NOT ($1 = ANY(roles))", [OWNER]);
    expect(iso.rowCount).toBe(1);
  });

  it("MD-7 · ISO-07 holds: across the whole cluster only nominara_breakglass has rolbypassrls", async () => {
    const r = await admin.query<{ rolname: string }>("SELECT rolname FROM pg_roles WHERE rolbypassrls AND rolname LIKE 'nominara\\_%'");
    expect(r.rows.map((x) => x.rolname)).toEqual(["nominara_breakglass"]);
  });

  it("MD-8 · a missing default partition is an ERROR, never a clean 0", async () => {
    await admin.query("ALTER TABLE citation_facts DETACH PARTITION citation_facts_default");
    try {
      const client = await connectAs(PROD_LIKE, "pl");
      try {
        await expect(client.query("SELECT * FROM app.maintenance_default_partition_rows()")).rejects.toThrow(/citation_facts_default/);
      } finally {
        await client.end();
      }
    } finally {
      await admin.query("ALTER TABLE citation_facts ATTACH PARTITION citation_facts_default DEFAULT");
    }
  }, 60_000);

  it("MD-9 · 0160 rolls back cleanly (functions, policies and grants gone, rows untouched) and re-applies", async () => {
    await rollbackLast(admin, MIGRATIONS_DIR);
    const gone = await admin.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%'");
    expect(gone.rowCount).toBe(0);
    const pol = await admin.query("SELECT 1 FROM pg_policies WHERE $1 = ANY(roles)", [OWNER]);
    expect(pol.rowCount).toBe(0);
    await migrateUp(admin, MIGRATIONS_DIR);
    const back = await admin.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%'");
    expect(back.rowCount).toBe(3);
  }, 120_000);
});
