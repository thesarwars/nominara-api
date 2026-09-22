import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { GENESIS_HASH, RECHAINED_MARKER_ACTION, verifyChain } from "../../src/lib/crypto/audit-chain.js";
import { REDACTED } from "../../src/lib/crypto/redact.js";
import { AuditChainService, type AppendAuditRowInput } from "../../src/modules/audit/audit-chain.service.js";
import { readWorkspaceChain } from "../../src/modules/audit/audit-log-reader.js";
import { connectAsRole } from "../isolation/support/runtime-roles.js";

// STORY-020 — dangerous area (audit/tenant boundary), real Postgres
// (testing-strategy.md §1): the hash chain's correctness under concurrency
// cannot be trusted against a mocked pg client.

function input(overrides: Partial<AppendAuditRowInput> = {}): AppendAuditRowInput {
  return {
    workspaceId: overrides.workspaceId ?? "11111111-1111-1111-1111-111111111111",
    actorType: "user",
    actorId: "22222222-2222-2222-2222-222222222222",
    actorIp: "127.0.0.1",
    actorUa: "vitest",
    action: "project.create",
    resourceType: "project",
    resourceId: "33333333-3333-3333-3333-333333333333",
    beforeState: null,
    afterState: { name: "Acme" },
    requestId: "req-1",
    supportGrantId: null,
    severity: "info",
    ...overrides,
  };
}

const fetchChain = readWorkspaceChain;

describe("STORY-020 · AuditChainService", () => {
  let container: StartedPostgreSqlContainer;
  let db: Client;
  let pool: Pool;
  let service: AuditChainService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    db = new Client({ connectionString: container.getConnectionUri() });
    await db.connect();
    await migrateUp(db);
    await db.query(`ALTER ROLE nominara_app PASSWORD ${db.escapeLiteral(resolvePassword("nominara_app", {}))}`);
    pool = new Pool({ connectionString: container.getConnectionUri(), max: 8 });
    service = new AuditChainService();
  }, 120_000);

  afterAll(async () => {
    await db.end();
    await pool.end();
    await container.stop();
  });

  // Mirrors AuditInterceptor's real usage: append() only serializes
  // concurrent writers correctly when it runs inside a transaction that is
  // ALREADY open for the whole request (pg_advisory_xact_lock releases at
  // COMMIT) — a bare autocommit client would release the lock between the
  // SELECT-tail and INSERT statements and defeat the point of taking it.
  async function appendInOwnTransaction(input: AppendAuditRowInput): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await service.append(client, input);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("scenario 1 — the first row for a workspace chains onto the genesis hash", async () => {
    const ws = "11111111-1111-1111-1111-111111111111";
    await service.append(db, input({ workspaceId: ws }));
    const [row] = await fetchChain(db, ws);
    expect(row!.prev_hash.equals(GENESIS_HASH)).toBe(true);
  });

  it("chains a second row onto the first row's row_hash, and the chain verifies clean", async () => {
    const ws = "44444444-4444-4444-4444-444444444444";
    await service.append(db, input({ workspaceId: ws, action: "project.create" }));
    await service.append(db, input({ workspaceId: ws, action: "project.update" }));
    const rows = await fetchChain(db, ws);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.prev_hash.equals(rows[0]!.row_hash)).toBe(true);
    expect(verifyChain(rows)).toBeNull();
  });

  it("scenario 7 — redacts a secret-shaped field in after_state before writing", async () => {
    const ws = "55555555-5555-5555-5555-555555555555";
    await service.append(db, input({ workspaceId: ws, afterState: { name: "Acme", apiKey: "hunter2hunter2hunter2" } }));
    const [row] = await fetchChain(db, ws);
    expect((row!.after_state as Record<string, unknown>).apiKey).toBe(REDACTED);
  });

  it("scenario 8 — two tenants' chains are independent; a fresh chain never depends on another workspace's rows", async () => {
    const wsA = "66666666-6666-6666-6666-666666666666";
    const wsB = "77777777-7777-7777-7777-777777777777";
    await service.append(db, input({ workspaceId: wsA, action: "project.create" }));
    await service.append(db, input({ workspaceId: wsA, action: "project.update" }));
    await service.append(db, input({ workspaceId: wsB, action: "project.create" }));

    const rowsA = await fetchChain(db, wsA);
    const rowsB = await fetchChain(db, wsB);
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(1);
    // wsB's first row chains onto genesis, NOT onto wsA's tail — proves the
    // chain key is workspace_id, not a global sequence.
    expect(rowsB[0]!.prev_hash.equals(GENESIS_HASH)).toBe(true);
    expect(verifyChain(rowsA)).toBeNull();
    expect(verifyChain(rowsB)).toBeNull();
  });

  it("concurrent appends to the SAME workspace, each in its own request transaction, never fork the chain", async () => {
    const ws = "88888888-8888-8888-8888-888888888888";
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => appendInOwnTransaction(input({ workspaceId: ws, action: `concurrent.${i}` }))),
    );
    const rows = await fetchChain(db, ws);
    expect(rows).toHaveLength(8);
    expect(verifyChain(rows)).toBeNull();
  });

  it("qa-reviewer blocking #1 — nominara_app (ordinary INSERT grant, no elevated privilege) cannot forge an audit.chain.rechained marker row", async () => {
    const ws = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const appClient = await connectAsRole(
      { host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase() },
      "nominara_app",
      resolvePassword("nominara_app", {}),
    );
    const actorId = "22222222-2222-2222-2222-222222222222";
    try {
      await appClient.query("BEGIN");
      await appClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [ws]);
      await appClient.query("SELECT set_config('app.current_actor_id', $1, true)", [actorId]);
      await expect(service.append(appClient, input({ workspaceId: ws, action: RECHAINED_MARKER_ACTION }))).rejects.toThrow(
        /marker rows may only be inserted by a privileged/,
      );
      await appClient.query("ROLLBACK");

      // Confirm the trigger did not silently swallow ordinary appends too —
      // an unrelated action from the SAME role, in a fresh transaction,
      // still succeeds.
      await appClient.query("BEGIN");
      await appClient.query("SELECT set_config('app.current_workspace_id', $1, true)", [ws]);
      await appClient.query("SELECT set_config('app.current_actor_id', $1, true)", [actorId]);
      await service.append(appClient, input({ workspaceId: ws, action: "project.update" }));
      await appClient.query("COMMIT");
      const rows = await fetchChain(db, ws);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe("project.update");
    } finally {
      await appClient.end();
    }
  });

  // ⚠ STORY-148 review — A CALLER-SUPPLIED ADDRESS MUST NOT BE ABLE TO BREAK
  // THIS CHAIN, and until now nothing stopped one.
  //
  // `actor_ip` is `inet`; the row hash is computed over the string we send and
  // the verifier reads the row back with `host(actor_ip)`. Any spelling
  // Postgres rewrites yields a row that can never be recomputed — a permanent
  // `hash_mismatch` the daily verifier reports as tampering against that
  // TENANT. It became reachable the moment nominara-app started relaying the
  // caller's X-Forwarded-For chain.
  //
  // This asserts against the real database and the real verifier, which is the
  // only place the round-trip is observable: the unit test in
  // test/unit/actor-ip.spec.ts knows which spellings to reject, and THIS knows
  // whether rejecting them was enough.
  it("STORY-148 — a mask suffix in actor_ip does not poison the chain", async () => {
    const ws = "beeff00d-0000-4000-8000-000000000001";
    await service.append(db, input({ workspaceId: ws, actorIp: "203.0.113.9/32", action: "project.update" }));

    const rows = await fetchChain(db, ws);
    // Dropped rather than stored wrong: `host()` would return '203.0.113.9'
    // for it, so hashing '203.0.113.9/32' would be hashing a string this row
    // can never present again.
    expect(rows[0]!.actor_ip).toBeNull();
    expect(verifyChain(rows), "the tenant's chain must still verify").toBeNull();
  });

  it("STORY-148 — an uncastable actor_ip does not abort the mutation's transaction", async () => {
    // `'not-an-ip'::inet` raises 22P02, and the append runs inside the
    // MUTATION's transaction — so without this the request itself fails and
    // no audit row is written for it, repeatably, at the caller's choosing.
    const ws = "beeff00d-0000-4000-8000-000000000002";
    await expect(
      service.append(db, input({ workspaceId: ws, actorIp: "not-an-ip", action: "project.update" })),
    ).resolves.toBeUndefined();

    const rows = await fetchChain(db, ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_ip).toBeNull();
    expect(verifyChain(rows), "a null mismatch is a chain that verifies").toBeNull();
  });

  it("STORY-148 — a real address still round-trips and still verifies", async () => {
    // The guard must not be a blanket null: an audit row with no actor address
    // is the failure this column exists to prevent.
    const ws = "beeff00d-0000-4000-8000-000000000003";
    await service.append(db, input({ workspaceId: ws, actorIp: "203.0.113.9", action: "project.update" }));

    const rows = await fetchChain(db, ws);
    expect(rows[0]!.actor_ip).toBe("203.0.113.9");
    expect(verifyChain(rows), "a null mismatch is a chain that verifies").toBeNull();
  });

  // ⚠ STORY-149 — THE ROUND-TRIP ITSELF, which is the only thing that proves
  // this fix and the only place it is observable.
  //
  // This test previously asserted the OPPOSITE: `2001:0DB8::0001` came back
  // `2001:db8::1` and the chain reported `hash_mismatch`, permanently.
  // `append` now canonicalises through `host()` before hashing, so the value
  // stored and the value the verifier reads are the same string by
  // construction.
  //
  // A table, because one spelling proves one spelling. Each of these is a way
  // Postgres rewrites an address, measured against the real database — and any
  // one of them is a tenant's chain permanently reporting as tampered.
  const REWRITTEN: ReadonlyArray<{ sent: string; stored: string; why: string }> = [
    { sent: "2001:0DB8::0001", stored: "2001:db8::1", why: "uppercase hex and leading zeros in a group" },
    { sent: "2001:DB8:0:0:0:0:0:1", stored: "2001:db8::1", why: "an uncompressed zero run" },
    { sent: "::FFFF:127.0.0.1", stored: "::ffff:127.0.0.1", why: "the dual-stack form fastify produces, in capitals" },
  ];

  for (const [index, spelling] of REWRITTEN.entries()) {
    it(`STORY-149 — '${spelling.sent}' (${spelling.why}) is canonicalised before hashing, and the chain verifies`, async () => {
      // ⚠ ITS OWN PREFIX, AND padStart RATHER THAN `…001${index}`.
      // The template was a valid 12-char final group only while index < 10,
      // so an eleventh row would have failed at append with 22P02 rather than
      // at review. padStart alone was not enough: under the `…0000` prefix the
      // first three indices collided with the single-value tests above and
      // read THEIR rows back. The table gets a prefix nothing else uses.
      const ws = `beeff00d-0001-4000-8000-${String(index).padStart(12, "0")}`;
      await service.append(db, input({ workspaceId: ws, actorIp: spelling.sent, action: "project.update" }));

      const rows = await fetchChain(db, ws);
      expect(rows[0]!.actor_ip, "what the verifier reads back").toBe(spelling.stored);
      expect(verifyChain(rows), "hashing the sent spelling would leave this unrepairable").toBeNull();
    });
  }

  it("STORY-149 — a chain of mixed spellings verifies end to end, not just one row at a time", async () => {
    // A single-row chain cannot fail on `prev_hash`, so it is the weakest
    // possible shape for this claim. Five linked rows is the real one.
    const ws = "beeff00d-0000-4000-8000-000000000020";
    for (const ip of ["203.0.113.9", "2001:0DB8::0001", "::FFFF:127.0.0.1", "not-an-ip", "203.0.113.9/32"]) {
      await service.append(db, input({ workspaceId: ws, actorIp: ip, action: "project.update" }));
    }

    const rows = await fetchChain(db, ws);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.actor_ip)).toEqual(["203.0.113.9", "2001:db8::1", "::ffff:127.0.0.1", null, null]);
    expect(verifyChain(rows)).toBeNull();
  });

  // ⚠ STORY-149 review — THE SAME ASYMMETRY IS LIVE ON EVERY `uuid` COLUMN,
  // AND THAT ONE NEEDS NO PROXY CONFIGURATION AT ALL.
  //
  // `actor_ip` was the field the STORY-148 review named. It is not the class.
  // `workspace_id`, `actor_id`, `resource_id` and `support_grant_id` are all
  // `uuid`, so Postgres lowercases them, and audit-log-reader.ts reads them
  // back canonical while the hash ran over whatever string arrived.
  //
  // `UUID_PATTERN` in audit.interceptor.ts is case-INSENSITIVE (`/i`) and
  // there is no `ParseUUIDPipe` anywhere in this repository, so an uppercase
  // uuid in a URL path reaches `append` verbatim. Any authenticated member
  // with the route's permission can break their own workspace's chain by
  // typing the path in capitals — no `TRUST_PROXY_HOPS`, no relayed header,
  // nothing to configure.
  const UPPER = "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11";
  const LOWER = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

  it("STORY-149 — an uppercase resource_id is canonicalised before hashing, and the chain verifies", async () => {
    const ws = "beeff00d-0000-4000-8000-000000000030";
    await service.append(db, input({ workspaceId: ws, resourceId: UPPER, action: "project.update" }));

    const rows = await fetchChain(db, ws);
    expect(rows[0]!.resource_id).toBe(LOWER);
    expect(verifyChain(rows), "typing a URL in capitals must not break a tenant's chain").toBeNull();
  });

  it("STORY-149 — an uppercase actor_id is canonicalised too", async () => {
    const ws = "beeff00d-0000-4000-8000-000000000031";
    await service.append(db, input({ workspaceId: ws, actorId: UPPER, action: "project.update" }));

    const rows = await fetchChain(db, ws);
    expect(rows[0]!.actor_id).toBe(LOWER);
    expect(verifyChain(rows)).toBeNull();
  });

  it("STORY-149 — an uppercase support_grant_id is canonicalised too", async () => {
    const ws = "beeff00d-0000-4000-8000-000000000032";
    await service.append(
      db,
      input({ workspaceId: ws, actorType: "support", supportGrantId: UPPER, action: "project.update" }),
    );

    const rows = await fetchChain(db, ws);
    expect(rows[0]!.support_grant_id).toBe(LOWER);
    expect(verifyChain(rows)).toBeNull();
  });

  // ⚠ THE WORST PATH TOUCHES THE LOCK AS WELL AS THE HASH.
  // `POST /v1/workspaces/{id}/switch` passes the raw path param as BOTH the
  // workspaceId and the resourceId, and the chain's advisory lock is keyed on
  // `hashtextextended(<that string>, 0)` — which differs entirely between
  // spellings. Two concurrent appends to the SAME workspace in different
  // cases would not serialize, so the chain can FORK on `prev_hash` as well
  // as break on `row_hash`.
  it("STORY-149 — the same workspace in two spellings is ONE chain, under ONE lock", async () => {
    const wsUpper = "BEEFF00D-0000-4000-8000-000000000033";
    const wsLower = "beeff00d-0000-4000-8000-000000000033";

    await service.append(db, input({ workspaceId: wsLower, resourceId: LOWER, action: "project.create" }));
    await service.append(db, input({ workspaceId: wsUpper, resourceId: UPPER, action: "project.update" }));

    const rows = await fetchChain(db, wsLower);
    expect(rows, "both appends belong to one workspace, so one chain").toHaveLength(2);
    expect(rows.map((r) => r.workspace_id)).toEqual([wsLower, wsLower]);
    expect(verifyChain(rows)).toBeNull();
  });

  // ⚠ AND THE THIRD SHAPE OF THE SAME CLASS, ON THE STATE COLUMNS.
  // `canonicalizeAuditContent` DROPS an undefined key; `toJsonbParam` writes
  // SQL NULL, which the reader presents as `null` — key PRESENT. Every call
  // site passes explicit null today, so this is latent; `toJsonbParam`'s own
  // existence advertises `undefined` as expected input, and the field is
  // typed `unknown`. One future caller would poison a chain silently.
  it("STORY-149 — an undefined before_state hashes as the null the reader will return", async () => {
    const ws = "beeff00d-0000-4000-8000-000000000034";
    await service.append(db, input({ workspaceId: ws, beforeState: undefined, action: "project.update" }));

    const rows = await fetchChain(db, ws);
    expect(rows[0]!.before_state).toBeNull();
    expect(verifyChain(rows)).toBeNull();
  });

  // ⚠ AND THE GUARD THAT WAS SUPPOSED TO KEEP AN UNCASTABLE VALUE OUT DOES
  // NOT. `isIP('fe80::1%eth0')` is 6; `'fe80::1%eth0'::inet` raises 22P02,
  // which aborts the transaction the append shares with the MUTATION. So one
  // header is a reliable kill switch on every mutating request a caller
  // makes, leaving no audit trace — verbatim the failure safeActorIp claims
  // to close. `@fastify/proxy-addr` passes a zone id through unchanged.
  it("STORY-149 — an IPv6 zone index does not abort the mutation's transaction", async () => {
    const ws = "beeff00d-0000-4000-8000-000000000035";
    await expect(
      service.append(db, input({ workspaceId: ws, actorIp: "fe80::1%eth0", action: "project.update" })),
    ).resolves.toBeUndefined();

    const rows = await fetchChain(db, ws);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor_ip).toBeNull();
    expect(verifyChain(rows)).toBeNull();
  });

  it("support action records the grant reference alongside the support actor type (scenario 11)", async () => {
    const ws = "99999999-9999-9999-9999-999999999999";
    const grantId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await service.append(
      db,
      input({ workspaceId: ws, actorType: "support", supportGrantId: grantId, action: "project.update" }),
    );
    const [row] = await fetchChain(db, ws);
    expect(row!.actor_type).toBe("support");
    expect(row!.support_grant_id).toBe(grantId);
  });
});
