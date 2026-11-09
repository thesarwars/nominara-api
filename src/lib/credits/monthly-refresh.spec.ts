import { describe, expect, it } from "vitest";
import { annualWindow, calendarMonthWindow } from "./monthly-refresh.js";

// STORY-177 — the monthly windows. Pure date arithmetic on UTC `YYYY-MM-DD` strings; no JS Date stands in for a `date`
// column's day.
describe("STORY-177 · monthly windows", () => {
  it("[STORY-177 AC1] a free wallet's window is the calendar month containing today", () => {
    expect(calendarMonthWindow("2026-11-06")).toEqual({ start: "2026-11-01", end: "2026-12-01" });
    expect(calendarMonthWindow("2026-12-31")).toEqual({ start: "2026-12-01", end: "2027-01-01" });
    expect(calendarMonthWindow("2026-11-01")).toEqual({ start: "2026-11-01", end: "2026-12-01" });
  });

  it("[STORY-177 AC1] an annual wallet's window is anniversary-day based on the subscription's period start", () => {
    expect(annualWindow("2026-01-15", "2026-02-20")).toEqual({ start: "2026-02-15", end: "2026-03-15" });
    expect(annualWindow("2026-01-15", "2026-02-15")).toEqual({ start: "2026-02-15", end: "2026-03-15" });
    expect(annualWindow("2026-01-15", "2026-02-14")).toEqual({ start: "2026-01-15", end: "2026-02-15" });
  });

  it("[STORY-177 AC1] the anniversary day clamps to a short month and comes back afterwards", () => {
    expect(annualWindow("2026-01-31", "2026-03-01")).toEqual({ start: "2026-02-28", end: "2026-03-31" });
    expect(annualWindow("2026-01-31", "2026-03-31")).toEqual({ start: "2026-03-31", end: "2026-04-30" });
  });

  it("[STORY-177 AC1] day one of the period is month zero, never a roll", () => {
    expect(annualWindow("2026-01-15", "2026-01-15")).toEqual({ start: "2026-01-15", end: "2026-02-15" });
  });

  it("[STORY-177 AC4] the window is clamped to the eleventh month: the twelfth boundary is Stripe's renewal", () => {
    expect(annualWindow("2026-01-15", "2026-12-20")).toEqual({ start: "2026-12-15", end: "2027-01-15" });
    // Past the period end with no renewal seen: still the eleventh window, so this job never rolls into month twelve.
    expect(annualWindow("2026-01-15", "2027-01-16")).toEqual({ start: "2026-12-15", end: "2027-01-15" });
    expect(annualWindow("2026-01-15", "2028-06-01")).toEqual({ start: "2026-12-15", end: "2027-01-15" });
  });
});
