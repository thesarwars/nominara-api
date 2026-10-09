import { describe, expect, it } from "vitest";
import { isDayValidFor, nextSendAt, type ScheduleSpec } from "../../../src/lib/reports/next-send-at.js";

// NEW-E-100c — STORY-100 scenario 7: a schedule fires at the chosen day and the
// WORKSPACE-LOCAL hour, for each cadence. The computation is pure, so it is
// proved here without a database; Postgres only stores the answer.
//
// 2026-10-05 is a Monday (ISO weekday 1); 2026-10-08 is a Thursday.

const at = (iso: string): Date => new Date(iso);
const spec = (over: Partial<ScheduleSpec>): ScheduleSpec => ({ cadence: "weekly", day: 3, hour: 9, timezone: "UTC", ...over });
const iso = (d: Date): string => d.toISOString();

describe("NEW-E-100c · STORY-100 s7 · next_send_at at each cadence", () => {
  it("s7 weekly · the next chosen weekday at the chosen hour", () => {
    expect(iso(nextSendAt(spec({ cadence: "weekly", day: 3, hour: 9 }), at("2026-10-05T10:00:00Z")))).toBe("2026-10-07T09:00:00.000Z");
  });

  it("s7 weekly · strictly after: at the exact fire instant the next one is a week later", () => {
    expect(iso(nextSendAt(spec({ day: 3, hour: 9 }), at("2026-10-07T09:00:00Z")))).toBe("2026-10-14T09:00:00.000Z");
    expect(iso(nextSendAt(spec({ day: 3, hour: 9 }), at("2026-10-07T08:59:59Z")))).toBe("2026-10-07T09:00:00.000Z");
  });

  it("s7 weekly · the hour is WORKSPACE-LOCAL (Asia/Dhaka is UTC+6, no DST)", () => {
    expect(iso(nextSendAt(spec({ day: 1, hour: 8, timezone: "Asia/Dhaka" }), at("2026-10-05T00:00:00Z")))).toBe("2026-10-05T02:00:00.000Z");
  });

  it("s7 weekly · the hour stays local across a DST change (New York, EDT then EST)", () => {
    expect(iso(nextSendAt(spec({ day: 3, hour: 9, timezone: "America/New_York" }), at("2026-10-05T00:00:00Z")))).toBe("2026-10-07T13:00:00.000Z");
    // DST ended Sunday 2026-11-01; Monday 09:00 is now EST (UTC-5).
    expect(iso(nextSendAt(spec({ day: 1, hour: 9, timezone: "America/New_York" }), at("2026-10-31T00:00:00Z")))).toBe("2026-11-02T14:00:00.000Z");
  });

  it("s7 weekly · the local weekday, not the UTC one, decides (Pacific/Auckland is a day ahead of UTC)", () => {
    // 2026-10-05T20:00Z is already Tuesday 09:00 in Auckland (NZDT, UTC+13): the next local Monday 08:00 is a week on.
    expect(iso(nextSendAt(spec({ day: 1, hour: 8, timezone: "Pacific/Auckland" }), at("2026-10-05T20:00:00Z")))).toBe("2026-10-11T19:00:00.000Z");
  });

  it("s7 biweekly · the next chosen weekday at the chosen hour (the runner spaces repeats a fortnight apart)", () => {
    expect(iso(nextSendAt(spec({ cadence: "biweekly", day: 5, hour: 6 }), at("2026-10-05T10:00:00Z")))).toBe("2026-10-09T06:00:00.000Z");
  });

  it("s7 monthly · the chosen day of the month at the local hour, this month or next", () => {
    expect(iso(nextSendAt(spec({ cadence: "monthly", day: 15, hour: 6 }), at("2026-10-10T00:00:00Z")))).toBe("2026-10-15T06:00:00.000Z");
    expect(iso(nextSendAt(spec({ cadence: "monthly", day: 15, hour: 6 }), at("2026-10-16T00:00:00Z")))).toBe("2026-11-15T06:00:00.000Z");
  });

  it("s7 monthly · day 28 exists in every month, including February; December rolls into the next year", () => {
    expect(iso(nextSendAt(spec({ cadence: "monthly", day: 28, hour: 0 }), at("2027-01-29T00:00:00Z")))).toBe("2027-02-28T00:00:00.000Z");
    expect(iso(nextSendAt(spec({ cadence: "monthly", day: 10, hour: 0 }), at("2026-12-11T00:00:00Z")))).toBe("2027-01-10T00:00:00.000Z");
  });

  it("s7 quarterly · the chosen day of the first month of a quarter (Jan, Apr, Jul, Oct)", () => {
    expect(iso(nextSendAt(spec({ cadence: "quarterly", day: 10, hour: 7 }), at("2026-10-09T00:00:00Z")))).toBe("2026-10-10T07:00:00.000Z");
    expect(iso(nextSendAt(spec({ cadence: "quarterly", day: 10, hour: 7 }), at("2026-10-11T00:00:00Z")))).toBe("2027-01-10T07:00:00.000Z");
    expect(iso(nextSendAt(spec({ cadence: "quarterly", day: 1, hour: 7 }), at("2027-01-02T00:00:00Z")))).toBe("2027-04-01T07:00:00.000Z");
  });

  it("s7 DST gap · an hour that does not exist locally moves to the first instant after the gap, never skipped", () => {
    // US spring-forward 2027-03-14: 02:00 EST does not exist; 03:00 EDT = 07:00Z.
    expect(iso(nextSendAt(spec({ cadence: "monthly", day: 14, hour: 2, timezone: "America/New_York" }), at("2027-03-01T00:00:00Z")))).toBe("2027-03-14T07:00:00.000Z");
  });

  it("s7 DST overlap · an hour that occurs twice fires once, at its first occurrence", () => {
    // US fall-back 2026-11-01: 01:00 happens at 05:00Z (EDT) and 06:00Z (EST).
    expect(iso(nextSendAt(spec({ cadence: "monthly", day: 1, hour: 1, timezone: "America/New_York" }), at("2026-10-15T00:00:00Z")))).toBe("2026-11-01T05:00:00.000Z");
  });

  it("s7 · the result is always strictly after the instant given, for every cadence and hour", () => {
    const after = at("2026-10-08T12:34:56Z");
    for (const cadence of ["weekly", "biweekly", "monthly", "quarterly"] as const) {
      for (let hour = 0; hour < 24; hour += 1) {
        const next = nextSendAt(spec({ cadence, day: 1, hour, timezone: "Europe/Berlin" }), after);
        expect(next.getTime()).toBeGreaterThan(after.getTime());
      }
    }
  });

  it("s7 · a day outside the cadence's range is refused rather than silently moved", () => {
    expect(() => nextSendAt(spec({ cadence: "weekly", day: 8 }), at("2026-10-05T00:00:00Z"))).toThrow(RangeError);
    expect(() => nextSendAt(spec({ cadence: "monthly", day: 29 }), at("2026-10-05T00:00:00Z"))).toThrow(RangeError);
    expect(() => nextSendAt(spec({ cadence: "monthly", day: 15, hour: 24 }), at("2026-10-05T00:00:00Z"))).toThrow(RangeError);
  });

  it("s7 · day ranges per cadence: weekday 1-7 for weekly/biweekly, day of month 1-28 otherwise", () => {
    expect([isDayValidFor("weekly", 0), isDayValidFor("weekly", 1), isDayValidFor("weekly", 7), isDayValidFor("weekly", 8)]).toEqual([false, true, true, false]);
    expect([isDayValidFor("biweekly", 7), isDayValidFor("biweekly", 8)]).toEqual([true, false]);
    expect([isDayValidFor("monthly", 28), isDayValidFor("monthly", 29), isDayValidFor("quarterly", 1), isDayValidFor("quarterly", 0)]).toEqual([true, false, true, false]);
  });
});

describe("NEW-E-100c · s7 · half-hour zones", () => {
  it("s7 · Asia/Kolkata (UTC+5:30) fires at the local hour, not an hour off", () => {
    expect(iso(nextSendAt(spec({ day: 1, hour: 9, timezone: "Asia/Kolkata" }), at("2026-10-05T00:00:00Z")))).toBe("2026-10-05T03:30:00.000Z");
  });
});
