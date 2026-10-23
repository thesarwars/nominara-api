// STORY-042 — `workspaces.timezone` is free text (no CHECK; PATCH /workspaces accepts any non-empty string), so a rollup path
// that reads it per tenant must prove the zone is real BEFORE `AT TIME ZONE`, or one bad value fails a statement that spans
// other tenants (the sweep) or a transaction that is not the tenant's to lose (a parse).

/** SQL boolean: the column names a zone Postgres' `AT TIME ZONE` accepts as an IANA name (its lookup ignores case). `column` is a trusted identifier, never user input. */
export function validTimezoneSql(column: string): string {
  return `EXISTS (SELECT 1 FROM pg_timezone_names tz WHERE lower(tz.name) = lower(${column}))`;
}
