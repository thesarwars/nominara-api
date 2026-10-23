import { describe, expect, it } from "vitest";
import {
  findingFingerprint,
  milestoneKindFor,
  raiseOneBand,
  STALE_AFTER_AUDITS,
  reconcileFindings,
  type DetectedFinding,
  type ExistingFinding,
} from "./lifecycle.js";

// NEW-C-9 AC3 (aux-and-geo-analysis.md §3, STORY-052) — the finding lifecycle
// as a pure transition function. An audit is a lifecycle update, not a log.

const URL = "https://acme.com/robots.txt";
const fp = (reason = "root_disallow"): string => findingFingerprint("AUX-R-001", URL, { file: "robots.txt", reason });
const detected = (over: Partial<DetectedFinding> = {}): DetectedFinding => ({
  fingerprint: fp(), ruleCode: "AUX-R-001", url: URL, severity: "critical", ...over,
});
const existing = (over: Partial<ExistingFinding> = {}): ExistingFinding => ({
  id: "f1", fingerprint: fp(), ruleCode: "AUX-R-001", url: URL, severity: "high", status: "open", occurrenceCount: 1, resolvedAt: null, ...over,
});
const inScope = (): boolean => true;

describe("NEW-C-9 AC3 · fingerprint", () => {
  it("NEW-C-9 AC3.1 · is a 64-char sha256 hex, stable for the same rule, url and evidence", () => {
    expect(fp()).toMatch(/^[0-9a-f]{64}$/);
    expect(fp()).toBe(fp());
  });
  it("NEW-C-9 AC3.2 · differs by rule, by url and by evidence reason", () => {
    const base = fp();
    expect(findingFingerprint("AUX-R-002", URL, { file: "robots.txt", reason: "root_disallow" })).not.toBe(base);
    expect(findingFingerprint("AUX-R-001", "https://other.com/robots.txt", { file: "robots.txt", reason: "root_disallow" })).not.toBe(base);
    expect(fp("path_disallow")).not.toBe(base);
  });
});

describe("NEW-C-9 AC3 · severity band", () => {
  it("NEW-C-9 AC3.3 · raises one band: info>low>medium>high>critical, critical stays critical", () => {
    expect(raiseOneBand("info")).toBe("low");
    expect(raiseOneBand("low")).toBe("medium");
    expect(raiseOneBand("medium")).toBe("high");
    expect(raiseOneBand("high")).toBe("critical");
    expect(raiseOneBand("critical")).toBe("critical");
  });
});

describe("NEW-C-9 AC3 · reconcileFindings", () => {
  it("NEW-C-9 AC3.4 · a new defect inserts one finding", () => {
    expect(reconcileFindings({ existing: [], detected: [detected()], inScope })).toEqual([{ kind: "insert", finding: detected() }]);
  });

  it("NEW-C-9 AC3.5 · the same defect in two audits is one finding: a redetect, not a second insert", () => {
    const actions = reconcileFindings({ existing: [existing()], detected: [detected()], inScope });
    expect(actions).toEqual([{ kind: "redetect", id: "f1", reopen: false }]);
  });

  it.each(["open", "acknowledged", "in_progress", "regressed", "wont_fix"] as const)(
    "NEW-C-9 AC3.6 · a redetected %s finding keeps its status",
    (status) => {
      expect(reconcileFindings({ existing: [existing({ status })], detected: [detected()], inScope })).toEqual([
        { kind: "redetect", id: "f1", reopen: false },
      ]);
    },
  );

  it("NEW-C-9 AC3.7 · a stale finding that is seen again reopens", () => {
    expect(reconcileFindings({ existing: [existing({ status: "stale" })], detected: [detected()], inScope })).toEqual([
      { kind: "redetect", id: "f1", reopen: true },
    ]);
  });

  it.each(["open", "acknowledged", "in_progress", "regressed"] as const)(
    "NEW-C-9 AC3.8 · a %s finding the later audit does not reproduce is resolved",
    (status) => {
      expect(reconcileFindings({ existing: [existing({ status })], detected: [], inScope })).toEqual([{ kind: "resolve", id: "f1" }]);
    },
  );

  it("NEW-C-9 AC3.9 · a finding outside the audited scope is NOT resolved by its absence", () => {
    expect(reconcileFindings({ existing: [existing()], detected: [], inScope: () => false })).toEqual([]);
  });

  it("NEW-C-9 AC3.10 · wont_fix and stale are never resolved by absence", () => {
    expect(reconcileFindings({ existing: [existing({ status: "wont_fix" }), existing({ id: "f2", status: "stale" })], detected: [], inScope })).toEqual([]);
  });

  it("NEW-C-9 AC3.11 · a defect returning after resolution regresses the resolved row, one band higher", () => {
    const actions = reconcileFindings({
      existing: [existing({ status: "resolved", severity: "high", resolvedAt: new Date("2026-09-01T00:00:00Z") })],
      detected: [detected({ severity: "high" })],
      inScope,
    });
    expect(actions).toEqual([{ kind: "regress", id: "f1", severity: "critical" }]);
  });

  it("NEW-C-9 AC3.12 · regression picks the most recently resolved row when several exist", () => {
    const actions = reconcileFindings({
      existing: [
        existing({ id: "old", status: "resolved", resolvedAt: new Date("2026-08-01T00:00:00Z") }),
        existing({ id: "new", status: "resolved", resolvedAt: new Date("2026-09-01T00:00:00Z") }),
      ],
      detected: [detected()],
      inScope,
    });
    expect(actions).toEqual([{ kind: "regress", id: "new", severity: "critical" }]);
  });

  it("NEW-C-9 AC3.13 · a live row wins over a resolved row of the same fingerprint (no regression)", () => {
    const actions = reconcileFindings({
      existing: [existing({ id: "res", status: "resolved", resolvedAt: new Date("2026-08-01T00:00:00Z") }), existing({ id: "live" })],
      detected: [detected()],
      inScope,
    });
    expect(actions).toEqual([{ kind: "redetect", id: "live", reopen: false }]);
  });

  it("NEW-C-9 AC3.14 · an already-resolved finding that stays absent produces no action", () => {
    expect(reconcileFindings({ existing: [existing({ status: "resolved", resolvedAt: new Date() })], detected: [], inScope })).toEqual([]);
  });

  it("NEW-C-9 AC3.15 · empty existing and empty detected is empty", () => {
    expect(reconcileFindings({ existing: [], detected: [], inScope })).toEqual([]);
  });

  it("NEW-C-9 AC3.16 · duplicates in the detected set insert once", () => {
    expect(reconcileFindings({ existing: [], detected: [detected(), detected()], inScope })).toHaveLength(1);
  });
});

describe("STORY-052 AC8 · stale is distinct from resolved", () => {
  const notObserved = (): boolean => false;

  it("STORY-052 scenario 10 · the documented number of consecutive audits is 2", () => {
    expect(STALE_AFTER_AUDITS).toBe(2);
  });

  it("STORY-052 scenario 10 · not observed in this audit and in the one before: stale, NOT resolved", () => {
    const actions = reconcileFindings({ existing: [existing()], detected: [], inScope: notObserved, unobservedBefore: () => 1 });
    expect(actions).toEqual([{ kind: "stale", id: "f1" }]);
  });

  it("STORY-052 scenario 10 · the first audit that cannot see the page is not yet stale (one miss is not two)", () => {
    expect(reconcileFindings({ existing: [existing()], detected: [], inScope: notObserved, unobservedBefore: () => 0 })).toEqual([]);
  });

  it("STORY-052 scenario 10 · with no history function supplied nothing goes stale (fails closed to the old behaviour)", () => {
    expect(reconcileFindings({ existing: [existing()], detected: [], inScope: notObserved })).toEqual([]);
  });

  it("STORY-052 scenario 10 · a prior streak longer than needed is still stale, once", () => {
    expect(reconcileFindings({ existing: [existing()], detected: [], inScope: notObserved, unobservedBefore: () => 5 })).toEqual([{ kind: "stale", id: "f1" }]);
  });

  it("STORY-052 scenario 10 · a finding the audit DID observe and did not reproduce is resolved however long it was unobserved before", () => {
    expect(reconcileFindings({ existing: [existing()], detected: [], inScope, unobservedBefore: () => 9 })).toEqual([{ kind: "resolve", id: "f1" }]);
  });

  it.each(["open", "acknowledged", "in_progress", "regressed"] as const)("STORY-052 scenario 10 · a %s finding can go stale", (status) => {
    expect(reconcileFindings({ existing: [existing({ status })], detected: [], inScope: notObserved, unobservedBefore: () => 1 })).toEqual([{ kind: "stale", id: "f1" }]);
  });

  it.each(["wont_fix", "stale", "resolved"] as const)("STORY-052 scenario 10 · a %s finding is left alone by the stale rule", (status) => {
    const row = existing({ status, resolvedAt: status === "resolved" ? new Date() : null });
    expect(reconcileFindings({ existing: [row], detected: [], inScope: notObserved, unobservedBefore: () => 1 })).toEqual([]);
  });

  it("STORY-052 scenario 10 · a detected finding is never staled, whatever its history", () => {
    expect(reconcileFindings({ existing: [existing()], detected: [detected()], inScope: notObserved, unobservedBefore: () => 3 })).toEqual([
      { kind: "redetect", id: "f1", reopen: false },
    ]);
  });
});

describe("STORY-052 AC11 · which resolutions pin a milestone", () => {
  it.each(["critical", "high"] as const)("STORY-052 scenario 12 · a %s finding closed is an aux_status_change", (severity) => {
    expect(milestoneKindFor(severity, "crawler_access")).toBe("aux_status_change");
  });

  it.each(["medium", "low", "info"] as const)("STORY-052 scenario 12 · a %s finding closed pins nothing", (severity) => {
    expect(milestoneKindFor(severity, "crawler_access")).toBeNull();
  });

  it("scoring-models.md 13 · a structured_data resolution is schema_fixed at any severity, and wins over aux_status_change (one pin per source)", () => {
    expect(milestoneKindFor("critical", "structured_data")).toBe("schema_fixed");
    expect(milestoneKindFor("low", "structured_data")).toBe("schema_fixed");
  });
});
