import { RuleTester } from "eslint";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain JS rule module, no type declarations.
import metricNameConvention from "../../eslint-rules/metric-name-convention.js";

// STORY-005 AC8 / scenario 5: "Emit a metric with no unit suffix - the lint rule rejects it."
// coding-standards.md section 7: metrics are `nominara_<subsystem>_<measure>` with the units in the name (_ms, _bytes, _total);
// `_seconds` is the unit edge-cases-and-slos.md uses for lag. The rule checks every name handed to the two metric helpers.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } });

describe("STORY-005 AC8 - eslint-rules/metric-name-convention", () => {
  ruleTester.run("metric-name-convention", metricNameConvention, {
    valid: [
      { name: "a counter with _total", code: `incrementCounter("nominara_billing_addon_change_total", { outcome: "ok" });` },
      { name: "a histogram with _ms", code: `observeValue("nominara_api_request_duration_ms", 12);` },
      { name: "_bytes", code: `observeValue("nominara_reports_artifact_size_bytes", 12);` },
      { name: "_seconds", code: `observeValue("nominara_rollup_attribution_lag_seconds", 12);` },
      { name: "a const resolved in the same file", code: `const LAG_METRIC = "nominara_rollup_attribution_lag_seconds"; observeValue(LAG_METRIC, 1);` },
      { name: "a template whose static parts satisfy the convention", code: "incrementCounter(`nominara_billing_${what}_session_total`);" },
      { name: "an unrelated call with a non-metric string is ignored", code: `logger.log("whatever"); other("nominara_x");` },
      { name: "a member call on something else named like a helper is ignored", code: `thing.incrementCounter("not_a_metric");` },
    ],
    invalid: [
      { name: "no unit suffix", code: `incrementCounter("nominara_billing_addon_change", {});`, errors: [{ messageId: "badName" }] },
      { name: "missing the nominara_ prefix", code: `incrementCounter("billing_addon_change_total");`, errors: [{ messageId: "badName" }] },
      { name: "no subsystem (prefix, then straight to the unit)", code: `incrementCounter("nominara_total");`, errors: [{ messageId: "badName" }] },
      { name: "no measure (prefix, one word, unit)", code: `incrementCounter("nominara_billing_total");`, errors: [{ messageId: "badName" }] },
      { name: "uppercase and hyphens", code: `observeValue("Nominara-Billing-Latency_ms", 1);`, errors: [{ messageId: "badName" }] },
      { name: "an ambiguous unit (_count)", code: `observeValue("nominara_billing_rows_count", 1);`, errors: [{ messageId: "badName" }] },
      { name: "a const that resolves to a bad name", code: `const M = "nominara_billing_lag"; observeValue(M, 1);`, errors: [{ messageId: "badName" }] },
      { name: "a template whose tail has no unit", code: "incrementCounter(`nominara_billing_${what}_session`);", errors: [{ messageId: "badName" }] },
      { name: "a name that cannot be resolved statically is reported, not guessed", code: `function f(metric) { observeValue(metric, 1); }`, errors: [{ messageId: "notStatic" }] },
      { name: "a non-literal expression is reported", code: `incrementCounter(prefix + "_total");`, errors: [{ messageId: "notStatic" }] },
    ],
  });
});

describe("batch 19 - the legacy baseline is empty and nothing relies on it", () => {
  it("the grandfather list is empty, and every metric name emitted in src/ conforms without it", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    // @ts-expect-error - plain JS rule module, no type declarations.
    const { LEGACY_METRIC_NAMES } = (await import("../../eslint-rules/metric-name-convention.js")) as { LEGACY_METRIC_NAMES: Set<string> };
    // Replaces the previous assertion `LEGACY_METRIC_NAMES.size === 28` (and the per-entry "still emitted, still non-conforming" loop): the 28
    // were renamed on purpose in batch 19, so the list is now required to be empty.
    expect(LEGACY_METRIC_NAMES.size).toBe(0);

    const files = (readdirSync(new URL("../../src", import.meta.url), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !/\.(?:spec|test)\.ts$/u.test(f));
    // The rule's own definition: nominara_<subsystem>_<measure>..., with the unit as the final word (so the unit counts toward the minimum).
    const conforming = /^nominara_[a-z0-9]+(?:_[a-z0-9]+){2,}$/u;
    const hasUnit = (name: string): boolean => ["total", "ms", "seconds", "bytes"].some((unit) => name.endsWith(`_${unit}`));
    // A literal first argument of either helper, read statically like the rule does. Template names are skipped here (the rule checks those).
    const call = /\b(?:incrementCounter|observeValue)\(\s*"([^"]+)"/gu;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(new URL(`../../src/${file}`, import.meta.url), "utf8");
      for (const match of source.matchAll(call)) if (!conforming.test(match[1]!) || !hasUnit(match[1]!)) offenders.push(`${file}: ${match[1]!}`);
    }
    expect(offenders).toEqual([]);
  });

  it("none of the 28 retired names is emitted any more", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const retired = [
      "credit_reconcile_yielded_total", "nominara_alerts_total", "nominara_aux_pages_evaluated_count", "nominara_aux_rules_evaluated_count",
      "nominara_discovery_category_embed_tokens", "nominara_displacement_citation_gap_entries", "nominara_displacement_concept_gap_entries",
      "nominara_embed_reembed_pending_rows", "nominara_embed_tokens_spent", "nominara_embed_vectors_written", "nominara_geo_alignment_nodes_collapsed",
      "nominara_geo_corpus_passages_written", "nominara_geo_name_match_judge_tokens_spent", "nominara_gsc_sync_rows_per_run",
      "nominara_maintenance_orphan_fact_rows", "nominara_maintenance_vector_recall_ratio", "nominara_partition_default_rows",
      "nominara_prompts_naturalise_tokens_spent", "nominara_retention_purge_failures_unresolved", "nominara_rollup_attribution_seconds_since_last_commit",
      "nominara_tools_runs_reaped_rows", "nominara_tools_snapshots_expired_rows", "nominara_topic_cluster_clusters_written",
      "nominara_topic_cluster_outlier_prompts", "nominara_topic_cluster_prompts_dropped_by_cap", "partition_create_failed",
      "partition_default_rows_detected", "queue_schedule_reconcile_failed",
    ];
    expect(retired).toHaveLength(28);
    const files = (readdirSync(new URL("../../src", import.meta.url), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
    const source = files.map((f) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8")).join("\n");
    for (const name of retired) expect(source.includes(`"${name}"`), `${name} is still emitted`).toBe(false);
  });
});
