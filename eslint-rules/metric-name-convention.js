// STORY-005 AC8 - coding-standards.md section 7: "Metrics are named `nominara_<subsystem>_<measure>` with the units in
// the name (`_ms`, `_bytes`, `_total`)." A dashboard built on a metric whose units are ambiguous is worse than none, so
// the convention is a lint failure rather than a review comment.
//
// What it checks: the FIRST argument of src/lib/telemetry/metrics.ts's two helpers, `incrementCounter` and
// `observeValue`. The name must be a string it can read statically - a literal, a template literal (an interpolation is
// read as one word), or an identifier that resolves to a `const` string literal in this file. A name it cannot read is
// REPORTED (`notStatic`), never waved through: an allow-list that lets the unreadable pass is the gap the next metric
// falls through. `_seconds` is accepted beside the three in the standard because edge-cases-and-slos.md names its lag
// metrics in seconds.

// LEGACY BASELINE - EMPTY. It held the 28 names that predated this rule and broke it, each grandfathered by exact name
// (owner decision 108, "28 legacy metric names are grandfathered"). Batch 19 renamed all 28 to the convention while there were
// no external dashboards or alert rules to break, so the set is empty and stays that way: a name that breaks the rule is
// reported, with no list to add it to. The set and its check below remain only so that a future entry fails
// test/unit/metric-name-convention.spec.ts, which pins the set as empty.
export const LEGACY_METRIC_NAMES = new Set([]);

const HELPERS = new Set(["incrementCounter", "observeValue"]);
const UNITS = ["total", "ms", "seconds", "bytes"];
// nominara_ + subsystem + at least one measure word + unit.
const NAME = new RegExp(`^nominara_[a-z0-9]+(?:_[a-z0-9]+){2,}$`);

function hasUnit(name) {
  return UNITS.some((unit) => name.endsWith(`_${unit}`));
}

function isValidName(name) {
  return NAME.test(name) && hasUnit(name);
}

function resolveConstString(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  while (scope) {
    const variable = scope.set.get(identifier.name);
    if (variable) {
      const def = variable.defs[0];
      if (
        def &&
        def.type === "Variable" &&
        def.parent &&
        def.parent.kind === "const" &&
        def.node.init &&
        def.node.init.type === "Literal" &&
        typeof def.node.init.value === "string"
      ) {
        return def.node.init.value;
      }
      return null;
    }
    scope = scope.upper;
  }
  return null;
}

/** The name as a string, or null when it cannot be read statically. */
function staticName(context, node) {
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") {
    return node.quasis.map((quasi, index) => quasi.value.cooked + (index < node.expressions.length ? "x" : "")).join("");
  }
  if (node.type === "Identifier") return resolveConstString(context, node);
  return null;
}

const metricNameConvention = {
  meta: {
    type: "problem",
    docs: { description: "Metric names are nominara_<subsystem>_<measure>_<unit>, with the unit in the name." },
    schema: [],
    messages: {
      badName:
        'Metric name "{{name}}" breaks the convention: nominara_<subsystem>_<measure> with a unit suffix (_total, _ms, _seconds, _bytes) (coding-standards.md section 7).',
      notStatic:
        "A metric name must be a string literal, a template literal, or a const string literal in this file, so the naming convention can be checked.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier" || !HELPERS.has(node.callee.name)) return;
        const first = node.arguments[0];
        if (!first) return;
        const name = staticName(context, first);
        if (name === null) {
          context.report({ node: first, messageId: "notStatic" });
        } else if (!isValidName(name) && !LEGACY_METRIC_NAMES.has(name)) {
          context.report({ node: first, messageId: "badName", data: { name } });
        }
      },
    };
  },
};

export default metricNameConvention;
