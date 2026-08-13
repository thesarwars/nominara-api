import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// STORY-010 · pgBouncer runs in transaction mode, and a configuration test
// asserts it (AC line 25). This test parses the CHECKED-IN config file
// directly — the same file docker-compose and the testcontainers fixture
// both use (test/support/pgbouncer-fixture.ts) — so there is exactly one
// place the "pool_mode = transaction" setting can live and be verified.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PGBOUNCER_INI_PATH = path.join(__dirname, "..", "..", "docker", "pgbouncer", "pgbouncer.ini");

describe("STORY-010 · pgbouncer.ini config", () => {
  it("pool_mode = transaction, immediately preceded by a rationale comment mentioning statement-mode isolation risk", async () => {
    const content = await readFile(PGBOUNCER_INI_PATH, "utf8");
    const lines = content.split("\n");

    const settingIndex = lines.findIndex((line) => /^\s*pool_mode\s*=\s*transaction\s*$/.test(line));
    expect(settingIndex, "pool_mode = transaction not found").toBeGreaterThanOrEqual(0);

    // Walk upward from the setting through contiguous comment lines,
    // collecting them, so the rationale can span multiple comment lines.
    let i = settingIndex - 1;
    const commentLines: string[] = [];
    while (i >= 0 && /^\s*;/.test(lines[i]!)) {
      commentLines.unshift(lines[i]!);
      i -= 1;
    }
    const rationale = commentLines.join("\n").toLowerCase();

    expect(rationale.length, "no comment immediately precedes pool_mode = transaction").toBeGreaterThan(0);
    expect(rationale).toMatch(/statement mode/);
    expect(rationale).toMatch(/isolation/);
  });

  it("server_reset_query_always = 0, with its own separate comment (not reusing pool_mode's)", async () => {
    const content = await readFile(PGBOUNCER_INI_PATH, "utf8");
    const lines = content.split("\n");

    const settingIndex = lines.findIndex((line) => /^\s*server_reset_query_always\s*=\s*0\s*$/.test(line));
    expect(settingIndex, "server_reset_query_always = 0 not found").toBeGreaterThanOrEqual(0);

    let i = settingIndex - 1;
    const commentLines: string[] = [];
    while (i >= 0 && /^\s*;/.test(lines[i]!)) {
      commentLines.unshift(lines[i]!);
      i -= 1;
    }
    const rationale = commentLines.join("\n").toLowerCase();

    expect(rationale.length, "no comment immediately precedes server_reset_query_always = 0").toBeGreaterThan(0);
    expect(rationale).toMatch(/discard all/);

    // The two settings must NOT share a single comment block — each is an
    // independent way to defeat the same isolation property, so each gets
    // its own rationale, per the story's design decisions.
    const poolModeIndex = lines.findIndex((line) => /^\s*pool_mode\s*=\s*transaction\s*$/.test(line));
    expect(settingIndex).not.toBe(poolModeIndex);
  });

  it("server_reset_query is kept at its default (DISCARD ALL), with a comment explaining why it isn't emptied out", async () => {
    // Post-review fix #13: this was previously emptied out, which removed a
    // real safety net (a session-mode fallback DISCARD ALL) without being
    // necessary for the negative-control test — the leak mechanism there is
    // server_reset_query_always = 0, not this query's content.
    const content = await readFile(PGBOUNCER_INI_PATH, "utf8");
    const lines = content.split("\n");

    const settingIndex = lines.findIndex((line) => /^\s*server_reset_query\s*=\s*DISCARD ALL\s*$/.test(line));
    expect(settingIndex, "server_reset_query = DISCARD ALL not found").toBeGreaterThanOrEqual(0);

    let i = settingIndex - 1;
    const commentLines: string[] = [];
    while (i >= 0 && /^\s*;/.test(lines[i]!)) {
      commentLines.unshift(lines[i]!);
      i -= 1;
    }
    const rationale = commentLines.join("\n").toLowerCase();
    expect(rationale.length, "no comment immediately precedes server_reset_query = DISCARD ALL").toBeGreaterThan(0);
    expect(rationale).toMatch(/server_reset_query_always/);
  });

  it("auth_type = scram-sha-256 with auth_file pointing at userlist.txt, and admin_users is set", async () => {
    const content = await readFile(PGBOUNCER_INI_PATH, "utf8");
    expect(content).toMatch(/^\s*auth_type\s*=\s*scram-sha-256\s*$/m);
    expect(content).toMatch(/^\s*auth_file\s*=\s*.*userlist\.txt\s*$/m);
    expect(content).toMatch(/^\s*admin_users\s*=\s*\S+/m);
  });

  it("ignore_startup_parameters includes extra_float_digits (node-postgres requirement)", async () => {
    const content = await readFile(PGBOUNCER_INI_PATH, "utf8");
    expect(content).toMatch(/^\s*ignore_startup_parameters\s*=.*extra_float_digits/m);
  });
});
