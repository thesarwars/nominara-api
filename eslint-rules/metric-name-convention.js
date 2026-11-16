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

// LEGACY BASELINE - the names that predate this rule and break it. They are NOT exempt by pattern: each is named here
// exactly, so a new metric with a similar shape is still reported. The list may only SHRINK - renaming a metric removes
// its entry (test/unit/metric-name-convention.spec.ts fails on an entry that is unused or already conforms). Renaming
// changes a name dashboards and alert rules may already query, so each rename is its own owner decision, not this rule's.
export const LEGACY_METRIC_NAMES = new Set([
  "credit_reconcile_yielded_total",
  "nominara_alerts_total",
  "nominara_aux_pages_evaluated_count",
  "nominara_aux_rules_evaluated_count",
  "nominara_discovery_category_embed_tokens",
  "nominara_displacement_citation_gap_entries",
  "nominara_displacement_concept_gap_entries",
  "nominara_embed_reembed_pending_rows",
  "nominara_embed_tokens_spent",
  "nominara_embed_vectors_written",
  "nominara_geo_alignment_nodes_collapsed",
  "nominara_geo_corpus_passages_written",
  "nominara_geo_name_match_judge_tokens_spent",
  "nominara_gsc_sync_rows_per_run",
  "nominara_maintenance_orphan_fact_rows",
  "nominara_maintenance_vector_recall_ratio",
  "nominara_partition_default_rows",
  "nominara_prompts_naturalise_tokens_spent",
  "nominara_retention_purge_failures_unresolved",
  "nominara_rollup_attribution_seconds_since_last_commit",
  "nominara_tools_runs_reaped_rows",
  "nominara_tools_snapshots_expired_rows",
  "nominara_topic_cluster_clusters_written",
  "nominara_topic_cluster_outlier_prompts",
  "nominara_topic_cluster_prompts_dropped_by_cap",
  "partition_create_failed",
  "partition_default_rows_detected",
  "queue_schedule_reconcile_failed",
]);

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
