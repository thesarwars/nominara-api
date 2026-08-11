import { fileURLToPath } from "node:url";
import type { Client } from "pg";
import { INTERNAL_SCHEMA, REQUIRED_EXTENSIONS, REQUIRED_INTERNAL_FUNCTIONS } from "./conventions.js";
import { MIGRATIONS_DIR, migrateUp } from "./migrate-runner.js";
import { connect, requireDatabaseUrl } from "./client.js";

export interface DriftResult {
  missingExtensions: string[];
  missingFunctions: string[];
}

export function isClean(result: DriftResult): boolean {
  return result.missingExtensions.length === 0 && result.missingFunctions.length === 0;
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

  return { missingExtensions, missingFunctions };
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
    process.exit(1);
  }

  console.log("drift check passed: shadow database matches conventions.ts");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
