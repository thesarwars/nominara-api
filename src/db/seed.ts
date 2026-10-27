import { fileURLToPath } from "node:url";
import { loadEnv } from "../config/env.js";
import { LocalDekProvisioner } from "../modules/workspaces/adapters/local-dek-provisioner.js";
import { describeTarget } from "./local-target.js";
import { createPgPool } from "./pg-pool.js";
import { SYNTHETIC_TENANTS } from "./seed/synthetic/constants.js";
import { assertSyntheticSeedAllowed, SYNTHETIC_SEED_OPT_IN } from "./seed/synthetic/guard.js";
import { planSetViaCli } from "./seed/synthetic/plan-set-cli.js";
import { runSyntheticSeed } from "./seed/synthetic/seed-tenants.js";

// STORY-004 AC5 — `pnpm db:seed`: the three awkward synthetic tenants
// (src/db/seed/synthetic/constants.ts). Dev-only and idempotent: run it as
// often as you like; a second run writes nothing.
//
// Usage (`pnpm dev:up` runs this for you with the right environment):
//   NOMINARA_SYNTHETIC_SEED=1 pnpm db:seed
//
// It needs the full API environment (the DEK wrapping key; `plan:set`, which
// it runs, loads the whole config) and refuses unless NODE_ENV is not
// production, DATABASE_URL and DATABASE_URL_POOLED both name a local host,
// and NOMINARA_SYNTHETIC_SEED=1 (src/db/seed/synthetic/guard.ts). Every write
// goes through DATABASE_URL_POOLED; DATABASE_URL is only checked, never used.

export async function runSeedCli(env: NodeJS.ProcessEnv = process.env, log: (line: string) => void = (line) => process.stdout.write(`${line}\n`)): Promise<void> {
  assertSyntheticSeedAllowed({
    nodeEnv: env.NODE_ENV,
    databaseUrl: env.DATABASE_URL,
    databaseUrlPooled: env.DATABASE_URL_POOLED,
    optIn: env[SYNTHETIC_SEED_OPT_IN],
  });
  // The local-host check is by NAME only (local-target.ts): print what the names resolve to before any write.
  log(`DATABASE_URL_POOLED resolves to ${describeTarget(env.DATABASE_URL_POOLED ?? "")}`);

  const config = loadEnv(env);
  const dekProvisioner = new LocalDekProvisioner(Buffer.from(config.WORKSPACE_DEK_WRAPPING_KEY, "base64"), config.WORKSPACE_KMS_KEY_ARN);
  const pool = createPgPool(config.DATABASE_URL_POOLED);
  try {
    await runSyntheticSeed({ pool, dekProvisioner, setPlan: planSetViaCli(env), log });
  } finally {
    await pool.end();
  }
  log("synthetic tenants ready. Sign in with email OTP (OTP_DEV_LOG_CODES=true logs the code):");
  for (const tenant of SYNTHETIC_TENANTS) {
    log(`  ${tenant.ownerEmail}  ->  ${tenant.name} (${tenant.planKey})`);
  }
}

if (process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  runSeedCli().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
