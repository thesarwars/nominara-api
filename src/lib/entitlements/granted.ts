// The ONE reading of "does this plan grant this entitlement", in TypeScript and in SQL, so the tool catalog, the plan gate and the unlocking-plan query cannot disagree.
//
// FAIL CLOSED. Granted is exactly: `true`, a number above 0, or a non-empty string other than "none" / "none_tools_only" (the plans reference's spellings of "not included":
// `engines.enabled` is "none_tools_only" on Free). Everything else is not granted: false, null, absent, 0, a negative, "", an object, an array.

const NOT_INCLUDED_STRINGS: ReadonlySet<string> = new Set(["", "none", "none_tools_only"]);

export function entitlementGranted(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") return !NOT_INCLUDED_STRINGS.has(value);
  return false;
}

/**
 * The same predicate as a SQL boolean expression over a jsonb value expression (for example `entitlements -> $1 -> 'value'`). `valueExpr` must be a fixed fragment written
 * in this codebase, never caller input: every caller passes a literal expression with its own bind parameters.
 */
export function grantedValueSql(valueExpr: string): string {
  return `(CASE jsonb_typeof(${valueExpr}) WHEN 'boolean' THEN (${valueExpr}) = 'true'::jsonb WHEN 'number' THEN ((${valueExpr}) #>> '{}')::numeric > 0 WHEN 'string' THEN ((${valueExpr}) #>> '{}') NOT IN ('', 'none', 'none_tools_only') ELSE false END)`;
}
