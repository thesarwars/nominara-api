// STORY-078 AC6 - `expires_at` is set AT INSERT from the plan's retention, never computed at read time.
//
// BUILDER READING (owner to confirm; see the story's open question): the references say a tool snapshot is "retained for the tier's
// window" (plans-and-entitlements.md section 3) and name no key of its own. The window read here is `retention.raw_captures_days`: it
// is the only retention key every tier carries (Free's `retention.rollups_days` is null, which would mean a Free snapshot has no
// window), and a snapshot holds the same kind of content a raw capture does (answer excerpts). One constant, one place to change.
export const TOOL_SNAPSHOT_RETENTION_KEY = "retention.raw_captures_days";

const DAY_MS = 86_400_000;

type Entitlements = Readonly<Record<string, { readonly value: unknown } | undefined>>;

export function toolSnapshotExpiresAt(entitlements: Entitlements, now: Date): Date {
  const days = entitlements[TOOL_SNAPSHOT_RETENTION_KEY]?.value;
  if (typeof days !== "number" || !Number.isInteger(days) || days <= 0) {
    // Fail closed. A missing or non-numeric window must not mint a snapshot that never expires, or one that expires at once.
    throw new Error(`plan has no usable tool snapshot retention (${TOOL_SNAPSHOT_RETENTION_KEY} is ${JSON.stringify(days) ?? "absent"})`);
  }
  return new Date(now.getTime() + days * DAY_MS);
}
