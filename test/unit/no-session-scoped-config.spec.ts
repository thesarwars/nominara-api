import { RuleTester } from "eslint";
import { describe, it } from "vitest";
// @ts-expect-error — plain JS rule module, no type declarations.
import noSessionScopedConfig from "../../eslint-rules/no-session-scoped-config.js";

// STORY-011 · AC 30 / Test Scenario 8. Uses ESLint's own RuleTester (no new
// dependency) to exercise eslint-rules/no-session-scoped-config.js directly,
// against small representative code snippets rather than the real
// codebase — the real codebase's own compliance is what `pnpm lint`
// (already run as a gate) checks.
//
// Fix pass (second pass) — the previous version of this file called
// `ruleTester.run(...)` from inside a single vitest `it()`, so every valid
// and invalid case ran as ONE synchronous block: any single case failing
// reported as "1 test failed" with no indication of which case, and (worse)
// a thrown assertion from an early case could prevent later cases in the
// same `run()` call from ever executing at all. RuleTester.describe/
// RuleTester.it are ESLint's own documented integration point for exactly
// this problem: wiring them to vitest's real describe/it makes
// `ruleTester.run(...)` register ONE real vitest `it()` per test case
// (nested under real `describe("valid")`/`describe("invalid")` blocks), so
// every case is independently reported, independently attributable, and one
// case failing can never suppress another from running.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("STORY-011 · eslint-rules/no-session-scoped-config", () => {
  ruleTester.run("no-session-scoped-config", noSessionScopedConfig, {
    valid: [
      // set_config(..., true) — the only permitted form.
      {
        name: "set_config(..., true) via .query() with a string literal is permitted",
        code: `client.query("SELECT set_config('app.current_workspace_id', $1, true)");`,
      },
      {
        name: "set_config(..., true) via .query() with a template literal is permitted",
        code: "client.query(`SELECT set_config($1, $2, true)`);",
      },
      // SET LOCAL is explicitly permitted.
      {
        name: "SET LOCAL is permitted",
        code: `client.query("SET LOCAL statement_timeout = '5s'");`,
      },
      // SET ROLE / RESET ROLE are explicitly permitted (used elsewhere in this repo).
      {
        name: "SET ROLE is permitted",
        code: "client.query(`SET ROLE nominara_owner`);",
      },
      {
        name: "RESET ROLE is permitted",
        code: `client.query("RESET ROLE");`,
      },
      // UPDATE ... SET ... is DML, not a config statement — SET here is
      // never the first token of the statement.
      {
        name: "UPDATE ... SET ... (string literal) is DML, not a config statement",
        code: `client.query("UPDATE competitors SET workspace_id = $1 WHERE id = $2");`,
      },
      {
        name: "UPDATE ... SET ... (template literal) is DML, not a config statement",
        code: "client.query(`UPDATE projects SET name = $1, status = $2 WHERE id = $3`);",
      },
      // A string that merely mentions "set_config" in prose (a comment,
      // not a call) doesn't parse as a call at all — no open paren
      // immediately following, so scanBalancedArgs never engages.
      {
        name: "prose mentioning set_config with no call syntax is not flagged",
        code: `const note = "see set_config for details";`,
      },
      // An unrelated string literal.
      {
        name: "an unrelated string literal is not flagged",
        code: `const x = "hello world";`,
      },
      // A test title / prose string that merely NAMES the banned pattern
      // is not itself a query argument — must never be flagged. Without
      // this scoping, this rule would flag its own meta.docs/messages
      // strings and every test title mentioning set_config or SET.
      {
        name: "a test title naming the banned pattern is not a query argument",
        code: `it("set_config(..., true) reverts on COMMIT and SET x = 1 is banned", () => {});`,
      },
      // A string argument to an unrelated method also named .query on
      // some other kind of object is intentionally still treated as a
      // query call by this heuristic (it has no type information to know
      // otherwise) — but a DIFFERENT method name entirely must not match.
      {
        name: "a .info() call is a different method name entirely and is not matched",
        code: `logger.info("SET enable_seqscan = off");`,
      },
      // Fix pass item 10 — the object-argument form, with true.
      {
        name: "the object-argument { text } form with true is permitted",
        code: `client.query({ text: "SELECT set_config('app.x', $1, true)" });`,
      },
      // Fix pass item 10 — .execute() with the object-argument form.
      {
        name: ".execute() with the object-argument { text } form and true is permitted",
        code: `tx.execute({ text: "SELECT set_config('app.x', $1, true)" });`,
      },
      // Fix pass item 10 — the sql tagged-template form, correctly used.
      {
        name: "the sql-tagged-template form with true is permitted",
        code: "tx.execute(sql`SELECT set_config('app.x', ${x}, true)`);",
      },
      // Fix pass (second pass) — sql.raw(...) and sql.fromList([...]) with true.
      {
        name: "sql.raw(...) with true is permitted",
        code: `tx.execute(sql.raw("SELECT set_config('app.x', $1, true)"));`,
      },
      {
        name: "sql.raw(...) with SET LOCAL is permitted",
        code: "tx.execute(sql.raw(`SET LOCAL statement_timeout = '5s'`));",
      },
      {
        name: "sql.fromList([...]) with a permissive set_config element is permitted",
        code: `tx.execute(sql.fromList(["SELECT set_config('app.x', $1, true)", sql\`AND 1 = 1\`]));`,
      },
      // The disable-comment escape hatch works for a genuinely intentional case.
      {
        name: "an eslint-disable-next-line comment is a genuine, documented escape hatch",
        // The real repo registers this rule as "nominara/no-session-scoped-config"
        // (see eslint.config.js's local plugin); RuleTester internally
        // registers the rule under its own "rule-to-test/" namespace, so
        // the disable comment here uses THAT name — same escape-hatch
        // mechanism, same "-- explanation required" shape, just RuleTester's
        // own internal plugin id instead of the real repo's.
        code: [
          "client.query(",
          "  // eslint-disable-next-line rule-to-test/no-session-scoped-config -- deliberate negative control, proves the leak",
          `  "SELECT set_config('app.leak_test_marker', $1, false)"`,
          ");",
        ].join("\n"),
      },
    ],
    invalid: [
      {
        name: "set_config(..., false) via .query() with a string literal is banned",
        code: `client.query("SELECT set_config('app.current_workspace_id', $1, false)");`,
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: "set_config(..., false) via .query() with a template literal is banned",
        code: "client.query(`SELECT set_config('app.x', $1, false)`);",
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: "set_config with only 2 arguments is banned",
        code: `client.query("SELECT set_config('app.current_workspace_id', $1)");`,
        errors: [{ messageId: "setConfigTooFewArgs" }],
      },
      {
        name: "set_config with only 1 argument is banned",
        code: `client.query("SELECT set_config('app.current_workspace_id')");`,
        errors: [{ messageId: "setConfigTooFewArgs" }],
      },
      {
        name: "a bare SET statement is banned",
        code: `client.query("SET statement_timeout = '5s'");`,
        errors: [{ messageId: "bareSessionSet" }],
      },
      {
        name: "a bare SET SESSION statement is banned",
        code: "client.query(`SET SESSION statement_timeout = '5s'`);",
        errors: [{ messageId: "bareSessionSet" }],
      },
      {
        name: "a bare SET TIME ZONE statement is banned",
        code: `client.query("SET TIME ZONE 'UTC'");`,
        errors: [{ messageId: "bareSessionSet" }],
      },
      {
        name: "a bare SET <config param> statement is banned",
        code: `client.query("SET enable_seqscan = off");`,
        errors: [{ messageId: "bareSessionSet" }],
      },
      // Multi-statement string: BEGIN is fine, the bare SET inside it is not.
      {
        name: "a bare SET inside a multi-statement string (after BEGIN) is banned",
        code: `client.query("BEGIN; SET enable_seqscan = off;");`,
        errors: [{ messageId: "bareSessionSet" }],
      },
      // ---- fix pass item 10 — the three previously-uncaught shapes ----
      // (a) the object-argument form (query-guard.ts's own object handling
      // assumes this shape is in real use).
      {
        name: "the object-argument { text } form with false is banned",
        code: `client.query({ text: "SELECT set_config('app.current_workspace_id', $1, false)" });`,
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: "the object-argument { text } form with too few args is banned",
        code: `client.query({ text: "SELECT set_config('app.current_workspace_id', $1)" });`,
        errors: [{ messageId: "setConfigTooFewArgs" }],
      },
      // (b) .execute() — not just .query().
      {
        name: ".execute() with false is banned",
        code: `tx.execute("SELECT set_config('app.x', $1, false)");`,
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: ".execute() with the object-argument { text } form and false is banned",
        code: `tx.execute({ text: "SELECT set_config('app.x', $1, false)" });`,
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: ".execute() with a bare SET statement is banned",
        code: `tx.execute("SET enable_seqscan = off");`,
        errors: [{ messageId: "bareSessionSet" }],
      },
      // (c) the sql tagged-template form — security-and-tenancy.md §4's
      // own canonical TenantContextInterceptor sample shape.
      {
        name: "the sql-tagged-template form with false is banned",
        code: "tx.execute(sql`SELECT set_config('app.x', ${x}, false)`);",
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: "the sql-tagged-template form with a bare SET statement is banned",
        code: "tx.execute(sql`SET enable_seqscan = off`);",
        errors: [{ messageId: "bareSessionSet" }],
      },
      // ---- fix pass (second pass) — sql.raw(...) / sql.fromList([...]) ----
      {
        name: "sql.raw(...) with false is banned",
        code: `tx.execute(sql.raw("SELECT set_config('app.x', $1, false)"));`,
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: "sql.raw(...) with a template literal and too few args is banned",
        code: "tx.execute(sql.raw(`SELECT set_config('app.x')`));",
        errors: [{ messageId: "setConfigTooFewArgs" }],
      },
      {
        name: "sql.raw(...) with a bare SET statement is banned",
        code: `tx.execute(sql.raw("SET enable_seqscan = off"));`,
        errors: [{ messageId: "bareSessionSet" }],
      },
      {
        name: "sql.fromList([...]) with a false-scoped set_config element is banned",
        code: `tx.execute(sql.fromList(["SELECT set_config('app.x', $1, false)", sql\`AND 1 = 1\`]));`,
        errors: [{ messageId: "setConfigFalse" }],
      },
      {
        name: "sql.fromList([...]) with a bare SET statement element is banned",
        code: `tx.execute(sql.fromList(["SET enable_seqscan = off"]));`,
        errors: [{ messageId: "bareSessionSet" }],
      },
    ],
  });
});
