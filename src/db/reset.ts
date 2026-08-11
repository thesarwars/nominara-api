// Documented reset path (STORY-006 acceptance criteria): drops everything
// this project owns and rebuilds from empty via the normal migration path.
import { connect, requireDatabaseUrl } from "./client.js";
import { migrateUp } from "./migrate-runner.js";

const client = await connect(requireDatabaseUrl());
try {
  await client.query("DROP SCHEMA IF EXISTS app CASCADE");
  await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");

  const applied = await migrateUp(client);
  console.log(`reset complete, applied ${applied.length} migration(s)`);
} finally {
  await client.end();
}
