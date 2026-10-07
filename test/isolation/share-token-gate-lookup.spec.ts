import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { getIsolationProvidedContext } from "./support/context.js";

// STORY-098 part B — pg_proc assertion for the one SECURITY DEFINER function the portal gate needs. A definer function
// runs with its owner's rights, so who may EXECUTE it, and which search_path it resolves names on, is the whole control.
describe("STORY-098 · app.share_token_by_hash is a pinned SECURITY DEFINER function executable by nominara_app only", () => {
  it("holds in pg_proc", async () => {
    const p = getIsolationProvidedContext();
    const client = new Client({ host: p.host, port: p.port, database: p.seedDatabase, user: p.superuser.user, password: p.superuser.password });
    await client.connect();
    try {
      const r = await client.query<{ secdef: boolean; config: string[] | null; roles: string[] }>(
        `SELECT p.prosecdef AS secdef, p.proconfig AS config,
                (SELECT array_agg(r.rolname ORDER BY r.rolname) FROM pg_roles r WHERE has_function_privilege(r.oid, p.oid, 'EXECUTE')
                    AND r.rolname LIKE 'nominara\\_%' AND NOT r.rolsuper AND r.oid <> p.proowner) AS roles
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'app' AND p.proname = 'share_token_by_hash'`,
      );
      expect(r.rows).toHaveLength(1);
      expect(r.rows[0]!.secdef).toBe(true);
      expect((r.rows[0]!.config ?? []).join(",")).toMatch(/search_path=/);
      expect(r.rows[0]!.roles).toEqual(["nominara_app"]);
      const pub = await client.query<{ ok: boolean }>(
        `SELECT has_function_privilege('public', 'app.share_token_by_hash(bytea)', 'EXECUTE') AS ok`,
      );
      expect(pub.rows[0]!.ok).toBe(false);
    } finally {
      await client.end();
    }
  });
});
