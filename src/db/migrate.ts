import { connect, requireDatabaseUrl } from "./client.js";
import { migrateUp } from "./migrate-runner.js";

const client = await connect(requireDatabaseUrl());
try {
  const applied = await migrateUp(client);
  if (applied.length === 0) {
    console.log("nothing to migrate");
  } else {
    for (const name of applied) {
      console.log(`applied ${name}`);
    }
  }
} finally {
  await client.end();
}
