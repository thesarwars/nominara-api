// STORY-011 — security-and-tenancy.md §4's NFR-SEC-02: "Session-scoped SET
// is banned in application code by lint. Only set_config(..., true) is
// permitted." pgBouncer runs in transaction-pooling mode (STORY-010), so a
// session-scoped setting leaks to the NEXT tenant that borrows the pooled
// server connection — this rule exists to make that mistake a lint failure
// instead of a data leak discovered in production.
//
// Scans string and template literals for THREE shapes, all evaluated on the
// literal's raw text (this is a lexical scan of SQL text embedded in JS/TS
// source, not a real SQL parser — same category of heuristic as
// src/tenancy/query-guard.ts, and for the same reason: fast, loud feedback,
// not a security boundary in itself):
//
//   1. `set_config(a, b, false)` — the explicit session-scoped form.
//   2. `set_config(...)` called with FEWER than 3 arguments — the 2-arg
//      form defaults to session scope exactly as `false` does.
//   3. A bare `SET ...` SQL STATEMENT (the literal's text, once trimmed,
//      starts with the token `SET`) that isn't `SET LOCAL` or `SET ROLE`
//      (RESET ROLE is a different keyword entirely and never matches this
//      shape at all). This deliberately does NOT match `UPDATE ... SET
//      col = val` — that occurrence of `SET` is never the first token of
//      the statement.

const SET_CONFIG_CALL_PATTERN = /set_config\s*\(/gi;
const BARE_SET_STATEMENT_PATTERN = /^SET\s+(\S+)/i;
const EXEMPT_BARE_SET_KEYWORDS = new Set(["LOCAL", "ROLE"]);

/**
 * Given `text` and the index of the character right after a `set_config(`
 * match's opening paren, returns { argsText, endIndex } where endIndex is
 * the index just past the matching close paren. Balances parens and skips
 * over quoted strings so a nested call or a comma inside a string literal
 * doesn't miscount arguments.
 */
function scanBalancedArgs(text, start) {
  let depth = 1;
  let inString = null;
  let i = start;
  for (; i < text.length && depth > 0; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    }
  }
  return { argsText: text.slice(start, i - 1), endIndex: i };
}

/** Splits an argument-list string on TOP-LEVEL commas only (depth 0, outside quotes). */
function splitTopLevelArgs(argsText) {
  const args = [];
  let depth = 0;
  let inString = null;
  let current = "";
  for (const ch of argsText) {
    if (inString) {
      current += ch;
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0 || args.length > 0) {
    args.push(current);
  }
  return args.map((a) => a.trim()).filter((a) => a.length > 0);
}

function findSetConfigViolations(text) {
  const violations = [];
  let match;
  SET_CONFIG_CALL_PATTERN.lastIndex = 0;
  while ((match = SET_CONFIG_CALL_PATTERN.exec(text)) !== null) {
    const { argsText, endIndex } = scanBalancedArgs(text, match.index + match[0].length);
    const args = splitTopLevelArgs(argsText);
    if (args.length < 3) {
      violations.push({ kind: "setConfigTooFewArgs", argCount: args.length });
    } else if (/^false$/i.test(args[2])) {
      violations.push({ kind: "setConfigFalse" });
    }
    SET_CONFIG_CALL_PATTERN.lastIndex = endIndex;
  }
  return violations;
}

function findBareSetViolations(text) {
  const violations = [];
  for (const rawStatement of text.split(";")) {
    const statement = rawStatement.trim();
    const match = BARE_SET_STATEMENT_PATTERN.exec(statement);
    if (match && !EXEMPT_BARE_SET_KEYWORDS.has(match[1].toUpperCase())) {
      violations.push({ kind: "bareSessionSet" });
    }
  }
  return violations;
}

// Fix pass item 10 — the ORIGINAL set only matched `.query(...)`. Both
// `.query()` and `.execute()` are real client method names used in this
// exact codebase (`security-and-tenancy.md` §4's own TenantContextInterceptor
// sample calls `tx.execute(sql\`...\`)`; `query-guard.ts` handles both an
// object-argument `.query(...)` call today) — a rule that only recognizes
// `.query` silently stops enforcing NFR-SEC-02 the moment either of those
// patterns is adopted.
const QUERY_METHOD_NAMES = new Set(["query", "execute"]);

function isQueryMethodCall(node) {
  if (!node || node.type !== "CallExpression") {
    return false;
  }
  const { callee } = node;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    QUERY_METHOD_NAMES.has(callee.property.name)
  );
}

// Fix pass (second pass) — Drizzle is already a dependency in this repo
// (drizzle-orm, not yet used for any real query in the codebase, per
// package.json), and its own `sql` helper exposes TWO more ways to embed raw
// SQL text that are just as capable of carrying a session-scoped `SET` or a
// 2-arg/`false` `set_config` call as `.query()`/`.execute()` are:
// `sql.raw("...")` (a plain string, not a tagged template, injected
// verbatim) and `sql.fromList([...])` (an array of SQL chunks joined
// together, some of which may themselves be plain string/template literals
// rather than nested `sql`-tagged templates, which the existing
// TaggedTemplateExpression visitor already covers regardless of nesting).
function isSqlMemberCall(node, methodName) {
  if (!node || node.type !== "CallExpression") {
    return false;
  }
  const { callee } = node;
  return (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.object.type === "Identifier" &&
    callee.object.name === "sql" &&
    callee.property.type === "Identifier" &&
    callee.property.name === methodName
  );
}

/** A direct argument to `sql.raw(...)` — unambiguously SQL text by construction, same category as a `sql`-tagged template. */
function isSqlRawArgument(node) {
  const parent = node.parent;
  return Boolean(parent) && parent.type === "CallExpression" && parent.arguments.includes(node) && isSqlMemberCall(parent, "raw");
}

/** A string/template literal ELEMENT of the array argument to `sql.fromList([...])`. */
function isSqlFromListElement(node) {
  const arrayParent = node.parent;
  if (!arrayParent || arrayParent.type !== "ArrayExpression") {
    return false;
  }
  const callParent = arrayParent.parent;
  return (
    Boolean(callParent) &&
    callParent.type === "CallExpression" &&
    callParent.arguments.includes(arrayParent) &&
    isSqlMemberCall(callParent, "fromList")
  );
}

/**
 * Only string/template literals that are themselves SQL text reaching
 * Postgres are considered — narrows the scan away from prose that merely
 * mentions the pattern: an `it("...set_config...")` test title, a `//`
 * comment (comments are never Literal/TemplateLiteral AST nodes at all), or
 * this rule's own meta.docs/messages strings. Without this, the rule would
 * flag its own description of what it bans, and every test title that
 * happens to name the SQL function under test. Recognizes TWO shapes
 * directly (fix pass item 10 widened this from one):
 *
 *   1. A direct argument to `.query(...)`/`.execute(...)` — the original
 *      shape.
 *   2. The `text` property of an object-argument to `.query(...)`/
 *      `.execute(...)` (`client.query({ text: "...", values: [...] })`) —
 *      query-guard.ts's own object-form handling already assumes this shape
 *      is in use.
 *
 * Three MORE shapes are checked independently, by dedicated helpers, in the
 * Literal/TemplateLiteral visitors below rather than folded into this
 * function — each is unambiguously SQL text by construction, regardless of
 * where it's used, unlike a bare string literal:
 *
 *   3. The `TaggedTemplateExpression` visitor's `sql\`...\`` tagged-template
 *      shape.
 *   4. `isSqlRawArgument` — a direct argument to `sql.raw(...)` (fix pass,
 *      second pass — Drizzle's raw-SQL escape hatch).
 *   5. `isSqlFromListElement` — a string/template literal element of the
 *      array argument to `sql.fromList([...])` (same fix pass).
 */
function isQueryCallArgument(node) {
  const parent = node.parent;
  if (!parent) {
    return false;
  }
  if (parent.type === "CallExpression" && parent.arguments.includes(node)) {
    return isQueryMethodCall(parent);
  }
  if (
    parent.type === "Property" &&
    parent.value === node &&
    !parent.computed &&
    ((parent.key.type === "Identifier" && parent.key.name === "text") ||
      (parent.key.type === "Literal" && parent.key.value === "text"))
  ) {
    const objectExpression = parent.parent;
    if (objectExpression && objectExpression.type === "ObjectExpression") {
      const callExpression = objectExpression.parent;
      return (
        callExpression &&
        callExpression.type === "CallExpression" &&
        callExpression.arguments.includes(objectExpression) &&
        isQueryMethodCall(callExpression)
      );
    }
  }
  return false;
}

// Joins a TemplateLiteral's quasis with a non-empty placeholder in place of
// each embedded `${...}` expression — NOT a bare join. A bare join collapses
// `set_config('app.x', ${workspaceId}, true)` into
// `set_config('app.x', , true)`, which splitTopLevelArgs then trims to an
// EMPTY string and drops as a whole argument (its `.filter((a) => a.length >
// 0)`), silently miscounting a genuinely 3-argument call as 2 and false-
// flagging setConfigTooFewArgs. The placeholder text itself is irrelevant
// (never matched against `/^false$/i`), only that it occupies the comma slot
// an interpolated bind value actually occupies at runtime.
function joinTemplateRaw(quasis) {
  return quasis.map((quasi) => quasi.value.raw).join("__EXPR__");
}

function checkText(context, node, text) {
  if (typeof text !== "string" || text.length === 0) {
    return;
  }
  for (const violation of findSetConfigViolations(text)) {
    if (violation.kind === "setConfigFalse") {
      context.report({ node, messageId: "setConfigFalse" });
    } else {
      context.report({ node, messageId: "setConfigTooFewArgs", data: { count: String(violation.argCount) } });
    }
  }
  for (const violation of findBareSetViolations(text)) {
    if (violation.kind === "bareSessionSet") {
      context.report({ node, messageId: "bareSessionSet" });
    }
  }
}

/** @type {import('eslint').Rule.RuleModule} */
const noSessionScopedConfig = {
  meta: {
    type: "problem",
    docs: {
      // Deliberately avoids writing a parenthesized, comma-separated
      // argument list resembling an actual set_config call anywhere in this
      // file's own STRING LITERALS (as opposed to `//` comments, which this
      // rule never scans) — this rule scans every string/template literal
      // in every linted file, itself included, and a docs/message string
      // shaped like "set_config(..., false)" previously tripped the very
      // rule it was documenting.
      description:
        "Bans session-scoped Postgres configuration: a set_config call whose third argument is false, a set_config call with fewer than three arguments, or a bare SET statement that is not SET LOCAL or SET ROLE. NFR-SEC-02.",
    },
    schema: [],
    messages: {
      setConfigFalse:
        "set_config's third argument must be true, never false — false is session-scoped and leaks across pooled connections under pgBouncer transaction pooling (NFR-SEC-02). Pass true for SET LOCAL semantics.",
      setConfigTooFewArgs:
        "set_config called with fewer than 3 arguments (got {{count}}) defaults to session scope, same as passing false explicitly (NFR-SEC-02). Always pass the third argument.",
      bareSessionSet:
        "A bare SET statement, other than SET LOCAL or SET ROLE, is session-scoped and leaks across pooled connections under pgBouncer transaction pooling (NFR-SEC-02). Use SET LOCAL instead, or set_config with true as its third argument.",
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value === "string" && (isQueryCallArgument(node) || isSqlRawArgument(node) || isSqlFromListElement(node))) {
          checkText(context, node, node.value);
        }
      },
      TemplateLiteral(node) {
        // A TaggedTemplateExpression's `quasi` IS a TemplateLiteral node,
        // which would double-report alongside the TaggedTemplateExpression
        // visitor below — skip it here; the dedicated visitor owns it.
        if (node.parent && node.parent.type === "TaggedTemplateExpression" && node.parent.quasi === node) {
          return;
        }
        if (isQueryCallArgument(node) || isSqlRawArgument(node) || isSqlFromListElement(node)) {
          checkText(context, node, joinTemplateRaw(node.quasis));
        }
      },
      // Fix pass item 10 — `sql\`...\`` tagged templates (the canonical form
      // in security-and-tenancy.md §4's own TenantContextInterceptor sample:
      // `tx.execute(sql\`SELECT set_config(...)\`)`). A `sql`-tagged
      // template is unambiguously SQL text by construction, so this is
      // checked independent of where it's used — unlike a bare string
      // literal, there's no plausible "prose that merely mentions the
      // pattern" false-positive risk to guard against here.
      TaggedTemplateExpression(node) {
        if (node.tag.type === "Identifier" && node.tag.name === "sql") {
          checkText(context, node, joinTemplateRaw(node.quasi.quasis));
        }
      },
    };
  },
};

export default noSessionScopedConfig;
