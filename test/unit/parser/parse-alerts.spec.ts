import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pager } from "../../../src/lib/queue/dead-letter.js";
import { CLASSIFICATION_COVERAGE_FLOOR } from "../../../src/lib/parser/rendering.js";
import { ESCALATION_ALARM } from "../../../src/lib/parser/sentiment/arbiter.js";
import { RESOLUTION_FAILURE_THRESHOLD } from "../../../src/lib/parser/citations.js";
import {
  ALERT_COOLDOWN_MS,
  ALERT_WINDOW_MS,
  ParseAlertMonitor,
  observationFrom,
  type ParseObservation,
} from "../../../src/lib/parser/parse-alerts.js";

// STORY-037 AC10 / STORY-038 AC12 / STORY-039 AC8 — three alert PREDICATES existed, were unit-tested, and had no
// caller: nothing counted attempts per engine, nothing metered escalation per workspace, nothing metered coverage,
// and nothing sent. These tests drive the monitor the parse handler feeds and assert the trigger REACHES THE PAGER.

const WS_A = "11111111-1111-7111-8111-111111111111";
const WS_B = "22222222-2222-7222-8222-222222222222";

function observation(overrides: Partial<ParseObservation> = {}): ParseObservation {
  return {
    workspaceId: WS_A,
    engineKey: "gemini",
    citationsAttempted: 0,
    citationsFailed: 0,
    mentions: 0,
    escalatedMentions: 0,
    capableMentions: 0,
    classifiedFromElements: 0,
    ...overrides,
  };
}

function harness() {
  let now = 1_000_000;
  const pages: { message: string; context: Record<string, unknown> }[] = [];
  const pager: Pager = { page: (message, context) => void pages.push({ message, context }) };
  const monitor = new ParseAlertMonitor({ pager, clock: () => now });
  return { monitor, pages, advance: (ms: number) => void (now += ms) };
}

afterEach(() => vi.restoreAllMocks());

describe("STORY-037 AC10 · citation resolution failure alert", () => {
  it("pages when an engine's failure rate crosses the threshold on a sufficient sample, naming the engine", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ citationsAttempted: 20, citationsFailed: 6 })); // 30% > 25%, n = 20
    expect(pages).toHaveLength(1);
    expect(pages[0]!.context).toMatchObject({ alert: "citation_resolution_failure", engineKey: "gemini", attempted: 20, failed: 6 });
  });

  it("does NOT page at exactly the threshold (the predicate is strict) or below the minimum sample", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ citationsAttempted: 100, citationsFailed: 25 })); // exactly 25%
    monitor.observe(observation({ engineKey: "chatgpt", citationsAttempted: 19, citationsFailed: 19 })); // 100% of 19
    expect(RESOLUTION_FAILURE_THRESHOLD).toBe(0.25);
    expect(pages).toHaveLength(0);
  });

  it("accumulates across parses: one dead link per capture is noise until the sample is large enough", () => {
    const { monitor, pages } = harness();
    for (let i = 0; i < 19; i += 1) monitor.observe(observation({ citationsAttempted: 1, citationsFailed: 1 }));
    expect(pages).toHaveLength(0);
    monitor.observe(observation({ citationsAttempted: 1, citationsFailed: 1 })); // the 20th
    expect(pages).toHaveLength(1);
  });

  it("keeps engines apart — one engine's failures never page another", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ engineKey: "gemini", citationsAttempted: 15, citationsFailed: 15 }));
    monitor.observe(observation({ engineKey: "chatgpt", citationsAttempted: 15, citationsFailed: 0 }));
    expect(pages).toHaveLength(0); // each below the sample of 20
    monitor.observe(observation({ engineKey: "gemini", citationsAttempted: 5, citationsFailed: 5 }));
    expect(pages.map((page) => page.context.engineKey)).toEqual(["gemini"]);
  });

  it("is a single page per cooldown for a still-broken engine, and pages again after it", () => {
    const { monitor, pages, advance } = harness();
    monitor.observe(observation({ citationsAttempted: 20, citationsFailed: 20 }));
    monitor.observe(observation({ citationsAttempted: 20, citationsFailed: 20 }));
    expect(pages).toHaveLength(1);
    advance(ALERT_COOLDOWN_MS + 1);
    monitor.observe(observation({ citationsAttempted: 20, citationsFailed: 20 }));
    expect(pages).toHaveLength(2);
  });

  it("forgets a window's counts when it elapses — yesterday's failures never combine with today's", () => {
    const { monitor, pages, advance } = harness();
    monitor.observe(observation({ citationsAttempted: 19, citationsFailed: 19 }));
    advance(ALERT_WINDOW_MS + 1);
    monitor.observe(observation({ citationsAttempted: 1, citationsFailed: 1 })); // would be the 20th, were the window kept
    expect(pages).toHaveLength(0);
  });
});

describe("STORY-038 AC12 · escalation rate alert", () => {
  it("pages, naming the workspace by ID, when escalation crosses the alarm on a sufficient sample", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ mentions: 50, escalatedMentions: 11 })); // 22% > 20%, n = 50
    expect(pages).toHaveLength(1);
    expect(pages[0]!.context).toMatchObject({ alert: "sentiment_escalation_rate", workspaceId: WS_A, mentions: 50, escalated: 11 });
    expect(JSON.stringify(pages[0])).not.toMatch(/workspace_name|"name"/u);
  });

  it("does NOT page at exactly the alarm, or below the minimum sample", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ mentions: 50, escalatedMentions: 10 })); // exactly 20%
    monitor.observe(observation({ workspaceId: WS_B, mentions: 49, escalatedMentions: 49 }));
    expect(ESCALATION_ALARM).toBe(0.2);
    expect(pages).toHaveLength(0);
  });

  it("meters PER WORKSPACE — two workspaces each under the sample do not pool into a page", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ workspaceId: WS_A, mentions: 30, escalatedMentions: 30 }));
    monitor.observe(observation({ workspaceId: WS_B, mentions: 30, escalatedMentions: 30 }));
    expect(pages).toHaveLength(0);
  });

  it("never touches money: the alert context carries no credit or price member", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ mentions: 100, escalatedMentions: 100 }));
    expect(Object.keys(pages[0]!.context).join(",")).not.toMatch(/credit|price|cost|bill/iu);
  });
});

describe("STORY-039 AC8 · classification coverage alarm", () => {
  it("pages when coverage on attribute-capable mentions falls below the floor on a sufficient sample", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ capableMentions: 50, classifiedFromElements: 39 })); // 78% < 80%
    expect(pages).toHaveLength(1);
    expect(pages[0]!.context).toMatchObject({ alert: "rendering_classification_coverage", engineKey: "gemini", capable: 50, classified: 39 });
  });

  it("does NOT page at exactly the floor, below the minimum sample, or with no capable mentions at all", () => {
    const { monitor, pages } = harness();
    monitor.observe(observation({ capableMentions: 50, classifiedFromElements: 40 })); // exactly 80%
    monitor.observe(observation({ engineKey: "chatgpt", capableMentions: 49, classifiedFromElements: 0 }));
    monitor.observe(observation({ engineKey: "perplexity", capableMentions: 0, classifiedFromElements: 0 }));
    expect(CLASSIFICATION_COVERAGE_FLOOR).toBe(0.8);
    expect(pages).toHaveLength(0);
  });
});

describe("the monitor is inert on an empty observation", () => {
  it("pages nothing and divides by nothing", () => {
    const { monitor, pages } = harness();
    expect(() => monitor.observe(observation())).not.toThrow();
    expect(pages).toHaveLength(0);
  });

  it("emits a counter for every alert it raises, and none otherwise", () => {
    const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const { monitor } = harness();
    monitor.observe(observation({ citationsAttempted: 20, citationsFailed: 20 }));
    const metrics = log.mock.calls.map((call) => call[0] as Record<string, unknown>).filter((entry) => typeof entry?.metric === "string");
    expect(metrics.map((entry) => entry.metric)).toContain("nominara_parser_citation_resolution_attempts_total");
    expect(metrics.some((entry) => entry.metric === "nominara_parser_alert_total" && entry.alert === "citation_resolution_failure")).toBe(true);
  });
});

describe("observationFrom — what the parse handler measures", () => {
  const mention = (overrides: { escalated?: boolean; capable?: boolean; derivedFrom?: "element" | "markdown" } = {}) => ({
    sentiment: { escalated: overrides.escalated ?? false },
    rendering: { countsTowardDenominator: overrides.capable ?? true, derivedFrom: overrides.derivedFrom ?? "element" },
  });
  const citation = (httpStatus: number | null) => ({ httpStatus });

  it("counts an unresolved citation (httpStatus null) as a failure and every citation as an attempt", () => {
    const result = { citations: [citation(200), citation(null), citation(404), citation(null)], mentions: [] };
    expect(observationFrom({ workspaceId: WS_A, engineKey: "gemini" }, result as never)).toMatchObject({
      citationsAttempted: 4,
      citationsFailed: 2,
    });
  });

  it("counts escalated mentions, and coverage only over attribute-capable mentions", () => {
    const result = {
      citations: [],
      mentions: [
        mention({ escalated: true }),
        mention({ capable: false, derivedFrom: "markdown" }), // an incapable engine: out of BOTH sides
        mention({ derivedFrom: "markdown" }),
        mention(),
      ],
    };
    expect(observationFrom({ workspaceId: WS_A, engineKey: "gemini" }, result as never)).toMatchObject({
      mentions: 4,
      escalatedMentions: 1,
      capableMentions: 3,
      classifiedFromElements: 2,
    });
  });
});
