import type { Client } from "pg";
import { MIGRATION_OWNER_ROLE, RUNTIME_ROLES } from "./conventions.js";

export interface ConnectedRoleInfo {
  sessionUser: string;
  currentUser: string;
  isMigrationOwner: boolean;
  isRuntimeRole: boolean;
}

/**
 * Inspects which role a live connection is actually authenticated and
 * executing as — the backstop for AC "the migration owner is never used by a
 * running service, asserted by connection-role inspection in the health
 * check."
 *
 * STORY-010 ships this as a plain function rather than scaffolding a partial
 * NestJS HealthModule: no HealthModule (or any NestJS app) exists yet in
 * this repo (only src/db/ and src/lib/ids/ do). A future HealthModule should
 * import inspectConnectedRole/assertNotMigrationOwner from here rather than
 * reimplementing the check.
 */
export async function inspectConnectedRole(client: Client): Promise<ConnectedRoleInfo> {
  const result = await client.query<{ session_user: string; current_user: string }>(
    "SELECT session_user, current_user",
  );
  const row = result.rows[0]!;
  const sessionUser = row.session_user;
  const currentUser = row.current_user;
  return {
    sessionUser,
    currentUser,
    // SET ROLE can make current_user diverge from session_user, so both are
    // checked — either one being the migration owner is disqualifying.
    isMigrationOwner: sessionUser === MIGRATION_OWNER_ROLE || currentUser === MIGRATION_OWNER_ROLE,
    isRuntimeRole: (RUNTIME_ROLES as readonly string[]).includes(currentUser),
  };
}

export class MigrationOwnerConnectionError extends Error {
  constructor(info: ConnectedRoleInfo) {
    super(
      `connection is using the migration owner role (${MIGRATION_OWNER_ROLE}) — ` +
        `session_user=${info.sessionUser} current_user=${info.currentUser}. ` +
        `${MIGRATION_OWNER_ROLE} is NOLOGIN and must never be used by a running service.`,
    );
    this.name = "MigrationOwnerConnectionError";
  }
}

/** Throws MigrationOwnerConnectionError if `client` is connected as the migration owner. */
export async function assertNotMigrationOwner(client: Client): Promise<ConnectedRoleInfo> {
  const info = await inspectConnectedRole(client);
  if (info.isMigrationOwner) {
    throw new MigrationOwnerConnectionError(info);
  }
  return info;
}
