import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-098 part B / ADR-0002 — pg_proc assertion for the one SECURITY DEFINER function the portal gate needs, formerly
// the standalone test/isolation/share-token-gate-lookup.spec.ts (which no breaker ever ran against). A definer function
// runs with its owner's rights, so its owner, who may EXECUTE it, and the search_path it resolves names on are the whole
// control.
export async function assertIso25ShareLookupDefinerShape(ctx: AssertionContext): Promise<void> {
  const client = await connectSuperuser(ctx);
  try {
    const r = await client.query<{ secdef: boolean; config: string[] | null; roles: string[] | null; owner: string; super: boolean; login: boolean; bypass: boolean; pub: boolean }>(
      `SELECT p.prosecdef AS secdef, p.proconfig AS config,
              (SELECT array_agg(x.rolname::text ORDER BY x.rolname) FROM pg_roles x WHERE has_function_privilege(x.oid, p.oid, 'EXECUTE')
                  AND x.rolname LIKE 'nominara\\_%' AND NOT x.rolsuper AND x.oid <> p.proowner) AS roles,
              o.rolname::text AS owner, o.rolsuper AS super, o.rolcanlogin AS login, o.rolbypassrls AS bypass,
              has_function_privilege('public', p.oid, 'EXECUTE') AS pub
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles o ON o.oid = p.proowner
        WHERE n.nspname = 'app' AND p.proname = 'share_token_by_hash'`,
    );
    if (r.rowCount !== 1) {
      throw new Error(`ISO-25: expected exactly one app.share_token_by_hash, found ${r.rowCount}`);
    }
    const row = r.rows[0]!;
    if (!row.secdef) throw new Error("ISO-25: app.share_token_by_hash is not SECURITY DEFINER");
    const searchPath = (row.config ?? []).find((c) => c.startsWith("search_path="));
    if (searchPath !== "search_path=pg_catalog, pg_temp") {
      throw new Error(`ISO-25: search_path is not pinned to 'pg_catalog, pg_temp' (got ${searchPath ?? "unset"})`);
    }
    if (row.owner !== "nominara_share_lookup" || row.super || row.login || row.bypass) {
      throw new Error(`ISO-25: owner must be nominara_share_lookup, NOSUPERUSER NOLOGIN NOBYPASSRLS (got ${JSON.stringify({ owner: row.owner, super: row.super, login: row.login, bypass: row.bypass })})`);
    }
    if (row.pub) throw new Error("ISO-25: EXECUTE is granted to PUBLIC");
    if (JSON.stringify(row.roles) !== JSON.stringify(["nominara_app"])) {
      throw new Error(`ISO-25: EXECUTE must be held by nominara_app alone (got ${JSON.stringify(row.roles)})`);
    }
  } finally {
    await client.end();
  }
}

export const iso25Breaker: Breaker = {
  id: "ISO-25",
  description: "re-grants EXECUTE on app.share_token_by_hash to PUBLIC",
  apply: async (client) => {
    await client.query("GRANT EXECUTE ON FUNCTION app.share_token_by_hash(bytea) TO PUBLIC");
  },
  revert: NOOP_REVERT,
};
