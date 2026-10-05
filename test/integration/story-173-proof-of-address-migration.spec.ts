import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-173 · migration 0030 — two CHECKs on sessions widened, additively:
// last_strong_auth_method gains 'email_otp' and revoked_reason gains
// 'address_proved'. up -> accepted (and a bogus value still refused) ->
// rollbackLast with rows that carry the new values -> rows normalised, old
// CHECKs back -> reapply.
describe("STORY-173 · migration 0030 — sessions strong-auth method and revocation reason", () => {
  let container: StartedPostgreSqlContainer;
  let client: Client;

  beforeAll(async () => {
    container = await new PostgreSqlContainer("pgvector/pgvector:pg18")
      .withDatabase("nominara_test")
      .withUsername("nominara")
      .withPassword("nominara")
      .start();
  }, 180_000);

  afterAll(async () => {
    await container.stop();
  });

  beforeEach(async () => {
    client = new Client({ connectionString: container.getConnectionUri() });
    await client.connect();
    await client.query("DROP SCHEMA IF EXISTS app CASCADE");
    await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");
    await migrateUp(client);
  });

  afterEach(async () => {
    await client.end();
  });

  async function newUser(): Promise<string> {
    const result = await client.query<{ id: string }>(
      "INSERT INTO users (email, status, email_verified_at) VALUES ($1, 'active', now()) RETURNING id",
      [`m-${Math.random().toString(36).slice(2)}@example.com`],
    );
    return result.rows[0]!.id;
  }

  it("STORY-173 · accepts email_otp and address_proved, still refuses anything else", async () => {
    const userId = await newUser();
    await client.query(
      "INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'email_otp')",
      [userId],
    );
    await client.query(
      "INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'webauthn')",
      [userId],
    );
    await client.query(
      "INSERT INTO sessions (user_id, revoked_at, revoked_reason) VALUES ($1, now(), 'address_proved')",
      [userId],
    );
    await expect(
      client.query("INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'sms')", [userId]),
    ).rejects.toThrow(/sessions_last_strong_auth_method_check/);
    await expect(
      client.query("INSERT INTO sessions (user_id, revoked_at, revoked_reason) VALUES ($1, now(), 'because')", [userId]),
    ).rejects.toThrow(/sessions_revoked_reason_check/);
  });

  it("STORY-173 · rolls back with rows carrying the new values, normalising them, then reapplies", async () => {
    const userId = await newUser();
    const otp = await client.query<{ id: string }>(
      "INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'email_otp') RETURNING id",
      [userId],
    );
    const proved = await client.query<{ id: string }>(
      "INSERT INTO sessions (user_id, revoked_at, revoked_reason) VALUES ($1, now(), 'address_proved') RETURNING id",
      [userId],
    );

    expect(await rollbackLast(client)).toBe("0030_story_173_proof_of_address");

    const otpRow = await client.query("SELECT last_strong_auth_at, last_strong_auth_method FROM sessions WHERE id = $1", [otp.rows[0]!.id]);
    expect(otpRow.rows[0]).toEqual({ last_strong_auth_at: null, last_strong_auth_method: null });
    const provedRow = await client.query("SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1", [proved.rows[0]!.id]);
    expect(provedRow.rows[0].revoked_at).not.toBeNull();
    expect(provedRow.rows[0].revoked_reason).toBe("logout");
    // The narrower CHECKs are back.
    await expect(
      client.query("INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'email_otp')", [userId]),
    ).rejects.toThrow(/sessions_last_strong_auth_method_check/);

    expect(await migrateUp(client)).toEqual(["0030_story_173_proof_of_address"]);
    await client.query(
      "INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'email_otp')",
      [userId],
    );
  });
});
