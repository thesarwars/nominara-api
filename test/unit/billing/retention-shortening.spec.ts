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
        { projectId: "0198a1f0-0000-7000-8000-000000000001", name: "Acme Site", count: 120, oldest: new Date("2025-10-01T00:00:00.000Z"), newest: new Date("2026-08-12T00:00:00.000Z") },
        { projectId: "0198a1f0-0000-7000-8000-000000000002", name: "Acme Blog", count: 1, oldest: new Date("2026-01-01T00:00:00.000Z"), newest: new Date("2026-01-01T00:00:00.000Z") },
      ],
    },
    rollups: null,
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

  // Owner decision 2026-10-27 #7: the report export is metric_daily capped at 90 days, so it cannot contain any purged item.
  // The notice states what is purged and when; it offers no export and links no reports page, whatever the new plan allows.
  describe("R1 · no export offer (owner decision 2026-10-27 #7)", () => {
    const withIds = {
      ...base,
      raw: {
        ...base.raw,
        projects: [
          { projectId: "0198a1f0-0000-7000-8000-000000000003", name: "Acme Site", count: 120, oldest: new Date("2025-10-01T00:00:00.000Z"), newest: new Date("2026-08-12T00:00:00.000Z") },
          { projectId: "0198a1f0-0000-7000-8000-000000000004", name: "Gone (deleted project)", count: 2, oldest: new Date("2025-10-01T00:00:00.000Z"), newest: new Date("2025-10-02T00:00:00.000Z") },
        ],
      },
    };
    // The template takes no export input, so these pairs pin only the wording; whether the new plan's
    // entitlements leak an offer is pinned by the integration Enterprise -> Business case.
    const planPairs: ReadonlyArray<readonly [string, string]> = [
      ["Business", "Growth"],
      ["Enterprise", "Business"],
      ["Growth", "Starter"],
      ["Business", "Free"],
    ];
    for (const [fromPlanName, toPlanName] of planPairs) {
      it(`R1 · ${fromPlanName} to ${toPlanName}: no export sentence and no reports link, but the purge list and date stay`, () => {
        const section = { from: 730 as number | null, to: 395 as number | null, cutoff: new Date("2026-08-13T09:30:00.000Z"), projects: [withIds.raw.projects[0]!] };
        const body = retentionShorteningEmail("o@example.com", { ...withIds, fromPlanName, toPlanName, rollups: section }).textBody;
        expect(body).not.toMatch(/export/i);
        expect(body).not.toMatch(/to keep a copy/i);
        expect(body).not.toMatch(/support/i);
        expect(body).not.toContain("/reports");
        expect(body).not.toContain("http");
        expect(body).toContain("Acme Site: 120 captures, 2025-10-01 to 2026-08-12");
        expect(body).toContain("Gone (deleted project): 2 captures");
        expect(body).toContain("2026-11-11");
      });
    }
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
    const section = { from: 730 as number | "unlimited" | null, to: 395 as number | "unlimited" | null, cutoff: new Date("2026-08-13T00:00:00.000Z"), projects: [{ projectId: "0198a1f0-0000-7000-8000-000000000005", name: "Rollup Co", count: 2, oldest: new Date("2025-01-01T00:00:00.000Z"), newest: new Date("2025-01-02T00:00:00.000Z") }] };
    const attribution = { ...section, projects: [{ projectId: "0198a1f0-0000-7000-8000-000000000006", name: "Rollup Co", count: 4, oldest: new Date("2025-01-01T00:00:00.000Z"), newest: new Date("2025-01-04T00:00:00.000Z") }] };
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
    const many = Array.from({ length: 80 }, (_, i) => ({ projectId: `0198a1f0-0000-7000-8000-${String(i).padStart(12, "0")}`, name: `P${String(i)}`, count: 2, oldest: new Date("2025-01-01T00:00:00.000Z"), newest: new Date("2025-02-01T00:00:00.000Z") }));
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
