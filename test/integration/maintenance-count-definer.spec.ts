import { createHash, randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "../../src/db/conventions.js";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";
import { effectiveExecuteHolders } from "../isolation/assertions/iso-29-maintenance-execute-effective.js";
import { maintenanceOutputTypes } from "../isolation/assertions/iso-27-maintenance-definer-shape.js";
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
    const r = await admin.query<{ proname: string; args: string }>(
      `SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%' ORDER BY p.proname`,
    );
    expect(r.rows.map((x) => x.proname)).toEqual(["maintenance_default_partition_rows", "maintenance_orphan_counts", "maintenance_recall_overlap"]);
    const allowed = new Set(["text", "bigint", "integer"]);
    const outputs = await maintenanceOutputTypes(admin);
    for (const row of r.rows) {
      for (const t of outputs.get(row.proname) ?? []) {
        expect(allowed.has(t), `${row.proname} exposes a ${t} column`).toBe(true);
      }
    }
    // Inputs: the only free-text input is the recall function's table name, validated against a fixed list (MD-2b). The other two take nothing.
    expect(r.rows.find((x) => x.proname === "maintenance_default_partition_rows")!.args).toBe("");
    expect(r.rows.find((x) => x.proname === "maintenance_orphan_counts")!.args).toBe("");
    expect(r.rows.find((x) => x.proname === "maintenance_recall_overlap")!.args).toBe("p_table text, p_query halfvec, p_k integer");
  });

  it("MD-2c · an INOUT halfvec (an argument handed back to the caller) is seen by the output-type filter, and an OUT one, and a plain return", async () => {
    await admin.query("CREATE FUNCTION app.maintenance_zz_probe_inout(INOUT v halfvec, OUT n integer) LANGUAGE sql AS 'SELECT v, 1'");
    await admin.query("CREATE FUNCTION app.maintenance_zz_probe_out(OUT v halfvec, k integer) LANGUAGE sql AS 'SELECT NULL::halfvec'");
    await admin.query("CREATE FUNCTION app.maintenance_zz_probe_ret(k integer) RETURNS halfvec LANGUAGE sql AS 'SELECT NULL::halfvec'");
    try {
      const seen = await maintenanceOutputTypes(admin, "maintenance\\_zz\\_probe%");
      // two result columns, so the declared return type is a record and cannot stand in for the modes: the INOUT column must be listed itself
      expect(seen.get("maintenance_zz_probe_inout")).toEqual(["halfvec", "integer"]);
      expect(seen.get("maintenance_zz_probe_out")).toEqual(["halfvec"]);
      expect(seen.get("maintenance_zz_probe_ret")).toEqual(["halfvec"]);
    } finally {
      await admin.query("DROP FUNCTION app.maintenance_zz_probe_inout(halfvec)");
      await admin.query("DROP FUNCTION app.maintenance_zz_probe_out(integer)");
      await admin.query("DROP FUNCTION app.maintenance_zz_probe_ret(integer)");
    }
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

  it("MD-5 · the owner is NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT with no members; each function is SECURITY DEFINER, search_path pinned, EXECUTE for nominara_owner only, and no runtime role can reach it through a membership", async () => {
    const role = await admin.query<{ rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean }>(
      "SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication FROM pg_roles WHERE rolname = $1",
      [OWNER],
    );
    expect(Object.values(role.rows[0]!)).toEqual([false, false, false, false, false, false, false]);
    const members = await admin.query("SELECT 1 FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid WHERE r.rolname = $1", [OWNER]);
    expect(members.rowCount).toBe(0);
    // And it is a member of NO role (it must not inherit anything), including the PG16 per-grant INHERIT case.
    const memberOf = await admin.query("SELECT 1 FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member WHERE m.rolname = $1", [OWNER]);
    expect(memberOf.rowCount).toBe(0);
    const fns = await admin.query<{ proname: string; owner: string; secdef: boolean; config: string[] | null; grantees: string[] }>(
      `SELECT p.proname, o.rolname::text AS owner, p.prosecdef AS secdef, p.proconfig AS config,
              coalesce((SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)
                          FROM aclexplode(p.proacl) a WHERE a.privilege_type = 'EXECUTE'), ARRAY['PUBLIC (null acl)']) AS grantees
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%'`,
    );
    expect(fns.rowCount).toBe(3);
    for (const f of fns.rows) {
      expect(f.owner).toBe(OWNER);
      expect(f.secdef).toBe(true);
      expect(f.config).toContain("search_path=pg_catalog, pg_temp");
      expect(f.config).toContain("TimeZone=UTC");
      expect(f.config).toContain("DateStyle=ISO, MDY");
      // The ACL itself, not a filtered view of roles: exactly the owner and nominara_owner, and nobody (PUBLIC = grantee 0) else.
      expect(new Set(f.grantees), f.proname).toEqual(new Set(["nominara_maintenance", "nominara_owner"]));
      expect(f.grantees.length, f.proname).toBe(2);
    }
    // EFFECTIVE execute (ISO-29): the exact ACL above is not enough, a role that is a MEMBER of nominara_owner executes through it.
    // The roles that must be refused are NAMED (runtime roles, share-lookup, a non-BYPASSRLS break-glass), not selected by prefix: the
    // G-4 maintenance login is a legitimate member of nominara_owner and must not be flagged.
    expect(await effectiveExecuteHolders(admin)).toEqual([]);
    for (const fn of FUNCTIONS) {
      const legit = await admin.query<{ x: boolean }>(`SELECT has_function_privilege('${PROD_LIKE}', '${fn}', 'EXECUTE') AS x`);
      expect(legit.rows[0]!.x, `${PROD_LIKE} is the G-4 login and may execute ${fn}`).toBe(true);
    }
    // Inline red step: a runtime role granted nominara_owner (INHERIT, then plain/SET) must be flagged.
    for (const grant of ["GRANT nominara_owner TO nominara_worker WITH INHERIT TRUE", "GRANT nominara_owner TO nominara_worker"]) {
      await admin.query(grant);
      try {
        const flagged = await effectiveExecuteHolders(admin);
        expect(flagged.map((h) => h.role), grant).toContain("nominara_worker");
        expect(flagged.map((h) => h.role), grant).not.toContain(PROD_LIKE);
      } finally {
        await admin.query("REVOKE nominara_owner FROM nominara_worker");
      }
      expect(await effectiveExecuteHolders(admin)).toEqual([]);
    }
    // The same query sees a grant to PUBLIC and to a role without the nominara_ prefix.
    await admin.query("CREATE ROLE md5_plain_reader NOLOGIN");
    try {
      await admin.query("GRANT USAGE ON SCHEMA app TO md5_plain_reader");
      await admin.query("GRANT EXECUTE ON FUNCTION app.maintenance_orphan_counts() TO md5_plain_reader, PUBLIC");
      const dirty = await admin.query<{ grantees: string[] }>(
        `SELECT array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END ORDER BY CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END) AS grantees
           FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid = 'app.maintenance_orphan_counts()'::regprocedure`,
      );
      expect(new Set(dirty.rows[0]!.grantees)).toEqual(new Set(["PUBLIC", "md5_plain_reader", "nominara_maintenance", "nominara_owner"]));
    } finally {
      await admin.query("REVOKE EXECUTE ON FUNCTION app.maintenance_orphan_counts() FROM md5_plain_reader, PUBLIC");
      await admin.query("REVOKE USAGE ON SCHEMA app FROM md5_plain_reader");
      await admin.query("DROP ROLE md5_plain_reader");
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

  it("MD-11 · the default-partition count scans ONLY the *_default partitions (no monthly partition is read)", async () => {
    await admin.query("BEGIN");
    try {
      const scans = async (): Promise<Map<string, number>> => {
        const r = await admin.query<{ relname: string; n: string }>(
          `SELECT c.relname::text AS relname, (coalesce(x.seq_scan, 0) + coalesce(x.idx_scan, 0))::text AS n
             FROM pg_class c LEFT JOIN pg_stat_xact_user_tables x ON x.relid = c.oid
            WHERE c.relkind = 'r' AND c.relname ~ '^(answer_captures|mention_facts|citation_facts)_'`,
        );
        return new Map(r.rows.map((row) => [row.relname, Number(row.n)]));
      };
      const before = await scans();
      // Without a monthly partition to NOT touch, "only the defaults were read" is vacuous.
      const monthly = [...before.keys()].filter((name) => !name.endsWith("_default"));
      expect(monthly.length, "no non-default monthly partition exists").toBeGreaterThan(0);
      await admin.query("SELECT * FROM app.maintenance_default_partition_rows()");
      const after = await scans();
      const touched = [...after].filter(([name, n]) => n > (before.get(name) ?? 0)).map(([name]) => name).sort();
      expect(touched).toEqual(["answer_captures_default", "citation_facts_default", "mention_facts_default"]);
    } finally {
      await admin.query("ROLLBACK");
    }
  }, 60_000);

  it("MD-12 · the default-partition count runs under a transaction-local statement_timeout: a blocked count fails with 57014 and nothing leaks into the session", async () => {
    const blocker = new Client({ connectionString: container.getConnectionUri() });
    await blocker.connect();
    const client = await connectAs(PROD_LIKE, "pl");
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE answer_captures_default IN ACCESS EXCLUSIVE MODE");
      const started = Date.now();
      await expect(detectDefaultPartitionRows(client, 400)).rejects.toMatchObject({ code: "57014" });
      expect(Date.now() - started).toBeLessThan(10_000);
      // The failed transaction was rolled back and the timeout was LOCAL: the session is usable and unbounded again.
      const after = await client.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t");
      expect(after.rows[0]!.t).toBe("0");
    } finally {
      await blocker.query("ROLLBACK");
      await blocker.end();
      await client.end();
    }
  }, 60_000);

  // Roll back until 0160 itself is rolled back, so the case survives a later migration merging after it. It STOPS, without rolling anything
  // back, the moment the newest applied migration is ordered before 0160: a failure here must not unwind the whole chain.
  async function rollbackThrough0160(): Promise<string[]> {
    const undone: string[] = [];
    for (;;) {
      const newest = await admin.query<{ name: string }>("SELECT name FROM _migrations.applied ORDER BY name DESC LIMIT 1");
      const next = newest.rows[0]?.name;
      if (next === undefined || next < "0160_") throw new Error(`0160 is not applied (newest applied: ${next ?? "none"}); refusing to roll back further`);
      const name = await rollbackLast(admin, MIGRATIONS_DIR);
      if (name === null) throw new Error("0160 was never rolled back");
      undone.push(name);
      if (name.startsWith("0160_")) return undone;
    }
  }

  it("MD-9 · 0160 rolls back cleanly (functions, policies and grants gone, rows untouched) and re-applies", async () => {
    const undone = await rollbackThrough0160();
    expect(undone[undone.length - 1]).toMatch(/^0160_/);
    const gone = await admin.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%'");
    expect(gone.rowCount).toBe(0);
    const pol = await admin.query("SELECT 1 FROM pg_policies WHERE $1 = ANY(roles)", [OWNER]);
    expect(pol.rowCount).toBe(0);
    await migrateUp(admin, MIGRATIONS_DIR);
    const back = await admin.query("SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'app' AND p.proname LIKE 'maintenance\\_%'");
    expect(back.rowCount).toBe(3);
  }, 120_000);

  it("MD-9b · rolling 0160 back leaves nominara_owner's USAGE on schema app exactly as it was (createPartition calls app.apply_tenant_rls)", async () => {
    const usage = async (): Promise<boolean> =>
      (await admin.query<{ x: boolean }>("SELECT has_schema_privilege('nominara_owner', 'app', 'USAGE') AS x")).rows[0]!.x;
    await rollbackThrough0160();
    // The owner already holds USAGE in production, before 0160 ever runs.
    await admin.query("GRANT USAGE ON SCHEMA app TO nominara_owner");
    expect(await usage()).toBe(true);
    await migrateUp(admin, MIGRATIONS_DIR);
    expect(await usage()).toBe(true);
    await rollbackThrough0160();
    expect(await usage(), "the down must not revoke a USAGE it did not own").toBe(true);
    await migrateUp(admin, MIGRATIONS_DIR);
  }, 180_000);

  it("MD-10 · re-running 0160 strips every role the maintenance owner is a member of", async () => {
    await rollbackThrough0160();
    await admin.query("GRANT nominara_worker TO nominara_maintenance");
    await migrateUp(admin, MIGRATIONS_DIR);
    const memberOf = await admin.query("SELECT 1 FROM pg_auth_members am JOIN pg_roles m ON m.oid = am.member WHERE m.rolname = $1", [OWNER]);
    expect(memberOf.rowCount).toBe(0);
  }, 180_000);

  // The down revokes USAGE on schema app only if 0160 granted it. It must ALSO not revoke when nominara_owner owns the schema (or is a member of
  // its owner): there USAGE is the owner's own and a REVOKE would strip it, breaking createPartition's call to app.apply_tenant_rls().
  async function downKeepsUsageWhen(transfer: () => Promise<void>, restore: () => Promise<void>): Promise<void> {
    const usage = async (): Promise<boolean> => (await admin.query<{ x: boolean }>("SELECT has_schema_privilege('nominara_owner', 'app', 'USAGE') AS x")).rows[0]!.x;
    await rollbackThrough0160();
    await admin.query("REVOKE USAGE ON SCHEMA app FROM nominara_owner");
    await migrateUp(admin, MIGRATIONS_DIR); // 0160 grants USAGE itself here and leaves its marker
    expect(await usage()).toBe(true);
    await transfer();
    try {
      expect(await usage(), "owner reaches app through ownership").toBe(true);
      await rollbackThrough0160();
      expect(await usage(), "the down must not strip the schema owner's own USAGE").toBe(true);
    } finally {
      await restore();
      await migrateUp(admin, MIGRATIONS_DIR);
    }
  }

  it("MD-9c · rolling 0160 back keeps USAGE on schema app when nominara_owner OWNS the schema (ownership transferred after the up)", async () => {
    const original = (await admin.query<{ o: string }>("SELECT nspowner::regrole::text AS o FROM pg_namespace WHERE nspname = 'app'")).rows[0]!.o;
    await downKeepsUsageWhen(
      async () => void (await admin.query("ALTER SCHEMA app OWNER TO nominara_owner")),
      async () => void (await admin.query(`ALTER SCHEMA app OWNER TO ${original}`)),
    );
  }, 240_000);

  it("MD-9d · rolling 0160 back keeps USAGE on schema app when nominara_owner is a MEMBER of the schema's owner", async () => {
    const original = (await admin.query<{ o: string }>("SELECT nspowner::regrole::text AS o FROM pg_namespace WHERE nspname = 'app'")).rows[0]!.o;
    await admin.query("CREATE ROLE md9d_schema_owner NOLOGIN");
    try {
      await downKeepsUsageWhen(
        async () => {
          await admin.query("ALTER SCHEMA app OWNER TO md9d_schema_owner");
          await admin.query("GRANT md9d_schema_owner TO nominara_owner WITH INHERIT TRUE");
        },
        async () => {
          await admin.query(`ALTER SCHEMA app OWNER TO ${original}`);
          await admin.query("REVOKE md9d_schema_owner FROM nominara_owner");
        },
      );
    } finally {
      await admin.query("DROP ROLE md9d_schema_owner");
    }
  }, 240_000);

  it("MD-13 · detectDefaultPartitionRows refuses to run inside a caller's transaction and leaves that transaction exactly as it was", async () => {
    const client = await connectAs(PROD_LIKE, "pl");
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE md13_marker (x integer)");
      const listeners = client.listenerCount("notice");
      await expect(detectDefaultPartitionRows(client)).rejects.toThrow(/inside an existing transaction/);
      expect(client.listenerCount("notice"), "no listener leaked").toBe(listeners);
      // The caller's transaction was not committed, and no timeout was applied to it.
      expect((await client.query<{ t: string }>("SELECT current_setting('statement_timeout') AS t")).rows[0]!.t).toBe("0");
      await client.query("ROLLBACK");
      expect((await client.query<{ r: string | null }>("SELECT to_regclass('md13_marker')::text AS r")).rows[0]!.r).toBeNull();
      // Outside a transaction it still works.
      await expect(detectDefaultPartitionRows(client)).resolves.toEqual(expect.any(Array));
    } finally {
      await client.end();
    }
  }, 60_000);

  it("MD-14 · detectDefaultPartitionRows rejects a timeout that is zero, negative or not finite, before sending any statement", async () => {
    const never = { query: () => Promise.reject(new Error("no statement may be sent")), on: () => undefined, removeListener: () => undefined } as never;
    for (const bad of [0, 0.5, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(detectDefaultPartitionRows(never, bad), String(bad)).rejects.toThrow(/timeoutMs/);
    }
  });
});
