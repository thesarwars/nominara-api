import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSubjectArgs } from "../../src/db/subject-cli.js";

// STORY-111 / decision 68 (a) - the operator CLI's argument handling. The database behaviour is in compliance-retention.spec.ts.
describe("STORY-111 subject CLI arguments", () => {
  const u = randomUUID();
  const op = randomUUID();

  it("parses an export and an erase", () => {
    expect(parseSubjectArgs(["export", "--user", u, "--requested-by", op, "--out", "/tmp/x.json"])).toEqual({ ok: true, args: { command: "export", user: u, requestedBy: op, out: "/tmp/x.json" } });
    expect(parseSubjectArgs(["erase", "--user", u, "--requested-by", op, "--confirm", u, "--request-id", u])).toMatchObject({ ok: true, args: { command: "erase", confirm: u, requestId: u } });
  });

  it("rejects an unknown command, an unknown flag, a missing required flag and a non-UUID id, naming the problem without echoing the value", () => {
    for (const argv of [["wipe"], ["export", "--user", u, "--requested-by", op, "--out", "/x", "--bogus", "1"], ["export", "--user", u, "--out", "/x"], ["export", "--user", u, "--requested-by", op], ["erase", "--user", "alice@example.com", "--requested-by", op]]) {
      const r = parseSubjectArgs(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).not.toContain("alice@example.com");
    }
  });
});
