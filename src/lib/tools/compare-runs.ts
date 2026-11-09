import type { AuditComparison, ScanComparison, ScanEngineDiff, WordDiffOp } from "../../../contracts/tools/index.js";

// STORY-084 - the pure diff rules of Compare Runs. No I/O: two stored snapshots in, one comparison out.
//
//   * an engine in one run only is `added` or `removed` and has NO delta - a missing engine is not a score of nothing;
//   * a delta is `null` where either side measured nothing, and 0 only where both sides measured and agree;
//   * "regressed" means the SAME fingerprint with a WORSE severity (owner decision 79). A stored tool finding carries no fingerprint column,
//     so it is derived the way the in-project one is keyed, minus the evidence (which legitimately moves between audits): rule code and url.

export interface ScanEngineRow {
  readonly engine: string;
  readonly brand_present: boolean;
  readonly rank_position: number | null;
  readonly sov: number;
  readonly sentiment: { readonly label: "positive" | "neutral" | "negative" | "absent"; readonly score: number | null };
  readonly citations: readonly unknown[];
  readonly excerpt: string;
}

type Severity = "critical" | "high" | "medium" | "low" | "info";
interface FindingLike {
  readonly rule_code: string;
  readonly title: string;
  readonly severity: Severity;
  readonly url: string | null;
}
export interface AuditSide {
  readonly score: number | null;
  readonly findings_omitted: number;
  readonly findings: readonly FindingLike[];
}

/** The most words of one excerpt the diff reads. The diff is quadratic in it, so it is bounded: 300 x 300 cells at most. */
export const WORD_DIFF_MAX_WORDS = 300;

const SEVERITY_ORDER: Readonly<Record<Severity, number>> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };

const wordsOf = (text: string): string[] => text.split(/\s+/u).filter((w) => w !== "");

/** A word-level diff (longest common subsequence). Adjacent words of the same kind are one op. */
export function wordDiff(base: string, compare: string): { ops: WordDiffOp[]; truncated: boolean } {
  const allA = wordsOf(base);
  const allB = wordsOf(compare);
  const truncated = allA.length > WORD_DIFF_MAX_WORDS || allB.length > WORD_DIFF_MAX_WORDS;
  const a = allA.slice(0, WORD_DIFF_MAX_WORDS);
  const b = allB.slice(0, WORD_DIFF_MAX_WORDS);
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { op: WordDiffOp["op"]; words: string[] }[] = [];
  const push = (op: WordDiffOp["op"], word: string): void => {
    const last = ops[ops.length - 1];
    if (last !== undefined && last.op === op) last.words.push(word);
    else ops.push({ op, words: [word] });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("equal", a[i]!);
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      push("delete", a[i]!);
      i += 1;
    } else {
      push("insert", b[j]!);
      j += 1;
    }
  }
  while (i < n) push("delete", a[i++]!);
  while (j < m) push("insert", b[j++]!);
  return { ops: ops.map((o) => ({ op: o.op, text: o.words.join(" ") })), truncated };
}

const snapshotOf = (r: ScanEngineRow): NonNullable<ScanEngineDiff["base"]> => ({
  brand_present: r.brand_present,
  rank_position: r.rank_position,
  sov: r.sov,
  sentiment_label: r.sentiment.label,
  sentiment_score: r.sentiment.score,
  citation_count: r.citations.length,
});

const diffOrNull = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : b - a);

export function diffScanResults(base: { readonly engines: readonly ScanEngineRow[] }, compare: { readonly engines: readonly ScanEngineRow[] }): ScanComparison {
  const baseBy = new Map(base.engines.map((e) => [e.engine, e]));
  const compareBy = new Map(compare.engines.map((e) => [e.engine, e]));
  const names = [...new Set([...baseBy.keys(), ...compareBy.keys()])].sort();
  const engines = names.map((engine): ScanEngineDiff => {
    const b = baseBy.get(engine);
    const c = compareBy.get(engine);
    if (b === undefined || c === undefined) {
      return {
        engine,
        presence: b === undefined ? "added" : "removed",
        base: b === undefined ? null : snapshotOf(b),
        compare: c === undefined ? null : snapshotOf(c),
        delta: null,
        excerpt_diff: null,
        excerpt_diff_truncated: false,
      };
    }
    const excerpt = wordDiff(b.excerpt, c.excerpt);
    return {
      engine,
      presence: "both",
      base: snapshotOf(b),
      compare: snapshotOf(c),
      delta: {
        brand_presence_changed: b.brand_present !== c.brand_present,
        rank_position: diffOrNull(b.rank_position, c.rank_position),
        sov: c.sov - b.sov,
        sentiment_changed: b.sentiment.label !== c.sentiment.label,
        sentiment_score: diffOrNull(b.sentiment.score, c.sentiment.score),
        citation_count: c.citations.length - b.citations.length,
      },
      excerpt_diff: excerpt.ops,
      excerpt_diff_truncated: excerpt.truncated,
    };
  });
  return { engines };
}

const fingerprint = (f: FindingLike): string => [f.rule_code, f.url ?? ""].join("|");
const refOf = (f: FindingLike): { rule_code: string; title: string; severity: Severity; url: string | null } => ({ rule_code: f.rule_code, title: f.title, severity: f.severity, url: f.url });

/**
 * The most severe rank a finding missing from `side`'s stored list may have and still have been CUT rather than absent. A stored audit keeps its findings
 * in severity order until the 24 KB budget is spent, so when `findings_omitted > 0` everything at or below the lowest kept severity may have been cut
 * (ties inside one severity are cut arbitrarily), while anything strictly above it would have been kept. -1 means nothing could have been cut; a side
 * that kept no finding but omitted some could have cut anything.
 */
function cutCeiling(side: AuditSide): number {
  if (side.findings_omitted === 0) return -1;
  if (side.findings.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...side.findings.map((f) => SEVERITY_ORDER[f.severity]));
}

export function diffAuditResults(base: AuditSide, compare: AuditSide): AuditComparison {
  const baseBy = new Map(base.findings.map((f) => [fingerprint(f), f]));
  const compareBy = new Map(compare.findings.map((f) => [fingerprint(f), f]));
  // A finding absent from one side's list is only "resolved" / "new" if that side could not have cut it: the comparison never claims a fix it cannot see.
  const compareCut = cutCeiling(compare);
  const baseCut = cutCeiling(base);
  const missingFromCompare = base.findings.filter((f) => !compareBy.has(fingerprint(f)));
  const missingFromBase = compare.findings.filter((f) => !baseBy.has(fingerprint(f)));
  const resolved = missingFromCompare.filter((f) => SEVERITY_ORDER[f.severity] > compareCut).map(refOf);
  const possiblyResolved = missingFromCompare.filter((f) => SEVERITY_ORDER[f.severity] <= compareCut).map(refOf);
  const fresh = missingFromBase.filter((f) => SEVERITY_ORDER[f.severity] > baseCut).map(refOf);
  const possiblyNew = missingFromBase.filter((f) => SEVERITY_ORDER[f.severity] <= baseCut).map(refOf);
  const regressed = compare.findings.flatMap((f) => {
    const earlier = baseBy.get(fingerprint(f));
    return earlier !== undefined && SEVERITY_ORDER[f.severity] > SEVERITY_ORDER[earlier.severity] ? [{ ...refOf(f), base_severity: earlier.severity }] : [];
  });
  return {
    score: { base: base.score, compare: compare.score, delta: diffOrNull(base.score, compare.score) },
    resolved,
    regressed,
    new: fresh,
    undetermined: { possibly_resolved: possiblyResolved, possibly_new: possiblyNew },
    findings_omitted: { base: base.findings_omitted, compare: compare.findings_omitted },
  };
}
