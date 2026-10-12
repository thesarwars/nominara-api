import { Logger } from "@nestjs/common";
import { incrementCounter } from "../telemetry/metrics.js";
import type { Pager } from "../queue/dead-letter.js";
import { shouldAlertOnResolutionFailures, RESOLUTION_FAILURE_THRESHOLD } from "./citations.js";
import { CLASSIFICATION_COVERAGE_FLOOR, shouldAlertOnCoverage } from "./rendering.js";
import { ESCALATION_ALARM, shouldAlertOnEscalationRate } from "./sentiment/arbiter.js";
import type { ParseResult } from "./parse-capture.js";

// STORY-037 AC10, STORY-038 AC12, STORY-039 AC8 — the three parser alerts.
//
// Each had a PREDICATE (`shouldAlertOnResolutionFailures`, `shouldAlertOnEscalationRate`, `shouldAlertOnCoverage`),
// a unit test, and no caller: nothing counted resolution attempts per engine, nothing metered escalation per
// workspace, nothing metered classification coverage, and nothing sent anything. A story ticked "alert raised"
// while the only thing that existed was the condition under which one would have been.
//
// This is the missing half: a meter the parse handler feeds after every persisted parse, and a send through the
// EXISTING `Pager` port (src/lib/queue/dead-letter.ts) — the same seam the DLQ-depth and engine-blackout alerts use.
// Its production adapter is the logging stub until a paging backend exists (STORY-005); that is a disclosed gap in
// the adapter, not in the wiring.
//
// ⚠ THE PREDICATES ARE NOT RE-DERIVED HERE. Thresholds and minimum samples live in the three parser modules, and this
// file calls the predicates themselves, so the number an alert fires on cannot drift from the number the story's tests
// pin.
//
// ⚠ THE WINDOW AND THE COOLDOWN ARE NOT IN ANY REFERENCE. The stories give a threshold and a minimum sample and say
// nothing about the period a rate is measured over, so a rate needs one chosen. ALERT_WINDOW_MS is a tumbling window:
// counts accumulate within it and are dropped when it elapses, so a week-old failure never combines with today's.
// ALERT_COOLDOWN_MS stops a still-broken vendor paging on every parse. Both are named constants for the owner to move.
//
// ⚠ PER PROCESS, AND THAT IS A LIMIT. The counts live in this process's memory, so each worker replica measures the
// parses it ran: a restart forgets the window, and N replicas each need the minimum sample on their own share. For
// a vendor-change detector that is the right failure direction — it can be late, never wrong — and it adds no table.
// The counters it emits (`nominara_parser_*_total`) are the durable, fleet-wide view.
//
// ⚠ NOTHING HERE TOUCHES MONEY. STORY-038 AC13: the arbiter's cost is absorbed and "the alarm points at us". The
// escalation alert's context carries counts and a rate, never a credit, price or cost.

/** The period a rate is measured over. Not from a reference — see above. */
export const ALERT_WINDOW_MS = 60 * 60 * 1000;
/** How long a (alert, key) pair stays quiet after it pages. Not from a reference — see above. */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export type ParseAlertKind =
  | "citation_resolution_failure"
  | "sentiment_escalation_rate"
  | "rendering_classification_coverage";

/** What one persisted parse contributes to the three meters. Counts only — never text. */
export interface ParseObservation {
  readonly workspaceId: string;
  readonly engineKey: string;
  /** Every citation sent to resolution. */
  readonly citationsAttempted: number;
  /** Of those, the ones that did not resolve (`httpStatus` null). */
  readonly citationsFailed: number;
  readonly mentions: number;
  /** Mentions whose confidence band called for the arbiter, whatever came of it. */
  readonly escalatedMentions: number;
  /** Mentions on an engine that renders attributes — the coverage denominator. */
  readonly capableMentions: number;
  /** Of those, the ones classified from a typed element rather than markdown. */
  readonly classifiedFromElements: number;
}

const logger = new Logger("parse-alerts");

/** The default adapter for the `Pager` port: an error line and a counter, until a paging backend exists. */
export const parseAlertPager: Pager = {
  page(message, context) {
    logger.error({ message, ...context });
    incrementCounter("nominara_parser_alert_page_total", { alert: String(context.alert ?? "unknown") });
  },
};

interface Tally {
  windowStartedAt: number;
  a: number;
  b: number;
}

export interface ParseAlertMonitorOptions {
  readonly pager?: Pager;
  /** Epoch ms — injectable so a test does not wait an hour. */
  readonly clock?: () => number;
}

export class ParseAlertMonitor {
  private readonly pager: Pager;
  private readonly clock: () => number;
  private readonly tallies = new Map<string, Tally>();
  private readonly lastPagedAt = new Map<string, number>();

  constructor(options: ParseAlertMonitorOptions = {}) {
    this.pager = options.pager ?? parseAlertPager;
    this.clock = options.clock ?? Date.now;
  }

  observe(observation: ParseObservation): void {
    const { engineKey, workspaceId } = observation;

    if (observation.citationsAttempted > 0) {
      incrementCounter("nominara_parser_citation_resolution_attempts_total", { engine: engineKey, outcome: "attempted" });
      if (observation.citationsFailed > 0) {
        incrementCounter("nominara_parser_citation_resolution_attempts_total", { engine: engineKey, outcome: "failed" });
      }
      const tally = this.add(`citation_resolution_failure:${engineKey}`, observation.citationsAttempted, observation.citationsFailed);
      if (shouldAlertOnResolutionFailures(tally.a, tally.b)) {
        this.raise("citation_resolution_failure", engineKey, `citation resolution is failing for engine '${engineKey}' — a vendor may have changed its redirect scheme`, {
          engineKey,
          attempted: tally.a,
          failed: tally.b,
          rate: tally.b / tally.a,
          threshold: RESOLUTION_FAILURE_THRESHOLD,
        });
      }
    }

    if (observation.mentions > 0) {
      const tally = this.add(`sentiment_escalation_rate:${workspaceId}`, observation.mentions, observation.escalatedMentions);
      if (shouldAlertOnEscalationRate(tally.a, tally.b)) {
        this.raise("sentiment_escalation_rate", workspaceId, `sentiment escalation rate is above the alarm for workspace ${workspaceId} — the lexicon needs tuning for this vertical`, {
          workspaceId,
          mentions: tally.a,
          escalated: tally.b,
          rate: tally.b / tally.a,
          threshold: ESCALATION_ALARM,
        });
      }
    }

    if (observation.capableMentions > 0) {
      const tally = this.add(`rendering_classification_coverage:${engineKey}`, observation.capableMentions, observation.classifiedFromElements);
      if (shouldAlertOnCoverage(tally.a, tally.b)) {
        this.raise("rendering_classification_coverage", engineKey, `rendering classification coverage is below the floor for engine '${engineKey}' — its adapter may have stopped emitting typed elements`, {
          engineKey,
          capable: tally.a,
          classified: tally.b,
          coverage: tally.b / tally.a,
          floor: CLASSIFICATION_COVERAGE_FLOOR,
        });
      }
    }
  }

  /** Adds to a key's tumbling window, starting a fresh one when the last has elapsed. */
  private add(key: string, a: number, b: number): Tally {
    const now = this.clock();
    const existing = this.tallies.get(key);
    const tally = existing !== undefined && now - existing.windowStartedAt < ALERT_WINDOW_MS ? existing : { windowStartedAt: now, a: 0, b: 0 };
    tally.a += a;
    tally.b += b;
    this.tallies.set(key, tally);
    return tally;
  }

  private raise(kind: ParseAlertKind, subject: string, message: string, context: Record<string, unknown>): void {
    const now = this.clock();
    const key = `${kind}:${subject}`;
    const last = this.lastPagedAt.get(key);
    if (last !== undefined && now - last < ALERT_COOLDOWN_MS) return;
    this.lastPagedAt.set(key, now);
    incrementCounter("nominara_parser_alert_total", { alert: kind });
    this.pager.page(message, { alert: kind, ...context });
  }
}

/** The process-wide monitor the parse handler feeds unless a test injects its own. */
export const defaultParseAlertMonitor = new ParseAlertMonitor();

/** What one parse measured for the three meters. Pure, so the counting is testable without a database. */
export function observationFrom(
  capture: { readonly workspaceId: string; readonly engineKey: string },
  result: Pick<ParseResult, "citations" | "mentions">,
): ParseObservation {
  const capable = result.mentions.filter((entry) => entry.rendering.countsTowardDenominator);
  return {
    workspaceId: capture.workspaceId,
    engineKey: capture.engineKey,
    citationsAttempted: result.citations.length,
    citationsFailed: result.citations.filter((citation) => citation.httpStatus === null).length,
    mentions: result.mentions.length,
    escalatedMentions: result.mentions.filter((entry) => entry.sentiment.escalated).length,
    capableMentions: capable.length,
    classifiedFromElements: capable.filter((entry) => entry.rendering.derivedFrom === "element").length,
  };
}
