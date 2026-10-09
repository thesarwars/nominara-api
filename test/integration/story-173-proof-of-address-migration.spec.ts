import { readFile } from "node:fs/promises";
import path from "node:path";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, migrateUp, rollbackLast } from "../../src/db/migrate-runner.js";

// STORY-173 · migrations 0030 and 0031 — two CHECKs on sessions widened, additively:
// last_strong_auth_method gains 'email_otp' and revoked_reason gains
// 'address_proved'. up -> accepted (and a bogus value still refused) ->
// rollbackLast with rows that carry the new values -> rows normalised, old
// CHECKs back -> reapply.
describe("STORY-173 · migrations 0030 / 0031 — sessions strong-auth method and revocation reason, credential revoke reason", () => {
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

  it("STORY-173 · 0031 — every CHECK 0030 added NOT VALID is validated, in a file of its own", async () => {
    const result = await client.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conname IN ('sessions_last_strong_auth_method_check', 'sessions_revoked_reason_check', 'user_credentials_revoked_reason_check')
       ORDER BY conname`,
    );
    expect(result.rows).toHaveLength(3);
    expect(result.rows.every((row) => row.convalidated)).toBe(true);

    // 0030 must not VALIDATE: the runner wraps a file in ONE transaction, so a
    // VALIDATE there would scan `sessions` while the same file's DROP / ADD
    // CONSTRAINT still held ACCESS EXCLUSIVE.
    const sql = await readFile(path.join(MIGRATIONS_DIR, "0030_story_173_proof_of_address.up.sql"), "utf8");
    expect(sql.split("\n").filter((line) => !line.startsWith("--") && /VALIDATE\s+CONSTRAINT/i.test(line))).toEqual([]);
    const validate = await readFile(path.join(MIGRATIONS_DIR, "0031_story_173_validate_constraints.up.sql"), "utf8");
    expect(validate.split("\n").filter((line) => !line.startsWith("--") && /VALIDATE\s+CONSTRAINT/i.test(line))).toHaveLength(3);
  });

  it("STORY-173 · rolls back with rows carrying the new values, normalising them and DELETING the first-proof credentials, then reapplies", async () => {
    const userId = await newUser();
    const otp = await client.query<{ id: string }>(
      "INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'email_otp') RETURNING id",
      [userId],
    );
    const proved = await client.query<{ id: string }>(
      "INSERT INTO sessions (user_id, revoked_at, revoked_reason) VALUES ($1, now(), 'address_proved') RETURNING id",
      [userId],
    );
    await client.query(
      `INSERT INTO user_credentials (user_id, kind, provider, external_subject, revoked_at, revoked_reason)
       VALUES ($1, 'oauth', 'google', 'planted', now(), 'address_proved')`,
      [userId],
    );
    await client.query(
      `INSERT INTO user_credentials (user_id, kind, provider, external_subject, revoked_at, revoked_reason)
       VALUES ($1, 'oauth', 'github', 'unlinked', now(), 'user')`,
      [userId],
    );

    // Roll back UNTIL 0031 rather than assuming it is the newest migration:
    // later stories add migrations on top of it, and a test coupled to "my
    // migration is last" breaks for the next person to add one.
    const newer: string[] = [];
    for (let step = 0; step < 200; step += 1) {
      const name = await rollbackLast(client);
      if (name === null || name === "0031_story_173_validate_constraints") {
        expect(name).toBe("0031_story_173_validate_constraints");
        break;
      }
      newer.push(name);
    }
    expect(await rollbackLast(client)).toBe("0030_story_173_proof_of_address");

    const otpRow = await client.query("SELECT last_strong_auth_at, last_strong_auth_method FROM sessions WHERE id = $1", [otp.rows[0]!.id]);
    expect(otpRow.rows[0]).toEqual({ last_strong_auth_at: null, last_strong_auth_method: null });
    const provedRow = await client.query("SELECT revoked_at, revoked_reason FROM sessions WHERE id = $1", [proved.rows[0]!.id]);
    expect(provedRow.rows[0].revoked_at).not.toBeNull();
    expect(provedRow.rows[0].revoked_reason).toBe("logout");
    // Code from before this story would REACTIVATE a revoked OAuth credential on
    // sign-in; the planted one must not survive the roll-back to be reactivated.
    const left = await client.query("SELECT external_subject FROM user_credentials WHERE user_id = $1 ORDER BY external_subject", [userId]);
    expect(left.rows).toEqual([{ external_subject: "unlinked" }]);
    // The narrower CHECKs are back.
    await expect(
      client.query("INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'email_otp')", [userId]),
    ).rejects.toThrow(/sessions_last_strong_auth_method_check/);

    expect(await migrateUp(client)).toEqual(["0030_story_173_proof_of_address", "0031_story_173_validate_constraints", ...[...newer].reverse()]);
    await client.query(
      "INSERT INTO sessions (user_id, last_strong_auth_at, last_strong_auth_method) VALUES ($1, now(), 'email_otp')",
      [userId],
    );
  });
});
