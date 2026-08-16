import type { Client } from "pg";
import { connectSuperuser, type AssertionContext } from "../support/assertion-context.js";
import { connectAsRole } from "../support/runtime-roles.js";
import { NOOP_REVERT, type Breaker } from "../support/breakers.js";

// security-and-tenancy.md §10 ISO-17 / STORY-013 — proves
// `app.apply_tenant_rls` is applied to a partition BEFORE it takes writes,
// the exact fix for STORY-011's headline finding (ENABLE/FORCE ROW LEVEL
// SECURITY on a partitioned parent does not cascade to a new child).
// Creates a partition the same way src/workers/rollup/maintenance.ts's
// ensurePartitionsForTable does (`CREATE TABLE ... PARTITION OF ... FOR
// VALUES FROM ... TO ...`), inserts one row as superuser, then queries the
// partition DIRECTLY (never through its parent) as the ordinary
// `nominara_app` runtime role with NO tenant context set. A superuser
// bypasses RLS by an entirely different mechanism, so the check connection
// is deliberately never the superuser used to create the fixture.

const PROBE_TABLE = "answer_captures";
const PROBE_PARTITION = "answer_captures_2099_01";
const PROBE_FROM = "2099-01-01T00:00:00.000Z";
const PROBE_TO = "2099-02-01T00:00:00.000Z";

async function createProbePartition(client: Client, applyRls: boolean): Promise<void> {
  await client.query(`DROP TABLE IF EXISTS ${PROBE_PARTITION}`);
  await client.query(
    `CREATE TABLE ${PROBE_PARTITION} PARTITION OF ${PROBE_TABLE} FOR VALUES FROM ('${PROBE_FROM}') TO ('${PROBE_TO}')`,
  );
  if (applyRls) {
    await client.query("SELECT app.apply_tenant_rls($1::regclass)", [PROBE_PARTITION]);
  }
  await client.query(
    `INSERT INTO ${PROBE_PARTITION}
       (id, workspace_id, project_id, run_id, prompt_id, engine_key, captured_at,
        capture_mode, adapter_version, normalizer_version, content_hash)
     VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
             'chatgpt', $1, 'api', 'v1', 'v1', decode('00', 'hex'))`,
    [PROBE_FROM],
  );
}

async function assertProbeZeroRows(ctx: AssertionContext): Promise<void> {
  const app = await connectAsRole(ctx.target, "nominara_app");
  let count: number;
  try {
    const result = await app.query<{ count: string }>(`SELECT count(*) FROM ${PROBE_PARTITION}`);
    count = Number(result.rows[0]!.count);
  } finally {
    await app.end();
  }
  if (count !== 0) {
    throw new Error(
      `ISO-17: partition ${PROBE_PARTITION} returned ${count} row(s) queried directly, with NO tenant context set, ` +
        "as nominara_app — app.apply_tenant_rls was not applied before this partition took writes, reopening STORY-011's bypass",
    );
  }
}

/** The green path: creates the partition WITH app.apply_tenant_rls, then proves zero rows. */
export async function assertIso17PartitionRlsApplied(ctx: AssertionContext): Promise<void> {
  const superuser = await connectSuperuser(ctx);
  try {
    await createProbePartition(superuser, true);
  } finally {
    await superuser.end();
  }
  await assertProbeZeroRows(ctx);
}

/** The breaker path: iso17Breaker.apply already created the partition WITHOUT the RLS call on the disposable database — this only runs the check. */
export async function assertIso17AgainstMissingApplyTenantRls(ctx: AssertionContext): Promise<void> {
  await assertProbeZeroRows(ctx);
}

export const iso17Breaker: Breaker = {
  id: "ISO-17",
  description:
    "creates a partition the way the maintenance job does (CREATE TABLE ... PARTITION OF), but skips app.apply_tenant_rls — reopening STORY-011's bypass",
  apply: async (client) => {
    await createProbePartition(client, false);
  },
  revert: NOOP_REVERT,
};
