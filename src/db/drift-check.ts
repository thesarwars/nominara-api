import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { DATABASE_ROLES, DEFINER_OWNER_ROLES, INTERNAL_SCHEMA, REQUIRED_EXTENSIONS, REQUIRED_INTERNAL_FUNCTIONS } from "./conventions.js";
import { MIGRATIONS_DIR, migrateUp } from "./migrate-runner.js";
import { connect, requireDatabaseUrl } from "./client.js";

export interface DriftResult {
  missingExtensions: string[];
  missingFunctions: string[];
  // STORY-010 — additive to the STORY-006 shape above. missingRoles: a role
  // named in DATABASE_ROLES (src/db/conventions.ts) that migration 0005
  // should have created but pg_roles doesn't show. roleAttributeMismatches:
  // a role that exists but whose login/bypassrls/connection-limit attributes
  // don't match its DatabaseRoleSpec — e.g. hand-altered outside a migration.
  missingRoles: string[];
  roleAttributeMismatches: string[];
}

export function isClean(result: DriftResult): boolean {
  return (
    result.missingExtensions.length === 0 &&
    result.missingFunctions.length === 0 &&
    result.missingRoles.length === 0 &&
    result.roleAttributeMismatches.length === 0
  );
}

/**
 * Applies every committed migration to `client`'s database and compares the
 * resulting state against conventions.ts. `client` is expected to point at a
 * disposable shadow database — this function does not create or drop one.
 */
export async function checkDrift(client: Client, migrationsDir: string = MIGRATIONS_DIR): Promise<DriftResult> {
  await migrateUp(client, migrationsDir);

  const extResult = await client.query<{ extname: string }>("SELECT extname FROM pg_extension");
  const installedExtensions = new Set(extResult.rows.map((row) => row.extname));
  const missingExtensions = REQUIRED_EXTENSIONS.filter((ext) => !installedExtensions.has(ext));

  const fnResult = await client.query<{ proname: string }>(
    "SELECT proname FROM pg_proc WHERE pronamespace = $1::regnamespace",
    [INTERNAL_SCHEMA],
  );
  const installedFunctions = new Set(fnResult.rows.map((row) => row.proname));
  const missingFunctions = REQUIRED_INTERNAL_FUNCTIONS.filter((fn) => !installedFunctions.has(fn));

  const expectedRoles = { ...DATABASE_ROLES, ...DEFINER_OWNER_ROLES };
  const roleNames = Object.keys(expectedRoles);
  const roleResult = await client.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolbypassrls: boolean;
    rolconnlimit: number;
    rolinherit: boolean;
  }>(
    "SELECT rolname, rolcanlogin, rolbypassrls, rolconnlimit, rolinherit FROM pg_roles WHERE rolname = ANY($1::text[])",
    [roleNames],
  );
  const installedRoles = new Map(roleResult.rows.map((row) => [row.rolname, row]));

  const missingRoles = roleNames.filter((name) => !installedRoles.has(name));
  const roleAttributeMismatches: string[] = [];
  for (const [name, spec] of Object.entries(expectedRoles)) {
    const actual = installedRoles.get(name);
    if (!actual) {
      continue; // already reported in missingRoles
    }
    if (actual.rolcanlogin !== spec.login) {
      roleAttributeMismatches.push(
        `${name}: expected login=${spec.login}, got ${actual.rolcanlogin}`,
      );
    }
    if (actual.rolbypassrls !== spec.bypassrls) {
      roleAttributeMismatches.push(
        `${name}: expected bypassrls=${spec.bypassrls}, got ${actual.rolbypassrls}`,
      );
    }
    if (actual.rolconnlimit !== spec.connectionLimit) {
      roleAttributeMismatches.push(
        `${name}: expected connectionLimit=${spec.connectionLimit}, got ${actual.rolconnlimit}`,
      );
    }
    if (actual.rolinherit !== spec.inherit) {
      roleAttributeMismatches.push(
        `${name}: expected inherit=${spec.inherit}, got ${actual.rolinherit}`,
      );
    }
  }

  // ADR-0002: nobody may be a member of a definer-owner role. A membership would let that member run SET ROLE and
  // exercise the owner's policy and grants directly, not only through the function.
  const members = await client.query<{ role: string; member: string }>(
    `SELECT r.rolname AS role, m.rolname AS member
       FROM pg_auth_members am JOIN pg_roles r ON r.oid = am.roleid JOIN pg_roles m ON m.oid = am.member
      WHERE r.rolname = ANY($1::text[])`,
    [Object.keys(DEFINER_OWNER_ROLES)],
  );
  for (const row of members.rows) {
    roleAttributeMismatches.push(`${row.role}: expected no members, got member ${row.member}`);
  }

  return { missingExtensions, missingFunctions, missingRoles, roleAttributeMismatches };
}

async function main() {
  const maintenanceUrl = requireDatabaseUrl();
  const shadowDbName = `nominara_shadow_${Date.now()}`;
  const maintenance = await connect(maintenanceUrl);

  try {
    await maintenance.query(`CREATE DATABASE ${shadowDbName}`);
  } finally {
    await maintenance.end();
  }

  const shadowUrl = new URL(maintenanceUrl);
  shadowUrl.pathname = `/${shadowDbName}`;
  const shadow = await connect(shadowUrl.toString());

  let result: DriftResult;
  try {
    result = await checkDrift(shadow);
  } finally {
    await shadow.end();
    const cleanup = await connect(maintenanceUrl);
    try {
      await cleanup.query(`DROP DATABASE IF EXISTS ${shadowDbName}`);
    } finally {
      await cleanup.end();
    }
  }

  if (!isClean(result)) {
    console.error("drift check failed:");
    if (result.missingExtensions.length > 0) {
      console.error(`  missing extensions: ${result.missingExtensions.join(", ")}`);
    }
    if (result.missingFunctions.length > 0) {
      console.error(`  missing app-schema functions: ${result.missingFunctions.join(", ")}`);
    }
    if (result.missingRoles.length > 0) {
      console.error(`  missing roles: ${result.missingRoles.join(", ")}`);
    }
    if (result.roleAttributeMismatches.length > 0) {
      console.error(`  role attribute mismatches: ${result.roleAttributeMismatches.join("; ")}`);
    }
    process.exit(1);
  }

  console.log("drift check passed: shadow database matches conventions.ts");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
