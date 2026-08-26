import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";
import { describe, it } from "vitest";
// @ts-expect-error — plain JS rule module, no type declarations.
import noSpendMeterPostgresAccess from "../../eslint-rules/no-spend-meter-postgres-access.js";

// STORY-031 code-review finding 2 — D12's guard test in spend-meter.spec.ts
// reads the source as text and regexes for pg/db-pg-pool/usage_ledger,
// which a dynamic `import("p" + "g")` or a string-concatenated table name
// defeats. This is the AST-level replacement: it inspects import
// declarations, dynamic import()/require() calls, and literal/template
// nodes directly, not the file's text.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

describe("STORY-031 D12 · eslint-rules/no-spend-meter-postgres-access", () => {
  ruleTester.run("no-spend-meter-postgres-access", noSpendMeterPostgresAccess, {
    valid: [
      { name: "importing ioredis is permitted", code: `import type { Redis } from "ioredis";` },
      { name: "an unrelated relative import is permitted", code: `import { EngineKey } from "./contract.js";` },
      { name: "an unrelated literal is permitted", code: `const key = "engine-spend:total";` },
      { name: "an unrelated string concatenation outside import/require is permitted", code: `const key = "engine-spend" + ":total";` },
    ],
    invalid: [
      {
        name: "a static import from 'pg' is banned",
        code: `import { Pool } from "pg";`,
        errors: [{ messageId: "bannedDataSource" }],
      },
      {
        name: "a relative import of the pg pool module is banned",
        code: `import { PG_POOL } from "../../db/pg-pool.js";`,
        errors: [{ messageId: "bannedDataSource" }],
      },
      {
        name: "a dynamic import('pg') is banned",
        code: `const pg = await import("pg");`,
        errors: [{ messageId: "bannedDataSource" }],
      },
      {
        name: "a require('pg') is banned",
        code: `const pg = require("pg");`,
        errors: [{ messageId: "bannedDataSource" }],
      },
      {
        name: "a string literal naming usage_ledger is banned",
        code: `const table = "usage_ledger";`,
        errors: [{ messageId: "bannedLiteral" }],
      },
      {
        // qa-reviewer finding — the header comment claimed this defeated
        // the original regex-based guard and was caught by this AST rule,
        // but the rule never actually inspected a BinaryExpression source.
        name: "a dynamic import('p' + 'g') built from a BinaryExpression is flagged as suspicious, without resolving its value",
        code: `const pg = await import("p" + "g");`,
        errors: [{ messageId: "suspiciousDynamicSource" }],
      },
      {
        name: "a require('p' + 'g') built from a BinaryExpression is flagged as suspicious",
        code: `const pg = require("p" + "g");`,
        errors: [{ messageId: "suspiciousDynamicSource" }],
      },
      {
        name: "a template literal naming usage_ledger is banned",
        code: "const query = `SELECT * FROM usage_ledger WHERE engine = ${engineKey}`;",
        errors: [{ messageId: "bannedLiteral" }],
      },
    ],
  });
});
