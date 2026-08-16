import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp } from "../../src/db/migrate-runner.js";
import { findBlockingPurgeFailures, PURGE_FAILURE_GRACE_DAYS } from "../../src/db/purge-check.js";
import { recordPurgeFailure, resolvePurgeFailure } from "../../src/workers/rollup/retention.js";

// STORY-013 · Test Scenario 14 — "leave a purge failure unresolved, the
// release train blocks" — `pnpm db:purge-check`'s underlying assertion.
describe("STORY-013 · db:purge-check — the release-train deploy gate", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await migrateUp(client, MIGRATIONS_DIR);
  }, 180_000);

  afterAll(async () => {
    await client.end();
    await container.stop();
  });

  it("a freshly-migrated database has zero blocking purge failures", async () => {
    await expect(findBlockingPurgeFailures(client)).resolves.toEqual([]);
  });

  it("T14 · a purge failure unresolved past the 7-day grace window blocks the release train", async () => {
    await recordPurgeFailure(client, { scope: "project", scopeId: "11111111-1111-1111-1111-111111111111", reason: "s3 timeout" });
    await client.query(
      `UPDATE purge_failures SET failed_at = now() - interval '${PURGE_FAILURE_GRACE_DAYS + 1} days'
        WHERE scope_id = '11111111-1111-1111-1111-111111111111'`,
    );

    const blocking = await findBlockingPurgeFailures(client);
    expect(blocking.some((f) => f.scopeId === "11111111-1111-1111-1111-111111111111")).toBe(true);
  });

  it("a purge failure still within the 7-day grace window does NOT block yet", async () => {
    await recordPurgeFailure(client, { scope: "project", scopeId: "22222222-2222-2222-2222-222222222222", reason: "s3 timeout" });

    const blocking = await findBlockingPurgeFailures(client);
    expect(blocking.some((f) => f.scopeId === "22222222-2222-2222-2222-222222222222")).toBe(false);
  });

  it("resolving a purge failure removes it from the blocking set — never a silent retry-clears-it path", async () => {
    await recordPurgeFailure(client, { scope: "workspace", scopeId: "33333333-3333-3333-3333-333333333333", reason: "export failed" });
    await client.query(
      `UPDATE purge_failures SET failed_at = now() - interval '${PURGE_FAILURE_GRACE_DAYS + 1} days'
        WHERE scope_id = '33333333-3333-3333-3333-333333333333'`,
    );
    const before = await findBlockingPurgeFailures(client);
    const failure = before.find((f) => f.scopeId === "33333333-3333-3333-3333-333333333333");
    expect(failure).toBeDefined();

    await resolvePurgeFailure(client, failure!.id, "00000000-0000-0000-0000-000000000000");

    const after = await findBlockingPurgeFailures(client);
    expect(after.some((f) => f.scopeId === "33333333-3333-3333-3333-333333333333")).toBe(false);

    const row = await client.query<{ resolved_at: Date | null }>("SELECT resolved_at FROM purge_failures WHERE id = $1", [failure!.id]);
    expect(row.rows[0]!.resolved_at).not.toBeNull();
  });
});
