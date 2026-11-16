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

describe("STORY-005 AC8 - the legacy baseline can only shrink", () => {
  it("every grandfathered name is still emitted in src/, and none of them conforms (a conforming entry is dead weight)", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    // @ts-expect-error - plain JS rule module, no type declarations.
    const { LEGACY_METRIC_NAMES } = (await import("../../eslint-rules/metric-name-convention.js")) as { LEGACY_METRIC_NAMES: Set<string> };
    const files = (readdirSync(new URL("../../src", import.meta.url), { recursive: true }) as string[]).filter((f) => f.endsWith(".ts") && !/\.(?:spec|test)\.ts$/u.test(f));
    const source = files.map((f) => readFileSync(new URL(`../../src/${f}`, import.meta.url), "utf8")).join("\n");
    const conforming = /^nominara_[a-z0-9]+(?:_[a-z0-9]+){2,}_(?:total|ms|seconds|bytes)$/u;
    for (const name of LEGACY_METRIC_NAMES) {
      expect(source.includes(`"${name}"`), `${name} is no longer emitted - delete its baseline entry`).toBe(true);
      expect(conforming.test(name), `${name} now conforms - delete its baseline entry`).toBe(false);
    }
    expect(LEGACY_METRIC_NAMES.size).toBe(28);
  });
});
