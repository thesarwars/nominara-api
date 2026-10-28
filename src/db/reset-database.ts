import type { Client } from "pg";
import { migrateUp } from "./migrate-runner.js";

// STORY-006's documented reset path, extracted from src/db/reset.ts by
// STORY-004 (AC7, test scenario 5) so the drop-and-rebuild is one function a
// test can call against a real database: drops everything this project owns
// (the `app` and `_migrations` schemas and all of `public`) and rebuilds from
// empty through the normal migration path. Runtime ROLES are cluster-level and
// survive; their passwords are re-applied by `applyDevCredentials`.
// Returns the number of migrations applied.
export async function resetDatabase(client: Client): Promise<number> {
  await client.query("DROP SCHEMA IF EXISTS app CASCADE");
  await client.query("DROP SCHEMA IF EXISTS _migrations CASCADE");
  await client.query("DROP SCHEMA public CASCADE");
  await client.query("CREATE SCHEMA public");
  const applied = await migrateUp(client);
  return applied.length;
}
