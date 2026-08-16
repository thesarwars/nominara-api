import { GENERATED_MIGRATION_NAME } from "../../../src/db/rls/generate.js";

// STORY-012 T24 · D-6 — the RUNNER-SIDE capability only (no CI exists in
// this repo yet — gap G-5, unchanged; disclosing new gap G-9: nothing
// schedules this nightly). ISOLATION_TARGET=staging must run ONLY the
// read-only, fixture-independent assertion set, and must refuse to proceed
// at all if pointed at a database this suite's own migration chain didn't
// create — recognized by the presence of the bootstrap migration AND the
// generated RLS migration (0006) in `_migrations.applied`, never by trusting
// an operator-supplied flag alone.

export const REQUIRED_RECOGNITION_MIGRATIONS = ["0001_extensions_and_conventions", GENERATED_MIGRATION_NAME] as const;

export interface StagingConnectionTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly superuser: { readonly user: string; readonly password: string };
}

/**
 * Parses ISOLATION_STAGING_DATABASE_URL into the connection shape the rest
 * of the suite needs — CREDENTIALS COME FROM THE URL, never from a
 * hardcoded local-development pair. A URL missing user/password is refused
 * rather than silently falling back to a default that could never actually
 * authenticate against a real staging database.
 */
export function parseStagingTarget(url: string): StagingConnectionTarget {
  const parsed = new URL(url);
  const user = decodeURIComponent(parsed.username);
  const password = decodeURIComponent(parsed.password);
  if (!user || !password) {
    throw new Error(
      "ISOLATION_STAGING_DATABASE_URL must include credentials (postgres://user:password@host:port/db) — refusing to fall back to local defaults for staging.",
    );
  }
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 5432),
    database: parsed.pathname.replace(/^\//, ""),
    superuser: { user, password },
  };
}

export class UnrecognizedStagingDatabaseError extends Error {
  constructor(missing: readonly string[]) {
    super(
      `ISOLATION_TARGET=staging refuses to proceed: the target database is missing migration(s) [${missing.join(", ")}] ` +
        "in _migrations.applied — this suite only runs against a database its own migration chain created.",
    );
    this.name = "UnrecognizedStagingDatabaseError";
  }
}

/** Throws UnrecognizedStagingDatabaseError unless every required migration name is present. */
export function assertRecognizedStagingDatabase(appliedMigrationNames: ReadonlySet<string>): void {
  const missing = REQUIRED_RECOGNITION_MIGRATIONS.filter((name) => !appliedMigrationNames.has(name));
  if (missing.length > 0) {
    throw new UnrecognizedStagingDatabaseError(missing);
  }
}
