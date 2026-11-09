import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compareRunsResponseSchema, COMPARE_RUNS_STATEMENT } from "../../../contracts/tools/index.js";
import { diffAuditResults, diffScanResults, wordDiff, type AuditSide, type ScanEngineRow } from "./compare-runs.js";

// STORY-084 - the pure diff rules. Scenario numbers are the story's Test scenarios table.

const row = (engine: string, over: Partial<ScanEngineRow> = {}): ScanEngineRow => ({
  engine,
  brand_present: true,
  rank_position: 2,
  sov: 0.4,
  sentiment: { label: "positive", score: 0.5 },
  citations: [{}, {}],
  excerpt: "Acme is a solid choice for startups",
  ...over,
});

describe("STORY-084 · scenario 5 - a scan comparison is per engine, with a word-level excerpt diff", () => {
  it("scenario 5 - presence, rank, share, sentiment and citation deltas are compare minus base", () => {
    const base = { engines: [row("perplexity")] };
    const compare = {
      engines: [row("perplexity", { rank_position: 1, sov: 0.55, sentiment: { label: "neutral", score: 0.1 }, citations: [{}, {}, {}, {}], excerpt: "Acme is the best choice for startups" })],
    };
    const [engine] = diffScanResults(base, compare).engines;
    expect(engine!.presence).toBe("both");
    expect(engine!.delta).toEqual({
      brand_presence_changed: false,
      rank_position: -1,
      sov: expect.closeTo(0.15, 10),
      sentiment_changed: true,
      sentiment_score: expect.closeTo(-0.4, 10),
      citation_count: 2,
    });
    expect(engine!.excerpt_diff).toEqual([
      { op: "equal", text: "Acme is" },
      { op: "delete", text: "a solid" },
      { op: "insert", text: "the best" },
      { op: "equal", text: "choice for startups" },
    ]);
  });

  it("scenario 5 - the null path: a brand absent from one answer has no rank delta, not a delta from 0", () => {
    const base = { engines: [row("perplexity", { brand_present: false, rank_position: null, sentiment: { label: "absent", score: null } })] };
    const compare = { engines: [row("perplexity", { rank_position: 3 })] };
    const delta = diffScanResults(base, compare).engines[0]!.delta!;
    expect(delta.brand_presence_changed).toBe(true);
    expect(delta.rank_position).toBeNull();
    expect(delta.sentiment_score).toBeNull();
    expect(delta.sentiment_changed).toBe(true);
  });

  it("scenario 5 - a measured zero stays a zero: identical rows give delta 0, not null", () => {
    const delta = diffScanResults({ engines: [row("a")] }, { engines: [row("a")] }).engines[0]!.delta!;
    expect(delta.rank_position).toBe(0);
    expect(delta.sov).toBe(0);
    expect(delta.citation_count).toBe(0);
    expect(delta.sentiment_changed).toBe(false);
  });
});

describe("STORY-084 · scenario 7 - an engine in one run only is added or removed, never a delta from zero", () => {
  it("scenario 7 - removed and added engines carry no delta and no excerpt diff", () => {
    const base = { engines: [row("perplexity"), row("chatgpt")] };
    const compare = { engines: [row("perplexity"), row("copilot")] };
    const engines = diffScanResults(base, compare).engines;
    const by = Object.fromEntries(engines.map((e) => [e.engine, e]));
    expect(by.chatgpt).toMatchObject({ presence: "removed", compare: null, delta: null, excerpt_diff: null });
    expect(by.chatgpt!.base).not.toBeNull();
    expect(by.copilot).toMatchObject({ presence: "added", base: null, delta: null, excerpt_diff: null });
    expect(by.perplexity!.presence).toBe("both");
  });

  it("scenario 7 - two runs with no engines at all compare to an empty list", () => {
    expect(diffScanResults({ engines: [] }, { engines: [] }).engines).toEqual([]);
  });
});

describe("STORY-084 · word diff", () => {
  it("is empty for two empty excerpts, and all insert / all delete against one empty side", () => {
    expect(wordDiff("", "").ops).toEqual([]);
    expect(wordDiff("", "a b").ops).toEqual([{ op: "insert", text: "a b" }]);
    expect(wordDiff("a b", "").ops).toEqual([{ op: "delete", text: "a b" }]);
  });

  it("collapses whitespace and reports identical text as one equal run", () => {
    expect(wordDiff("a  b\nc", "a b c").ops).toEqual([{ op: "equal", text: "a b c" }]);
  });

  it("is bounded: an excerpt over the word cap is diffed over its first words and says so", () => {
    const long = Array.from({ length: 5000 }, (_, i) => `w${i}`).join(" ");
    const out = wordDiff(long, `${long} extra`);
    expect(out.truncated).toBe(true);
    expect(out.ops.reduce((n, o) => n + o.text.split(" ").length, 0)).toBeLessThan(1500);
  });
});

const finding = (rule_code: string, severity: AuditSide["findings"][number]["severity"], url: string | null = "https://acme.test/a") => ({ rule_code, title: `T ${rule_code}`, severity, url });

describe("STORY-084 · scenario 6 - an audit comparison: resolved, regressed, new, and the score delta", () => {
  const base: AuditSide = { score: 60, findings_omitted: 0, findings: [finding("R1", "high"), finding("R2", "low"), finding("R3", "medium")] };
  const compare: AuditSide = { score: 72, findings_omitted: 0, findings: [finding("R2", "high"), finding("R3", "medium"), finding("R4", "info")] };

  it("scenario 6 - resolved = in base only; new = in compare only; regressed = same fingerprint, worse severity", () => {
    const out = diffAuditResults(base, compare);
    expect(out.resolved.map((f) => f.rule_code)).toEqual(["R1"]);
    expect(out.new.map((f) => f.rule_code)).toEqual(["R4"]);
    expect(out.regressed).toEqual([{ ...finding("R2", "high"), base_severity: "low" }]);
    expect(out.score).toEqual({ base: 60, compare: 72, delta: 12 });
  });

  it("scenario 6 - a finding whose severity improved or held is in none of the three lists", () => {
    const out = diffAuditResults({ score: 50, findings_omitted: 0, findings: [finding("R1", "high"), finding("R2", "medium")] }, { score: 50, findings_omitted: 0, findings: [finding("R1", "low"), finding("R2", "medium")] });
    expect(out.resolved).toEqual([]);
    expect(out.regressed).toEqual([]);
    expect(out.new).toEqual([]);
    expect(out.score.delta).toBe(0);
  });

  it("scenario 6 - the fingerprint is rule and url: the same rule on another page is a different finding", () => {
    const out = diffAuditResults({ score: 1, findings_omitted: 0, findings: [finding("R1", "high", "https://acme.test/a")] }, { score: 1, findings_omitted: 0, findings: [finding("R1", "high", "https://acme.test/b")] });
    expect(out.resolved).toHaveLength(1);
    expect(out.new).toHaveLength(1);
  });

  it("scenario 6 - the null path: a side with no score gives a null delta, never a delta from 0; omitted findings are reported", () => {
    const out = diffAuditResults({ score: null, findings_omitted: 3, findings: [] }, { score: 40, findings_omitted: 0, findings: [] });
    expect(out.score).toEqual({ base: null, compare: 40, delta: null });
    expect(out.findings_omitted).toEqual({ base: 3, compare: 0 });
  });
});

describe("STORY-084 review round 1 - a finding cut from a stored list is not a finding fixed", () => {
  it("compare side omitted findings: a low-severity base finding missing from it is undetermined, not resolved; a higher one is still resolved", () => {
    // The site got worse: new high findings pushed the (still present) low R2 out of the compare run's 24 KB budget.
    const base: AuditSide = { score: 80, findings_omitted: 0, findings: [finding("R1", "high"), finding("R2", "low")] };
    const compare: AuditSide = { score: 50, findings_omitted: 4, findings: [finding("R5", "critical"), finding("R6", "critical"), finding("R7", "high")] };
    const out = diffAuditResults(base, compare);
    expect(out.resolved).toEqual([]); // R1 is high, equal to the lowest kept severity: it could have been cut
    expect(out.undetermined.possibly_resolved.map((f) => f.rule_code).sort()).toEqual(["R1", "R2"]);
  });

  it("a base finding strictly above the lowest kept severity of the compare side was certainly kept if present: it IS resolved", () => {
    const base: AuditSide = { score: 80, findings_omitted: 0, findings: [finding("R1", "critical"), finding("R2", "low")] };
    const compare: AuditSide = { score: 50, findings_omitted: 2, findings: [finding("R5", "high"), finding("R6", "medium")] };
    const out = diffAuditResults(base, compare);
    expect(out.resolved.map((f) => f.rule_code)).toEqual(["R1"]);
    expect(out.undetermined.possibly_resolved.map((f) => f.rule_code)).toEqual(["R2"]);
  });

  it("base side omitted findings: a compare finding at or below the base's lowest kept severity is possibly new, not new", () => {
    const base: AuditSide = { score: 50, findings_omitted: 3, findings: [finding("R1", "critical"), finding("R2", "medium")] };
    const compare: AuditSide = { score: 50, findings_omitted: 0, findings: [finding("R1", "critical"), finding("R3", "low"), finding("R4", "high")] };
    const out = diffAuditResults(base, compare);
    expect(out.new.map((f) => f.rule_code)).toEqual(["R4"]);
    expect(out.undetermined.possibly_new.map((f) => f.rule_code)).toEqual(["R3"]);
  });

  it("a side that kept nothing but omitted some leaves every missing finding undetermined; omitted 0 keeps the old certain lists", () => {
    const base: AuditSide = { score: 1, findings_omitted: 0, findings: [finding("R1", "critical")] };
    const out = diffAuditResults(base, { score: 1, findings_omitted: 5, findings: [] });
    expect(out.resolved).toEqual([]);
    expect(out.undetermined.possibly_resolved.map((f) => f.rule_code)).toEqual(["R1"]);
    const certain = diffAuditResults(base, { score: 1, findings_omitted: 0, findings: [] });
    expect(certain.resolved.map((f) => f.rule_code)).toEqual(["R1"]);
    expect(certain.undetermined).toEqual({ possibly_resolved: [], possibly_new: [] });
  });
});

describe("STORY-084 · scenario 12 - the result states what it is", () => {
  it("scenario 12 - the statement says two moments, not a trend, and the schema pins it", () => {
    expect(COMPARE_RUNS_STATEMENT).toMatch(/two saved moments, not a trend/);
    const ref = { id: "0197c1e0-0000-7000-8000-000000000001", created_at: new Date().toISOString(), expires_at: new Date().toISOString() };
    const ok = {
      id: ref.id, tool_key: "compare_runs", compared_tool: "visibility_scan", base: ref, compare: ref, scan: { engines: [] }, audit: null, credits_charged: 0, reopened: false,
      not_tracked: true, not_tracked_note: "x", did_not_check: "y", statement: COMPARE_RUNS_STATEMENT,
    };
    expect(compareRunsResponseSchema.safeParse(ok).success).toBe(true);
    expect(compareRunsResponseSchema.safeParse({ ...ok, statement: "a trend" }).success).toBe(false);
    expect(compareRunsResponseSchema.safeParse({ ...ok, credits_charged: 1 }).success).toBe(false);
  });
});

describe("STORY-084 · scenario 11 - the comparison code imports no capture, queue or network path", () => {
  const files = [
    path.resolve(__dirname, "compare-runs.ts"),
    path.resolve(__dirname, "../../modules/tools/compare-runs.service.ts"),
  ];
  const FORBIDDEN = [/queue/iu, /capture/iu, /fetch\(/u, /node:https?/u, /axios/u, /undici/u, /\bgot\b/u, /engines?\//u, /url-guard/u, /storage/iu, /debitInTransaction/u, /credits\/debit/u];

  it("scenario 11 - no import line in either file names a forbidden module", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const imports = text.split("\n").filter((line) => /^\s*(import|export)\b.*\bfrom\b/u.test(line) || /\bimport\(/u.test(line));
      for (const line of imports) for (const pattern of FORBIDDEN) expect(line, `${path.basename(file)}: ${line}`).not.toMatch(pattern);
      expect(text, path.basename(file)).not.toMatch(/fetch\(|new Worker|\.add\(|enqueue/u);
    }
    expect(readdirSync(path.dirname(files[1]!))).toContain("compare-runs.service.ts");
  });
});
