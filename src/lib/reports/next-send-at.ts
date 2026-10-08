// NEW-E-100c — STORY-100 scenario 7. When a scheduled report next fires: the
// chosen day-of-period at the chosen WORKSPACE-LOCAL hour. Pure, with no
// dependency: the zone arithmetic is Intl, so it uses the same tz database
// Postgres does.
//
//   weekly / biweekly  `day` is the ISO weekday, 1 (Mon) - 7 (Sun). The first
//                      fire is the next such weekday; the runner spaces a
//                      biweekly report's repeats a fortnight apart.
//   monthly            `day` is the day of the month, 1-28 (every month has it).
//   quarterly          `day` is the day of the month, in Jan, Apr, Jul, Oct.
//
// DST: a local hour that does not exist (spring-forward gap) fires at the first
// instant after the gap rather than being skipped; one that occurs twice
// (fall-back) fires at its first occurrence, once.

export type ScheduleCadence = "weekly" | "biweekly" | "monthly" | "quarterly";

export interface ScheduleSpec {
  readonly cadence: ScheduleCadence;
  readonly day: number;
  readonly hour: number;
  readonly timezone: string;
}

export function isDayValidFor(cadence: ScheduleCadence, day: number): boolean {
  if (!Number.isInteger(day)) return false;
  return cadence === "weekly" || cadence === "biweekly" ? day >= 1 && day <= 7 : day >= 1 && day <= 28;
}

interface Wall {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallOf(ms: number, timezone: string): Wall {
  let f = formatters.get(timezone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(timezone, f);
  }
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { y: parts.year!, m: parts.month!, d: parts.day!, h: parts.hour!, min: parts.minute! };
}

function offsetMs(ms: number, timezone: string): number {
  const w = wallOf(ms, timezone);
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.min) - Math.floor(ms / 60_000) * 60_000;
}

const sameWall = (a: Wall, b: Wall): boolean => a.y === b.y && a.m === b.m && a.d === b.d && a.h === b.h && a.min === b.min;

/** The UTC instant of a local wall-clock hour (see the DST note above). */
function wallToUtc(w: Wall, timezone: string): number {
  const naive = Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);
  const candidates = [...new Set([naive - offsetMs(naive - 86_400_000, timezone), naive - offsetMs(naive + 86_400_000, timezone)])];
  const valid = candidates.filter((c) => sameWall(wallOf(c, timezone), w));
  return valid.length > 0 ? Math.min(...valid) : Math.max(...candidates);
}

export function nextSendAt(spec: ScheduleSpec, after: Date): Date {
  if (!isDayValidFor(spec.cadence, spec.day)) throw new RangeError(`day ${String(spec.day)} is out of range for a ${spec.cadence} schedule`);
  if (!Number.isInteger(spec.hour) || spec.hour < 0 || spec.hour > 23) throw new RangeError(`hour ${String(spec.hour)} is out of range 0-23`);
  const start = wallOf(after.getTime(), spec.timezone);
  const weekly = spec.cadence === "weekly" || spec.cadence === "biweekly";
  // A quarterly schedule can be up to ~92 days away; 400 covers every cadence.
  for (let i = 0; i <= 400; i += 1) {
    const date = new Date(Date.UTC(start.y, start.m - 1, start.d + i));
    const isoWeekday = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
    const matches = weekly
      ? isoWeekday === spec.day
      : date.getUTCDate() === spec.day && (spec.cadence === "monthly" || date.getUTCMonth() % 3 === 0);
    if (!matches) continue;
    const at = wallToUtc({ y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate(), h: spec.hour, min: 0 }, spec.timezone);
    if (at > after.getTime()) return new Date(at);
  }
  throw new Error("no next send instant within 400 days");
}
