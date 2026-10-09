// NEW-A-14 — api-specification §7's `engines` query: a comma list of engine
// keys, or `all`. It NARROWS the project's entitled set and nothing else.

/** `null` means "no narrowing" — absent, or `all`. */
export function parseEngineFilter(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  const keys = raw.split(",").map((key) => key.trim()).filter((key) => key.length > 0);
  return keys.length === 0 || keys.includes("all") ? null : keys;
}

/**
 * The requested engines that the project is entitled to.
 *
 * An unentitled key is DROPPED, not honoured: the filter can only remove
 * engines from the entitled set, so a request naming only unentitled engines
 * yields an empty set rather than widening to the full one. `null` requested
 * keeps the whole entitled set.
 */
export function narrowToEntitled(requested: readonly string[] | null, entitled: readonly string[]): string[] {
  if (requested === null) return [...entitled];
  const allowed = new Set(entitled);
  return [...new Set(requested)].filter((key) => allowed.has(key));
}
