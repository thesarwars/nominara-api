// Documented reset path (STORY-006 acceptance criteria): drops everything
// this project owns and rebuilds from empty via the normal migration path.
//
// STORY-004 AC7 — `pnpm db:reset --seed` goes on to re-apply the local role
// passwords (`pnpm db:dev-credentials`) and the synthetic seed (`pnpm db:seed`,
// behind its own guard), so one command takes a half-migrated local database
// back to the state `pnpm dev:up` leaves it in. Without the flag it behaves
// exactly as before.
import { fileURLToPath } from "node:url";
import { connect } from "./client.js";
import { applyDevCredentials } from "./dev-credentials.js";
import { resetDatabase } from "./reset-database.js";
import { runSeedCli } from "./seed.js";
import { assertSyntheticSeedAllowed, SYNTHETIC_SEED_OPT_IN } from "./seed/synthetic/guard.js";

/** `pnpm db:reset [--seed]`. Exported (with `env`) so the refuse-before-drop ordering is tested against a real database. */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const unknown = argv.filter((arg) => arg !== "--seed");
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(" ")} (only --seed is accepted)`);
  const seed = argv.includes("--seed");
  if (seed) {
    // Refused BEFORE anything is dropped: a --seed that cannot seed must not leave an empty database behind.
    assertSyntheticSeedAllowed({
      nodeEnv: env.NODE_ENV,
      databaseUrl: env.DATABASE_URL,
      databaseUrlPooled: env.DATABASE_URL_POOLED,
      optIn: env[SYNTHETIC_SEED_OPT_IN],
    });
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  const client = await connect(databaseUrl);
  try {
    const applied = await resetDatabase(client);
    console.log(`reset complete, applied ${applied} migration(s)`);
    if (seed) {
      await applyDevCredentials(client);
      console.log("local role passwords re-applied");
    }
  } finally {
    await client.end();
  }
  if (seed) await runSeedCli(env);
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
