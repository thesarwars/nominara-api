import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// STORY-118 — security-and-tenancy.md §4's NFR-SEC-01, at the point the code
// is written rather than the point it runs.
//
// src/tenancy/query-guard.ts refuses a pool-level tenant-table query at
// runtime, and that refusal is the enforcement. This rule is the other half
// of the story's "a pool-level query against a tenant table CANNOT BE
// WRITTEN": a runtime throw on a path nothing exercises is a defect waiting
// for the request that finds it, and `pool.query(...)` is reached from
// places — a socket handshake, a health probe — that no test necessarily
// covers. `pnpm lint` is a gate, so this fails the build instead.
//
// Same category of heuristic as no-session-scoped-config.js and
// query-guard.ts itself: a lexical scan of SQL text embedded in source, not
// a SQL parser, and not the security boundary. RLS is.

const TENANT_TABLES_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "db",
  "rls",
  "tenant-tables.generated.ts",
);

/**
 * Read from the GENERATED file rather than restated here, so a migration
 * that adds a tenant table extends this rule in the same commit that
 * regenerates the set. A rule with its own copy of the list is a rule that
 * silently stops covering the newest table — which is the one a service is
 * most likely to query wrongly.
 *
 * test/unit/no-pool-level-tenant-query.spec.ts asserts this parse against
 * the real imported TENANT_TABLES, so the two can never diverge quietly.
 */
export function loadTenantTables(source = TENANT_TABLES_SOURCE) {
  const text = readFileSync(source, "utf8");
  const body = text.slice(text.indexOf("new Set"));
  return new Set([...body.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]));
}

const TENANT_TABLES = loadTenantTables();

// Deliberately the same shape as query-guard.ts's TABLE_REF_PATTERN. The
// duplication is real and is the price of the rule being plain JS while the
// guard is TypeScript; the spec pins them to the same answers on shared
// cases so a change to one that is not made to the other is visible.
const TABLE_REF_PATTERN = /\b(?:FROM|JOIN|INTO|UPDATE)\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\."?([a-zA-Z_][a-zA-Z0-9_]*)"?)?/gi;

function referencedTenantTables(sqlText) {
  const names = [];
  for (const match of sqlText.matchAll(TABLE_REF_PATTERN)) {
    const name = match[2] ?? match[1];
    if (TENANT_TABLES.has(name) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

const QUERY_METHOD_NAMES = new Set(["query", "execute"]);

/**
 * "Is the receiver a connection pool?" — answered by name, because that is
 * all the AST offers without type information: `pool.query(...)`,
 * `this.pool.query(...)`, `dbPool.query(...)`.
 *
 * A checked-out client is deliberately NOT matched. `client.query(...)` on a
 * tenant table is the correct shape and the runtime guard is what decides
 * whether its context is present — a lint rule cannot know that and must not
 * guess.
 */
function isPoolReceiver(node) {
  if (node.type === "Identifier") {
    return /pool$/i.test(node.name);
  }
  if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
    return /pool$/i.test(node.property.name);
  }
  return false;
}

function sqlTextOf(argument) {
  if (!argument) {
    return null;
  }
  if (argument.type === "Literal" && typeof argument.value === "string") {
    return argument.value;
  }
  if (argument.type === "TemplateLiteral") {
    // A placeholder per interpolation, never a bare join — an interpolated
    // table name is unreadable to this rule either way, and collapsing the
    // gap could fuse two identifiers into a third that is in the set.
    return argument.quasis.map((quasi) => quasi.value.raw).join(" __EXPR__ ");
  }
  if (argument.type === "ObjectExpression") {
    const textProperty = argument.properties.find(
      (property) =>
        property.type === "Property" &&
        !property.computed &&
        ((property.key.type === "Identifier" && property.key.name === "text") ||
          (property.key.type === "Literal" && property.key.value === "text")),
    );
    return textProperty ? sqlTextOf(textProperty.value) : null;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const noPoolLevelTenantQuery = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Bans a query against an RLS-enforced tenant table issued on a connection pool rather than on a checked-out client. Under transaction-mode pooling the implicit per-query connection cannot carry transaction-local context, so the query is context-free by construction. NFR-SEC-01.",
    },
    schema: [],
    messages: {
      poolLevelTenantQuery:
        "This query touches the tenant table(s) {{tables}} on a connection pool. Under transaction-mode pooling the implicit per-query connection cannot carry transaction-local context, so it runs with no tenant context and RLS answers with zero rows — which reads as an empty result, not as an error (NFR-SEC-01). Check a client out with pool.connect() and wrap the call in withTenantContext/withTenantJob on that client.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          !QUERY_METHOD_NAMES.has(callee.property.name) ||
          !isPoolReceiver(callee.object)
        ) {
          return;
        }

        const sqlText = sqlTextOf(node.arguments[0]);
        if (sqlText === null) {
          return;
        }

        const tables = referencedTenantTables(sqlText);
        if (tables.length > 0) {
          context.report({ node, messageId: "poolLevelTenantQuery", data: { tables: tables.join(", ") } });
        }
      },
    };
  },
};

export default noPoolLevelTenantQuery;
