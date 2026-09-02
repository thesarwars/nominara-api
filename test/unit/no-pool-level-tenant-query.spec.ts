import { RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain JS rule module, no type declarations.
import noPoolLevelTenantQuery, { loadTenantTables } from "../../eslint-rules/no-pool-level-tenant-query.js";
import { TENANT_TABLES } from "../../src/db/rls/tenant-tables.generated.js";

// STORY-118 · eslint-rules/no-pool-level-tenant-query.js. Same shape as
// test/unit/no-session-scoped-config.spec.ts: ESLint's own RuleTester
// against representative snippets, with the real codebase's compliance
// checked by `pnpm lint` itself.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: "module" },
});

describe("STORY-118 · the rule reads the generated tenant-table set, not a copy of it", () => {
  // The rule parses tenant-tables.generated.ts as text, because it is plain
  // JS and the set is TypeScript. This is what stops that parse drifting
  // from the set the runtime guard actually uses — a migration that adds a
  // tenant table fails here if the parse stops seeing it.
  it("parses exactly the set src/tenancy/query-guard.ts is given", () => {
    expect(loadTenantTables()).toEqual(new Set(TENANT_TABLES));
  });
});

describe("STORY-118 · eslint-rules/no-pool-level-tenant-query", () => {
  ruleTester.run("no-pool-level-tenant-query", noPoolLevelTenantQuery, {
    valid: [
      {
        name: "a global table on the pool is fine — the guard never touches it",
        code: `await this.pool.query("UPDATE engines SET status = 'degraded' WHERE key = $1", [key]);`,
      },
      {
        name: "a tenant table on a CHECKED-OUT client is the correct shape, and only the runtime guard can judge its context",
        code: `await client.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);`,
      },
      {
        name: "a tenant table on a transaction handle is the same correct shape",
        code: `await tx.query("SELECT 1 FROM projects WHERE id = $1", [projectId]);`,
      },
      {
        name: "SQL this rule cannot read is left to the runtime guard rather than guessed at",
        code: `await pool.query(buildStatement(table), values);`,
      },
      {
        name: "prose naming a tenant table is not a query",
        code: `const message = "SELECT 1 FROM projects";`,
      },
    ],
    invalid: [
      {
        name: "the shipped defect this rule was written from — a socket handshake checking a project on the pool",
        code: `const result = await this.pool.query("SELECT 1 FROM projects WHERE id = $1 AND workspace_id = $2", [projectId, workspaceId]);`,
        errors: [{ messageId: "poolLevelTenantQuery" }],
      },
      {
        name: "a template literal is read the same way as a string literal",
        code: "await pool.query(`SELECT * FROM answer_captures WHERE run_id = ${runId}`);",
        errors: [{ messageId: "poolLevelTenantQuery" }],
      },
      {
        name: "the object form of query() is read through its text property",
        code: `await pool.query({ text: "DELETE FROM share_tokens WHERE id = $1", values: [id] });`,
        errors: [{ messageId: "poolLevelTenantQuery" }],
      },
      {
        name: "execute() is a query method too — a Drizzle session's own name for it",
        code: `await dbPool.execute("INSERT INTO competitors (id) VALUES ($1)");`,
        errors: [{ messageId: "poolLevelTenantQuery" }],
      },
      {
        name: "a join that reaches a tenant table through a global one is still a tenant query",
        code: `await this.pool.query("SELECT e.key FROM engines e JOIN projects p ON p.id = $1");`,
        errors: [{ messageId: "poolLevelTenantQuery" }],
      },
    ],
  });
});
