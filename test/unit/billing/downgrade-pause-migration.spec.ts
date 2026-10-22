import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR } from "../../../src/db/migrate-runner.js";

// STORY-077 review round 2 — migration 0130 adds CHECKs to `projects` and `tracked_prompts`, two hot tenant tables.
// An ADD CONSTRAINT ... CHECK that validates scans every row while holding ACCESS EXCLUSIVE, blocking reads and
// writes for the whole scan. The runner wraps each file in ONE transaction, so a VALIDATE in the same file would still
// scan under the ALTER's ACCESS EXCLUSIVE. So, as 0085/0086 and 0030/0031 do: every CHECK is added NOT VALID in 0130
// (including the column's own CHECK, which an inline `ADD COLUMN ... CONSTRAINT ... CHECK` would validate), and is
// VALIDATEd in a file of its own (SHARE UPDATE EXCLUSIVE only).

const CONSTRAINTS = ["ck_projects_paused_by_downgrade_from", "ck_projects_paused_by_downgrade", "ck_tracked_prompts_paused_by_downgrade"];
const code = (sql: string) => sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");

describe("STORY-077 · migration 0130 adds its CHECKs NOT VALID and validates them in a file of its own", () => {
  it("0130: every CHECK is a separate ADD CONSTRAINT ... NOT VALID, none inline on ADD COLUMN, no VALIDATE", async () => {
    const sql = code(await readFile(path.join(MIGRATIONS_DIR, "0130_downgrade_pause_marker.up.sql"), "utf8"));
    const statements = sql.split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter((s) => s.length > 0);
    const checks = statements.filter((s) => /\bCHECK\b/i.test(s));
    expect(checks.length).toBeGreaterThan(0);
    for (const statement of checks) {
      expect(statement, "a CHECK inline on ADD COLUMN validates at once").not.toMatch(/ADD COLUMN/i);
      expect(statement).toMatch(/NOT VALID$/i);
    }
    const named = CONSTRAINTS.filter((name) => checks.some((s) => s.includes(`ADD CONSTRAINT ${name} `)));
    expect(named).toEqual(CONSTRAINTS);
    expect(sql).not.toMatch(/VALIDATE\s+CONSTRAINT/i);
  });

  it("0131: validates exactly those three, and nothing else", async () => {
    const sql = code(await readFile(path.join(MIGRATIONS_DIR, "0131_downgrade_pause_marker_validate.up.sql"), "utf8"));
    const validated = [...sql.matchAll(/VALIDATE\s+CONSTRAINT\s+(\w+)/gi)].map((m) => m[1]);
    expect(validated.sort()).toEqual([...CONSTRAINTS].sort());
  });
});
