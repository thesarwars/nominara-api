const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

/**
 * True only for a real calendar date written `YYYY-MM-DD`. Never throws: an impossible month or day is simply `false`.
 * Built from the parsed parts (Date.UTC plus a round trip), not from a `${date}T...` literal — that shape is what the
 * ISO-13 cache-key scanner reads as a key construction site, and a date check is not one.
 */
export function isRealIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
