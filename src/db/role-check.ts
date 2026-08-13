import { fileURLToPath } from "node:url";
import { connect, requireDatabaseUrl } from "./client.js";
import { assertNotMigrationOwner, inspectConnectedRole } from "./roles.js";

async function main() {
  const client = await connect(requireDatabaseUrl());
  try {
    const info = await inspectConnectedRole(client);
    console.log(
      `session_user=${info.sessionUser} current_user=${info.currentUser} ` +
        `isMigrationOwner=${info.isMigrationOwner} isRuntimeRole=${info.isRuntimeRole}`,
    );
    await assertNotMigrationOwner(client);
    console.log("role check passed: connection is not the migration owner");
  } catch (error) {
    console.error(`role check failed: ${(error as Error).message}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
