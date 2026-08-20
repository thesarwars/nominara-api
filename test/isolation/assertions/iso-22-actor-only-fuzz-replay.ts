import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { withActorContext } from "../../../src/tenancy/tenant-context.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// STORY-021 / ADR-0001 ISO-22 — an ISO-08-style fuzz, extended to the
// actor-only context (the data-access boundary behind GET /workspaces and
// the 409 conflict's "naming the existing workspace" detail — no HTTP layer
// exists yet). 500 randomised replays of harvested `workspaces`/
// `workspace_members` row ids, drawn from ALL THREE tenants and explicitly
// EXCLUDING the probe actor's own membership rows, read under the probe
// actor's withActorContext session — the only acceptable non-empty result is
// the probe actor's OWN workspace row; anything else is a leak.
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
  readonly table: "workspaces" | "workspace_members";
  readonly id: string;
}

async function harvestForeignIdentifiers(ctx: AssertionContext, excludeActorId: string): Promise<HarvestedIdentifier[]> {
  const client = await connectSuperuser(ctx);
  try {
    const pool: HarvestedIdentifier[] = [];
    const workspaces = await client.query<{ id: string }>("SELECT id FROM workspaces");
    for (const row of workspaces.rows) pool.push({ table: "workspaces", id: row.id });

    const members = await client.query<{ id: string }>("SELECT id FROM workspace_members WHERE user_id <> $1", [excludeActorId]);
    for (const row of members.rows) pool.push({ table: "workspace_members", id: row.id });

    if (pool.length === 0) {
      throw new Error("ISO-22: harvested zero identifiers — the empty-collection trap forbids this passing vacuously");
    }
    return pool;
  } finally {
    await client.end();
  }
}

export async function assertIso22ActorOnlyFuzzReplay(ctx: AssertionContext): Promise<void> {
  const { a } = ctx.fixture;
  const actorId = a.userIds[10]!;
  const pool = await harvestForeignIdentifiers(ctx, actorId);
  const seed = 0xc0ffee ^ REPLAY_COUNT;
  const rand = mulberry32(seed);

  const app = await connectAsRole(ctx.target, "nominara_app");
  try {
    for (let i = 0; i < REPLAY_COUNT; i++) {
      const pick = pool[Math.floor(rand() * pool.length)]!;
      await withActorContext(app, { actorId }, async (tx) => {
        const result = await tx.query<{ id: string }>(`SELECT id FROM ${pick.table} WHERE id = $1`, [pick.id]);
        if ((result.rowCount ?? 0) === 0) return;
        // The ONLY acceptable non-empty result: the probe actor's own workspace row.
        if (pick.table === "workspaces" && result.rows[0]!.id === a.workspaceId) return;
        throw new Error(
          `ISO-22: replay #${i} — foreign row (table=${pick.table} id=${pick.id}) was returned under actor ${actorId}'s ` +
            `actor-only context (seed=${seed})`,
        );
      });
    }
  } finally {
    await app.end();
  }
}

export const iso22Breaker: Breaker = {
  id: "ISO-22",
  description: "drops the actor-identity conjunct from self_membership_workspace_members, leaking every member row to any actor-only context",
  apply: async (client) => {
    await client.query("ALTER POLICY self_membership_workspace_members ON workspace_members USING (app.current_workspace() IS NULL)");
  },
  revert: NOOP_REVERT,
};
