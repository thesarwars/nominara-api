import { describe, expect, it } from "vitest";
import { normalizeCitationUrl } from "../parser/citation-url.js";
import { joinWindow, type JoinInput } from "./rollup-join.js";

// STORY-114 J1 / J2 / J4 / J5 / P6 / P7 / I1 - the pure join, before it touches Postgres.

const PAGE = "https://shop.example.com/guide";
const ALL: JoinInput = {
  citations: [{ url: PAGE, current: 6, prior: 4 }],
  sessions: [{ url: PAGE, sessions: 120, sessionsPrior: 100, conversions: 6 }],
  impressions: [{ url: PAGE, value: 900 }],
  clicks: [{ url: PAGE, value: 35 }],
};

describe("STORY-114 S1 - all sources join per URL per window", () => {
  it("one row carries citations, sessions, conversions, impressions and clicks", () => {
    const rows = joinWindow(ALL);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ citations: 6, aiSessions: 120, conversions: 6, gscAiImpressions: 900, organicClicks: 35, pattern: "dual_visibility" });
    expect(rows[0]!.urlHash.equals(normalizeCitationUrl(PAGE).urlHash)).toBe(true);
  });
});

describe("STORY-114 S2 - variants from both sides collapse to one row", () => {
  it("trailing slash, case, port, tracking and www variants sum into a single row", () => {
    const rows = joinWindow({
      citations: [
        { url: "https://shop.example.com/guide/", current: 2, prior: 1 },
        { url: "https://SHOP.example.com:443/guide?utm_source=x", current: 3, prior: 1 },
      ],
      sessions: [
        { url: "https://www.shop.example.com/guide", sessions: 70, sessionsPrior: 60, conversions: 3 },
        { url: "https://shop.example.com/guide#a", sessions: 50, sessionsPrior: 40, conversions: 3 },
      ],
      impressions: null,
      clicks: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ citations: 5, citationsPrior: 2, aiSessions: 120, aiSessionsPrior: 100, conversions: 6 });
  });
  it("an unparsable URL is dropped, not joined to anything", () => {
    expect(joinWindow({ ...ALL, citations: [{ url: "nonsense", current: 9, prior: 9 }] }).map((r) => r.citations)).toEqual([0]);
  });
});

describe("STORY-114 S5 - prior-window figures sit in the same row", () => {
  it("carries citations_prior and ai_sessions_prior", () => {
    expect(joinWindow(ALL)[0]).toMatchObject({ citationsPrior: 4, aiSessionsPrior: 100 });
  });
});

describe("STORY-114 S6 - conversion rate is null on zero sessions, never zero", () => {
  it("derived from zero sessions is null", () => {
    const [row] = joinWindow({ citations: [{ url: PAGE, current: 2, prior: 0 }], sessions: [], impressions: null, clicks: null });
    expect(row!.aiSessions).toBe(0);
    expect(row!.cvr).toBeNull();
  });
  it("derived from sessions with no conversions is a real zero", () => {
    const [row] = joinWindow({ ...ALL, sessions: [{ url: PAGE, sessions: 40, sessionsPrior: 40, conversions: 0 }] });
    expect(row!.cvr).toBe(0);
  });
  it("is conversions over sessions", () => {
    expect(joinWindow(ALL)[0]!.cvr).toBeCloseTo(0.05, 6);
  });
});

describe("STORY-114 S15 - a URL that went absent is a row, classified invisible", () => {
  it("a URL seen only in the prior window stays in the output with zero current figures", () => {
    const rows = joinWindow({ citations: [{ url: PAGE, current: 0, prior: 3 }], sessions: [{ url: PAGE, sessions: 0, sessionsPrior: 5, conversions: 0 }], impressions: null, clicks: null });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ citations: 0, aiSessions: 0, pattern: "invisible_both" });
  });
});

describe("STORY-114 S16 - an unconnected source leaves the columns null", () => {
  it("impressions and clicks are null, not 0, and no AI-only claim is made", () => {
    const [row] = joinWindow({ ...ALL, impressions: null, clicks: null });
    expect(row!.gscAiImpressions).toBeNull();
    expect(row!.organicClicks).toBeNull();
    expect(row!.pattern).toBe("dual_visibility");
  });
  it("a connected source with no figure for a URL is a measured zero", () => {
    const [row] = joinWindow({ ...ALL, impressions: [], clicks: [] });
    expect(row!.gscAiImpressions).toBe(0);
    expect(row!.organicClicks).toBe(0);
    expect(row!.pattern).toBe("ai_only");
  });
});

describe("STORY-114 S17 - every stored value is a measured count", () => {
  it("every figure is a non-negative integer; only the derived rate is fractional", () => {
    for (const row of joinWindow(ALL)) {
      for (const value of [row.citations, row.citationsPrior, row.aiSessions, row.aiSessionsPrior, row.conversions, row.gscAiImpressions, row.organicClicks]) {
        expect(Number.isInteger(value) && value! >= 0).toBe(true);
      }
    }
  });
  it("a prior window is never extrapolated into a current one", () => {
    const [row] = joinWindow({ citations: [{ url: PAGE, current: 0, prior: 8 }], sessions: [], impressions: null, clicks: null });
    expect(row).toMatchObject({ citations: 0, aiSessions: 0 });
  });
});

describe("STORY-114 - determinism", () => {
  it("the same input in any order produces the same rows in the same order", () => {
    const a = joinWindow({ ...ALL, citations: [{ url: "https://shop.example.com/a", current: 1, prior: 0 }, ...ALL.citations] });
    const b = joinWindow({ ...ALL, citations: [...ALL.citations, { url: "https://shop.example.com/a", current: 1, prior: 0 }] });
    expect(a).toEqual(b);
  });
});

describe("STORY-114 - a query never splits or hides a page (the beacon keeps none)", () => {
  it("a citation URL with a query meets the beacon's query-less landing URL on one row", () => {
    const rows = joinWindow({
      citations: [{ url: "https://shop.example.com/guide?id=5&ref=home", current: 2, prior: 0 }],
      sessions: [{ url: "https://shop.example.com/guide", sessions: 40, sessionsPrior: 0, conversions: 0 }],
      impressions: null,
      clicks: null,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "https://shop.example.com/guide", citations: 2, aiSessions: 40 });
  });
});
