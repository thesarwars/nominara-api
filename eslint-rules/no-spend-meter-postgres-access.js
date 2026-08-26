// STORY-031 D12 — "per-engine spend is metered via Valkey counters fed by a
// `recordCost` seam, never by a cross-tenant SQL sum over `usage_ledger`."
// test/unit/engines/spend-meter.spec.ts's original guard read spend-meter.ts
// as text and regexed for 'pg'/'db/pg-pool'/'usage_ledger' — defeatable by a
// dynamic `import("p" + "g")`, or by simply not matching the regex's exact
// phrasing. This rule inspects the AST nodes that actually carry a
// data-source dependency (import declarations, dynamic import(), require())
// and any literal whose value names the forbidden table, rather than
// scanning the file as prose. It also flags any dynamic import()/require()
// argument built from a BinaryExpression (e.g. `import("p" + "g")`)
// outright, without resolving its value — spend-meter.ts legitimately never
// needs a computed import source, so any binary-expression-built one is
// suspicious in this one file regardless of what it evaluates to.
//
// qa-reviewer finding (STORY-031 fix round) — this does NOT resolve every
// possible obfuscation: a source built via a helper function call, string
// methods (e.g. String.fromCharCode), or a variable assigned elsewhere and
// referenced by identifier all still pass. That class of deliberately
// obfuscated dynamic construction is out of this rule's threat model; it
// catches static literals, re-exports from the banned path, and the
// simplest binary-expression concatenation, not a general taint analysis.
// Scoped (in eslint.config.js's `files`) to exactly spend-meter.ts — this is
// D12's guarantee, not a general Postgres-import ban.

const BANNED_PG_IMPORT_SOURCE = /^pg$/;
const BANNED_PG_POOL_PATH = /db\/pg-pool(\.js)?$/;
const BANNED_LITERAL_SUBSTRING = /usage_ledger/;

function isBannedSource(value) {
  return typeof value === "string" && (BANNED_PG_IMPORT_SOURCE.test(value) || BANNED_PG_POOL_PATH.test(value));
}

function reportIfBannedSource(context, node, value) {
  if (isBannedSource(value)) {
    context.report({ node, messageId: "bannedDataSource", data: { source: value } });
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const noSpendMeterPostgresAccess = {
  meta: {
    type: "problem",
    docs: {
      description:
        "D12: spend-meter.ts may never import Postgres/the pg pool, or reference usage_ledger — spend is metered via Valkey only, never a cross-tenant SQL sum over the workspace-scoped, RLS-forced credit ledger.",
    },
    schema: [],
    messages: {
      bannedDataSource:
        "'{{source}}' is a Postgres data-source import — spend-meter.ts must never take a Postgres dependency (STORY-031 D12). Spend is metered via Valkey counters only.",
      bannedLiteral:
        "A string/template literal here names 'usage_ledger' — spend-meter.ts must never reference the workspace-scoped, RLS-forced credit ledger table (STORY-031 D12).",
      suspiciousDynamicSource:
        "A computed (BinaryExpression-built) import()/require() source in spend-meter.ts is suspicious — this file legitimately never needs a computed import source (STORY-031 D12). Use a static literal import instead.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        reportIfBannedSource(context, node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") {
          reportIfBannedSource(context, node, node.source.value);
        } else if (node.source.type === "BinaryExpression") {
          context.report({ node, messageId: "suspiciousDynamicSource" });
        }
      },
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require" && node.arguments.length > 0) {
          const arg = node.arguments[0];
          if (arg.type === "Literal") {
            reportIfBannedSource(context, node, arg.value);
          } else if (arg.type === "BinaryExpression") {
            context.report({ node, messageId: "suspiciousDynamicSource" });
          }
        }
      },
      Literal(node) {
        if (typeof node.value === "string" && BANNED_LITERAL_SUBSTRING.test(node.value)) {
          context.report({ node, messageId: "bannedLiteral" });
        }
      },
      TemplateElement(node) {
        const raw = node.value && node.value.raw;
        if (typeof raw === "string" && BANNED_LITERAL_SUBSTRING.test(raw)) {
          context.report({ node, messageId: "bannedLiteral" });
        }
      },
    };
  },
};

export default noSpendMeterPostgresAccess;
