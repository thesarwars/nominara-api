import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { discoverTenantTables } from "../support/discovery.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withTenantContext } from "../../../src/tenancy/tenant-context.js";
import { SYSTEM_ACTOR_ID } from "../../../src/tenancy/constants.js";
import { TenantContextMissingError } from "../../../src/tenancy/errors.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-08 / STORY-012 T18 · D-1 — no HTTP layer
// exists yet (NestJS lands in STORY-022), so this fuzzes at the DATA-ACCESS
// boundary: 500 randomised replays of tenant A's harvested resource
// identifiers, read under tenant B's session via withTenantContext + the
// query guard, asserting ONLY refusals (zero rows / 42501 /
// TenantContextMissingError) — never a row that actually belongs to A.
// Seeded PRNG, printed on failure so a red run is reproducible.

const REPLAY_COUNT = 500;

function mulberry32(seed: number) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface HarvestedIdentifier {
  readonly table: string;
  readonly id: string;
}

async function harvestIdentifiers(ctx: AssertionContext, workspaceId: string): Promise<HarvestedIdentifier[]> {
  const client = await connectSuperuser(ctx);
  try {
    const tables = await discoverTenantTables(client);
    const pool: HarvestedIdentifier[] = [];
    for (const table of tables) {
      if (!table.columns.has("id")) continue; // no single-column identifier to replay for this table
      const result = await client.query<{ id: string }>(
        `SELECT id FROM ${table.name} WHERE ${table.scopeColumn} = $1 LIMIT 5`,
        [workspaceId],
      );
      for (const row of result.rows) pool.push({ table: table.name, id: row.id });
    }
    if (pool.length === 0) {
      throw new Error("ISO-08: harvested zero identifiers from tenant A's fixture — the empty-collection trap forbids this passing vacuously");
    }
    return pool;
  } finally {
    await client.end();
  }
}

export async function assertIso08FuzzReplay(ctx: AssertionContext, role = "nominara_app"): Promise<void> {
  const { a, b } = ctx.fixture;
  const pool = await harvestIdentifiers(ctx, a.workspaceId);
  const seed = 0xc0ffee ^ REPLAY_COUNT;
  const rand = mulberry32(seed);

  const app = await connectAsRole(ctx.target, role);
  let cleanReplays = 0;
  try {
    for (let i = 0; i < REPLAY_COUNT; i++) {
      const pick = pool[Math.floor(rand() * pool.length)]!;
      let leaked = false;
      try {
        await withTenantContext(app, { workspaceId: b.workspaceId, actorId: SYSTEM_ACTOR_ID }, async (tx) => {
          const result = await tx.query(`SELECT * FROM ${pick.table} WHERE id = $1`, [pick.id]);
          if ((result.rowCount ?? 0) > 0) leaked = true;
        });
        cleanReplays++;
      } catch (error) {
        // Only a genuine refusal counts as an acceptable outcome:
        // TenantContextMissingError, or SQLSTATE 42501 (permission denied).
        // Anything else — a broken connection, a bad GUC, a fully revoked
        // grant surfacing under a different error shape — is NOT a refusal
        // and must not be silently absorbed.
        if (error instanceof TenantContextMissingError) continue;
        const code = (error as { code?: string }).code;
        if (code === "42501") continue;
        throw error;
      }
      if (leaked) {
        throw new Error(
          `ISO-08: replay #${i} — tenant A's row (table=${pick.table} id=${pick.id}) was returned under tenant B's session ` +
            `(seed=${seed})`,
        );
      }
    }
  } finally {
    await app.end();
  }

  // A floor on replays that ran to completion without erroring at all —
  // guards against e.g. a fully revoked SELECT grant making every replay
  // "refuse" via 42501, which would otherwise pass vacuously without ever
  // exercising the tenant-scoping property this assertion exists to check.
  const floor = Math.floor(REPLAY_COUNT * 0.9);
  if (cleanReplays < floor) {
    throw new Error(
      `ISO-08: only ${cleanReplays}/${REPLAY_COUNT} replays executed without erroring (floor ${floor}) — ` +
        "too many error-refusals to trust this run as a real exercise of the data path",
    );
  }
}

export const iso08Breaker: Breaker = {
  id: "ISO-08",
  description: "widens a tenant table's policy so a replayed foreign identifier resolves under the wrong tenant's context",
  apply: async (client) => {
    await client.query("ALTER POLICY ws_isolation_competitors ON competitors USING (true)");
  },
  revert: NOOP_REVERT,
};
