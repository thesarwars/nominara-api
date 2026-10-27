import { describe, expect, it } from "vitest";
import {
  RETENTION_FIRST_PURGE_DAYS,
  RETENTION_NOTICE_DAYS,
  retentionShorteningEmail,
  windowShortened,
} from "../../../src/lib/billing/retention-shortening.js";

// STORY-077 slice B · EC-41 · test scenario 6 (the pure half): which plan changes count as shortening, and what the notice says.

describe("STORY-077 R1 · windowShortened", () => {
  it.each([
    [395, 90, true],
    [90, 90, false],
    [90, 395, false],
    ["unlimited", 1095, true],
    [null, 395, false], // "—" (free tier rollups) is not a window that can be shortened
    [395, "unlimited", false],
    [395, null, false],
    [null, null, false],
    ["unlimited", null, false],
    [null, "unlimited", false],
  ] as const)("R1 · %s -> %s shortened = %s", (from, to, expected) => {
    expect(windowShortened(from, to)).toBe(expected);
  });
});

describe("STORY-077 R1 · the constants are the reference's", () => {
  it("R1 · a 14-day notice and the first purge on day 15", () => {
    expect(RETENTION_NOTICE_DAYS).toBe(14);
    expect(RETENTION_FIRST_PURGE_DAYS).toBe(15);
  });
});

describe("STORY-077 R1 · retentionShorteningEmail", () => {
  const purgeNotBefore = new Date("2026-11-11T09:30:00.000Z");
  const base = {
    fromPlanName: "Business",
    toPlanName: "Starter",
    purgeNotBefore,
    raw: {
      from: 395 as number | "unlimited" | null,
      to: 90 as number | "unlimited" | null,
      cutoff: new Date("2026-08-13T09:30:00.000Z"),
      projects: [
        { name: "Acme Site", count: 120, oldest: new Date("2025-10-01T00:00:00.000Z"), newest: new Date("2026-08-12T00:00:00.000Z") },
        { name: "Acme Blog", count: 1, oldest: new Date("2026-01-01T00:00:00.000Z"), newest: new Date("2026-01-01T00:00:00.000Z") },
      ],
    },
    rollups: null,
    newPlanExports: { csv: true, pdfPerCycle: 25 },
  };

  it("R1 · names the purge date, each project's exact count and its oldest and newest capture dates", () => {
    const m = retentionShorteningEmail("owner@example.com", base);
    expect(m.to).toBe("owner@example.com");
    expect(m.textBody).toContain("2026-11-11");
    expect(m.textBody).toContain("Acme Site: 120 captures, 2025-10-01 to 2026-08-12");
    expect(m.textBody).toContain("Acme Blog: 1 capture, 2026-01-01 to 2026-01-01");
    expect(m.textBody).toContain("121");
    expect(m.textBody).toContain("2026-08-13");
  });

  it("R1 · offers the report export when the new plan has one", () => {
    const body = retentionShorteningEmail("o@example.com", base).textBody;
    expect(body).toMatch(/export your data before 2026-11-11 with the report export \(CSV or PDF\)/i);
  });

  // Review round 3 (major): the owner decision says the notice LINKS the report export; naming it is not a link.
  describe("R1 · the export link (review round 3)", () => {
    const withIds = {
      ...base,
      appOrigin: "https://app.nominara.test/",
      raw: {
        ...base.raw,
        projects: [
          { name: "Acme Site", count: 120, oldest: new Date("2025-10-01T00:00:00.000Z"), newest: new Date("2026-08-12T00:00:00.000Z"), projectId: "0190a000-0000-7000-8000-00000000000a" },
          { name: "Gone (deleted project)", count: 2, oldest: new Date("2025-10-01T00:00:00.000Z"), newest: new Date("2025-10-02T00:00:00.000Z"), projectId: null },
        ],
      },
    };

    it("R1 · links each listed project's reports page with an absolute URL when the new plan can export", () => {
      const body = retentionShorteningEmail("o@example.com", withIds).textBody;
      expect(body).toContain("https://app.nominara.test/p/0190a000-0000-7000-8000-00000000000a/reports");
      expect(body, "no double slash after the origin").not.toContain("test//p/");
    });

    it("R1 · a deleted project has no link", () => {
      const body = retentionShorteningEmail("o@example.com", withIds).textBody;
      expect(body.match(/\/reports/g)).toHaveLength(1);
    });

    it("R1 · a plan with no export gets no link (the export would be refused)", () => {
      const body = retentionShorteningEmail("o@example.com", { ...withIds, newPlanExports: { csv: false, pdfPerCycle: 0 } }).textBody;
      expect(body).not.toContain("/reports");
    });

    it("R1 · with no configured origin the link is the app-relative path, as the notification emails do", () => {
      const body = retentionShorteningEmail("o@example.com", { ...withIds, appOrigin: undefined }).textBody;
      expect(body).toContain("/p/0190a000-0000-7000-8000-00000000000a/reports");
      expect(body).not.toContain("http");
    });

    it("R1 · a project named in two sections is linked once", () => {
      const line = withIds.raw.projects[0]!;
      const section = { from: 730 as number | null, to: 395 as number | null, cutoff: new Date("2026-08-13T09:30:00.000Z"), projects: [line] };
      const body = retentionShorteningEmail("o@example.com", { ...withIds, rollups: section }).textBody;
      expect(body.match(/\/reports/g)).toHaveLength(1);
    });
  });

  // Review round 2 (minor): the sweep keeps expiring data under the REPLACED plan's window during the deferral, so the notice
  // may not claim "nothing is deleted" outright; it promises only that this change deletes nothing before the date.
  it("R1 · the deferral promise is exact: this change deletes nothing before the date, and data the old plan already expired still goes", () => {
    const body = retentionShorteningEmail("o@example.com", base).textBody;
    expect(body).not.toMatch(/nothing is deleted before/i);
    expect(body).toMatch(/because of this change/i);
    expect(body).toMatch(/previous plan/i);
    expect(body).toContain("2026-11-11");
  });

  // Review round 2 (major): Starter and Free have exports.csv=false and exports.pdf_per_cycle=0, so the export the email names
  // would be refused. The email says so plainly rather than offering it.
  it("R1 · a new plan with no export says so plainly and does not offer the report export", () => {
    const body = retentionShorteningEmail("o@example.com", { ...base, newPlanExports: { csv: false, pdfPerCycle: 0 } }).textBody;
    expect(body).not.toMatch(/with the report export/i);
    expect(body).toMatch(/Starter plan does not include data export/i);
    expect(body).toMatch(/longer window/i);
  });

  it("R1 · a new plan with only a PDF quota names the PDF and its quota, not CSV", () => {
    const body = retentionShorteningEmail("o@example.com", { ...base, newPlanExports: { csv: false, pdfPerCycle: 25 } }).textBody;
    expect(body).toMatch(/PDF report export/i);
    expect(body).toContain("25");
    expect(body).not.toMatch(/CSV/);
  });

  it("R1 · a new plan with only CSV names CSV, not PDF", () => {
    const body = retentionShorteningEmail("o@example.com", { ...base, newPlanExports: { csv: true, pdfPerCycle: 0 } }).textBody;
    expect(body).toMatch(/CSV report export/i);
    expect(body).not.toMatch(/PDF/);
  });

  it("R1 · says charts and milestones outlive the raw text", () => {
    const body = retentionShorteningEmail("o@example.com", base).textBody;
    expect(body).toMatch(/rollups|charts/i);
    expect(body).toMatch(/milestones/i);
  });

  it("R1 · nothing older than the new window: says so rather than listing nothing", () => {
    const body = retentionShorteningEmail("o@example.com", { ...base, raw: { ...base.raw, projects: [] } }).textBody;
    expect(body).toMatch(/no existing .* older than/i);
  });

  // Review round 1 (minor): the rollup window also removes attribution_daily and the derived analyses, so the notice names them,
  // and the cutoff is a rolling one (the nightly job runs up to a day after the purge date).
  it("R1 · a rollup shortening also names the attribution chart data and the derived analyses that go with it", () => {
    const section = { from: 730 as number | "unlimited" | null, to: 395 as number | "unlimited" | null, cutoff: new Date("2026-08-13T00:00:00.000Z"), projects: [{ name: "Rollup Co", count: 2, oldest: new Date("2025-01-01T00:00:00.000Z"), newest: new Date("2025-01-02T00:00:00.000Z") }] };
    const attribution = { ...section, projects: [{ name: "Rollup Co", count: 4, oldest: new Date("2025-01-01T00:00:00.000Z"), newest: new Date("2025-01-04T00:00:00.000Z") }] };
    const body = retentionShorteningEmail("o@example.com", { ...base, raw: null, rollups: section, attribution }).textBody;
    expect(body).toContain("Rollup Co: 4 days, 2025-01-01 to 2025-01-04");
    expect(body).toMatch(/attribution/i);
    expect(body).toMatch(/geo analyses/i);
    expect(body).toMatch(/topic clusters/i);
  });

  it("R1 · the cutoff is worded as a rolling window: each later night removes one more day, so the list is 'as of' the purge date", () => {
    const body = retentionShorteningEmail("o@example.com", base).textBody;
    expect(body).toMatch(/as of 2026-11-11/i);
    expect(body).toMatch(/each later night/i);
  });

  it("R1 · names every project (no cap) and keeps the totals exact", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ name: `P${String(i)}`, count: 2, oldest: new Date("2025-01-01T00:00:00.000Z"), newest: new Date("2025-02-01T00:00:00.000Z") }));
    const body = retentionShorteningEmail("o@example.com", { ...base, raw: { ...base.raw, projects: many } }).textBody;
    expect(body).toContain("160");
    expect(body).not.toMatch(/and \d+ more/);
    expect(body).toContain("P79:");
  });

  it("R1 · the body carries no workspace id and no raw engine text (names, counts and dates only)", () => {
    const body = retentionShorteningEmail("o@example.com", base).textBody;
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});
