import { randomUUID } from "node:crypto";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolvePassword } from "../../src/db/dev-credentials.js";
import { migrateUp } from "../../src/db/migrate-runner.js";
import { hashEmailKey, normalizeEmail } from "../../src/lib/auth/email-otp.js";
import { PgSuppressionStore } from "../../src/lib/email/suppression-store.js";
import { liftSuppression } from "../../src/lib/email/unsuppress-email.js";

// STORY-178 / owner decision 9 — un-suppression is OPERATOR-ONLY for D1: a command run on the owner connection, and no runtime
// role can do it. The row stays (deleted_at), so a replay of the event that created it cannot bring the suppression back.

const PEPPER = "unsuppress-test-pepper-000000000000";
const ADDRESS = "Fixed.Address@Example.org";
const hashOf = (address: string): Buffer => hashEmailKey(normalizeEmail(address), PEPPER);

describe("STORY-178 · operator un-suppression", () => {
  let container: StartedPostgreSqlContainer;
  let owner: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18").withDatabase("nominara_test").withUsername("nominara").withPassword("nominara").start();
    owner = new Client({ connectionString: container.getConnectionUri() });
    await owner.connect();
    await migrateUp(owner);
    for (const role of ["nominara_app", "nominara_worker"]) await owner.query(`ALTER ROLE ${role} PASSWORD ${owner.escapeLiteral(resolvePassword(role, {}))}`);
  }, 300_000);
  afterAll(async () => {
    await owner.end();
    await container.stop();
  });
  beforeEach(async () => {
    await owner.query("TRUNCATE email_suppressions");
  });

  const suppress = (address: string, kind: "bounce" | "complaint", event = `evt_${randomUUID()}`) =>
    owner.query("INSERT INTO email_suppressions (recipient_hash, kind, provider_event_id) VALUES ($1,$2,$3)", [hashOf(address), kind, event]);
  const active = async (address: string) => await new PgSuppressionStore(owner).activeKinds(hashOf(address));

  it("lifts EVERY active suppression of the address (case and whitespace do not matter), and nothing else", async () => {
    await suppress(ADDRESS, "bounce");
    await suppress(ADDRESS, "complaint");
    await suppress("other@example.org", "bounce");
    expect(await liftSuppression(owner, "  fixed.ADDRESS@example.org ", PEPPER)).toBe(2);
    expect(await active(ADDRESS)).toEqual([]);
    expect(await active("other@example.org")).toEqual(["bounce"]);
  });

  it("keeps the rows: they are marked lifted, not deleted, so a replay of the original event is still a conflict", async () => {
    await suppress(ADDRESS, "bounce", "evt_original");
    await liftSuppression(owner, ADDRESS, PEPPER);
    const rows = await owner.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM email_suppressions");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.deleted_at).not.toBeNull();
    await expect(suppress(ADDRESS, "bounce", "evt_original")).rejects.toThrow(/unique|duplicate/i);
  });

  it("an address with nothing to lift returns 0 and changes nothing; lifting twice is safe", async () => {
    expect(await liftSuppression(owner, "never.suppressed@example.org", PEPPER)).toBe(0);
    await suppress(ADDRESS, "bounce");
    expect(await liftSuppression(owner, ADDRESS, PEPPER)).toBe(1);
    expect(await liftSuppression(owner, ADDRESS, PEPPER)).toBe(0);
  });

  it("a NEW bounce after the lift suppresses the address again", async () => {
    await suppress(ADDRESS, "bounce");
    await liftSuppression(owner, ADDRESS, PEPPER);
    await suppress(ADDRESS, "bounce");
    expect(await active(ADDRESS)).toEqual(["bounce"]);
  });

  it("refuses an empty address and a missing pepper, touching nothing", async () => {
    await suppress(ADDRESS, "bounce");
    await expect(liftSuppression(owner, "   ", PEPPER)).rejects.toThrow(/address/i);
    await expect(liftSuppression(owner, ADDRESS, "")).rejects.toThrow(/pepper/i);
    expect(await active(ADDRESS)).toEqual(["bounce"]);
  });

  it("is OPERATOR-ONLY: neither the API role nor a worker role can lift (or delete) a suppression", async () => {
    await suppress(ADDRESS, "bounce");
    for (const role of ["nominara_app", "nominara_worker"]) {
      const client = new Client({ host: container.getHost(), port: container.getMappedPort(5432), database: container.getDatabase(), user: role, password: resolvePassword(role, {}) });
      await client.connect();
      try {
        await expect(client.query("UPDATE email_suppressions SET deleted_at = now()"), role).rejects.toThrow(/permission denied/i);
        await expect(client.query("DELETE FROM email_suppressions"), role).rejects.toThrow(/permission denied/i);
      } finally {
        await client.end();
      }
    }
    expect(await active(ADDRESS)).toEqual(["bounce"]);
  });
});
