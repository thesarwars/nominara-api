// STORY-010: sets local-development passwords on the runtime + break-glass
// roles created by 0005_roles_grants_and_pooling.up.sql. That migration
// itself NEVER sets a password (see its header) — passwords are always a
// separate, out-of-band step, sourced from environment variables here.
//
// Defaults match docker/pgbouncer/userlist.txt's LOCAL-DEVELOPMENT-ONLY
// entries, so `pnpm db:dev-credentials` + `docker compose up` work together
// out of the box. Override any of them via env for a different local setup.
// Production issues credentials via Secrets Manager with 30-day rotation
// (NFR-SEC-16) — this script has no production path and does not attempt one
// (disclosed gap G-2).
import { fileURLToPath } from "node:url";
import type { ClientBase } from "pg";
import { BREAKGLASS_ROLE, RUNTIME_ROLES } from "./conventions.js";
import { connect, requireDatabaseUrl } from "./client.js";

// Exported (not module-private) so test fixtures — e.g.
// test/support/pgbouncer-fixture.ts, which must authenticate through
// pgBouncer's checked-in userlist.txt — can derive the exact same values
// rather than retyping a second copy that could drift.
export const DEFAULT_PASSWORDS: Readonly<Record<string, string>> = {
  nominara_app: "nominara_app_dev_local",
  nominara_worker: "nominara_worker_dev_local",
  nominara_report: "nominara_report_dev_local",
  nominara_portal: "nominara_portal_dev_local",
  [BREAKGLASS_ROLE]: "nominara_breakglass_dev_local",
};

function envVarName(role: string): string {
  return `${role.toUpperCase()}_DB_PASSWORD`;
}

export function resolvePassword(role: string, env: NodeJS.ProcessEnv = process.env): string {
  return env[envVarName(role)] ?? DEFAULT_PASSWORDS[role]!;
}

/**
 * Sets every runtime + break-glass role's local password. Returns the roles
 * it set. Exported (STORY-004) so `pnpm db:reset --seed` and the reset test
 * apply the exact same step as `pnpm db:dev-credentials`.
 */
export async function applyDevCredentials(client: ClientBase, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const roles = [...RUNTIME_ROLES, BREAKGLASS_ROLE];
  for (const role of roles) {
    const password = resolvePassword(role, env);
    // client.escapeLiteral, not hand-rolled quote-doubling: the latter is
    // exactly the string-concatenation-into-SQL pattern the coding
    // standards ban, and breaks under non-default standard_conforming_strings.
    await client.query(`ALTER ROLE ${role} PASSWORD ${client.escapeLiteral(password)}`);
  }
  return roles;
}

async function main() {
  const client = await connect(requireDatabaseUrl());
  try {
    for (const role of await applyDevCredentials(client)) {
      console.log(`set local dev password for ${role}`);
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
