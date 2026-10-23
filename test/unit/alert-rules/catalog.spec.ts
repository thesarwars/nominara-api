import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALERT_CATALOG, alertRule, alertRuleForTask } from "../../../src/lib/alert-rules/catalog.js";
import { alertDeepLink } from "../../../src/lib/alert-rules/deep-links.js";
import { BlackoutMonitor } from "../../../src/lib/engines/blackout.js";
import { channelsFor, deepLinkHref } from "../../../src/lib/notifications/routing.js";

// STORY-068 — scoring-models.md §15, the alert rule catalog, transcribed. Every row of the reference's table is a row
// here with its severity, cooldown and generated task; the numbers are normative.

const SPEC: ReadonlyArray<[code: string, severity: string, cooldownDays: number | null, generates: string | null]> = [
  ["sov_drop_engine", "warning", 7, "TG-SOV-DROP-ENGINE"],
  ["sov_drop_global", "critical", 7, "TG-SOV-DROP-GLOBAL"],
  ["presence_loss", "warning", 7, "TG-PRESENCE-LOSS"],
  ["negative_spike", "critical", 3, "TG-SENTIMENT-NEGATIVE"],
  ["citation_loss", "warning", 7, "TG-CITATION-LOSS"],
  ["competitor_overtake", "warning", 14, "TG-COMPETITOR-GAIN"],
  ["source_gap_critical", "warning", 30, "TG-SOURCE-ABSENCE"],
  ["aux_critical", "critical", null, "TG-AUX-*"],
  ["engine_blackout", "critical", 1, null],
  ["stability_collapse", "info", 14, "TG-PROMPT-UNSTABLE"],
  ["displacement_detected", "critical", null, "TG-DISPLACEMENT-RECOVER"],
  ["rendering_downgrade", "warning", 7, "TG-RENDER-SCHEMA"],
  ["entity_node_missing", "warning", 30, "TG-ENTITY-NODE"],
  ["divergence_high", "warning", 14, "TG-DIVERGENCE"],
  ["topic_gap_high", "info", 30, "TG-TOPIC-CONTENT"],
  ["ai_substitution", "warning", 14, "TG-SUBSTITUTION-REVIEW"],
  ["quota_threshold", "warning", null, null],
];

const PROJECT = "0190a000-0000-7000-8000-0000000000aa";

describe("STORY-068 · the §15 alert rule catalog", () => {
  it("[STORY-068 #1 / AC1] every rule in §15 is in the catalog with its documented severity, cooldown and generated task — and nothing else is", () => {
    expect(ALERT_CATALOG.map((rule) => rule.code).sort()).toEqual(SPEC.map(([code]) => code).sort());
    for (const [code, severity, cooldownDays, generates] of SPEC) {
      const rule = alertRule(code);
      expect(rule.severity, code).toBe(severity);
      expect(rule.cooldownDays, code).toBe(cooldownDays);
      expect(rule.generates, code).toBe(generates);
    }
  });

  it("[STORY-068 #1 / AC1] a generated task maps back to its alert rule, every AUX rule's task to aux_critical", () => {
    expect(alertRuleForTask("TG-SOV-DROP-ENGINE")?.code).toBe("sov_drop_engine");
    expect(alertRuleForTask("TG-DISPLACEMENT-RECOVER")?.code).toBe("displacement_detected");
    expect(alertRuleForTask("TG-AUX-R-001")?.code).toBe("aux_critical");
    expect(alertRuleForTask("TG-AUX-R-007")?.code).toBe("aux_critical");
    expect(alertRuleForTask("TG-UNKNOWN")).toBeUndefined();
  });

  it("[STORY-068 AC4 / #5] the high-impact displacement rule has NO cooldown, and neither does a new critical AUX finding", () => {
    expect(alertRule("displacement_detected").cooldownDays).toBeNull();
    expect(alertRule("aux_critical").cooldownDays).toBeNull();
  });

  it("[STORY-068 AC5 / #6] engine_blackout is INTERNAL ONLY: no task generates it, it never maps from one, and it routes to the ops pager", () => {
    const rule = alertRule("engine_blackout");
    expect(rule.internal).toBe(true);
    expect(rule.route).toBe("ops_pager");
    for (const other of ALERT_CATALOG.filter((r) => r.code !== "engine_blackout")) expect(other.internal, other.code).toBe(false);
    expect(ALERT_CATALOG.filter((r) => r.generates !== null).map((r) => alertRuleForTask(r.generates!.replace("*", "R-001"))?.code)).not.toContain("engine_blackout");
  });

  it("[STORY-068 AC5 / #6] the blackout monitor pages ops under the catalog's rule name, and imports nothing that writes a customer notification", () => {
    const pages: Array<{ message: string; details: Record<string, unknown> }> = [];
    let now = 0;
    const monitor = new BlackoutMonitor({ page: (message, details) => void pages.push({ message, details: details as Record<string, unknown> }) }, () => now);
    monitor.observe("gemini", false);
    now = 49 * 60 * 60 * 1000;
    monitor.observe("gemini", false);
    expect(pages).toHaveLength(1);
    expect(pages[0]!.details.alertName).toBe(alertRule("engine_blackout").code);
    const source = readFileSync(new URL("../../../src/lib/engines/blackout.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/notifications\/writer|INSERT INTO notifications/u);
  });

  it("[STORY-068 #1] ai_substitution is post-launch: catalogued, never evaluated", () => {
    expect(alertRule("ai_substitution").postLaunch).toBe(true);
    expect(alertRuleForTask("TG-SUBSTITUTION-REVIEW")).toBeUndefined();
  });

  it("[STORY-068 AC12 / #12] severity determines channel: critical is emailed at once, warning and info wait for the digest", () => {
    expect(channelsFor("critical")).toEqual(["in_app", "email"]);
    expect(channelsFor("warning")).toEqual(["in_app"]);
    expect(channelsFor("info")).toEqual(["in_app"]);
  });

  it("[STORY-068 AC13 / #13] every customer-facing rule links to the surface that diagnoses it, with its filters applied", () => {
    const cases: Array<[string, Parameters<typeof alertDeepLink>[1], string]> = [
      ["sov_drop_engine", { projectId: PROJECT, engine: "gemini", windowDays: 7 }, `/p/${PROJECT}/prompts?engines=gemini&sort=worst&tf=7d`],
      ["presence_loss", { projectId: PROJECT, engine: "chatgpt", windowDays: 14 }, `/p/${PROJECT}/prompts?engines=chatgpt&presence=absent&tf=30d`],
      ["citation_loss", { projectId: PROJECT, engine: "claude", windowDays: 7 }, `/p/${PROJECT}/sources?engines=claude&tf=7d`],
      ["sov_drop_global", { projectId: PROJECT, windowDays: 7 }, `/p/${PROJECT}/overview?tf=7d`],
      ["competitor_overtake", { projectId: PROJECT, windowDays: 7 }, `/p/${PROJECT}/competitors?tf=7d`],
      ["source_gap_critical", { projectId: PROJECT, domain: "reddit.com" }, `/p/${PROJECT}/sources?playbook=reddit.com`],
      ["aux_critical", { projectId: PROJECT, findingId: "f1" }, `/p/${PROJECT}/aux?finding=f1`],
      ["stability_collapse", { projectId: PROJECT }, `/p/${PROJECT}/prompts?stability=unstable`],
      ["displacement_detected", { projectId: PROJECT, displacementId: "d1" }, `/p/${PROJECT}/competitors?displacement=d1`],
      ["negative_spike", { projectId: PROJECT, engine: "gemini" }, `/p/${PROJECT}/prompts?engines=gemini&sentiment=negative`],
      ["divergence_high", { projectId: PROJECT }, `/p/${PROJECT}/geo?analysis=divergence`],
      ["quota_threshold", { projectId: null }, "/settings/plan"],
    ];
    for (const [code, facts, href] of cases) expect(deepLinkHref(alertDeepLink(code, facts)), code).toBe(href);
  });
});
