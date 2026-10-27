// STORY-004 AC3 — `pnpm dev:up`: one command from a clean clone to a running,
// seeded API (owner decision 2026-10-27 item 4). The app repository's
// `pnpm dev:stack` calls this, then starts the app against it.
//
//   1. install      `pnpm install --frozen-lockfile`, only when node_modules is absent
//   2. env          write .env from .env.example with locally generated secrets (never overwrites one)
//   3. start        `docker compose up -d --build --wait`: Postgres, pgBouncer, both Valkeys,
//                   then the one-shot migrate + dev-credentials services, then the API, the
//                   gateway and the workers, gated on the API's readiness probe
//   4. seed         `pnpm db:seed` on the host, against the stack's published ports: three
//                   awkward synthetic tenants (idempotent: a second run writes nothing)
//
// Everything compose reads is honoured as compose itself reads it: shell variables win over
// .env. So `COMPOSE_PROJECT_NAME=other POSTGRES_PORT=15432 ... pnpm dev:up` runs a second,
// independent stack, and the seed follows it to the moved ports.
//
// Flags: --no-seed (skip step 4), --no-build (start the last built image).
import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { composeHostUrls, ensureDevEnv, parseEnvText } from "./dev-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const unknown = args.filter((arg) => arg !== "--no-seed" && arg !== "--no-build");
if (unknown.length > 0) {
  console.error(`dev:up: unknown argument(s): ${unknown.join(" ")} (accepted: --no-seed, --no-build)`);
  process.exit(2);
}

function step(title) {
  console.log(`\n==> ${title}`);
}

function run(command, commandArgs, env = process.env) {
  const result = spawnSync(command, commandArgs, { cwd: root, env, stdio: "inherit" });
  if (result.error !== undefined) {
    console.error(`dev:up: could not run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`dev:up: \`${command} ${commandArgs.join(" ")}\` exited ${String(result.status)}`);
    process.exit(result.status ?? 1);
  }
}

step("dependencies");
if (existsSync(join(root, "node_modules"))) {
  console.log("node_modules present - skipping install");
} else {
  run("pnpm", ["install", "--frozen-lockfile"]);
}

step(".env");
const { created, path } = ensureDevEnv(root);
console.log(created ? `wrote ${path} with locally generated secrets (no vendor credentials)` : `kept existing ${path}`);

const effective = { ...parseEnvText(readFileSync(path, "utf8")), ...process.env };
const urls = composeHostUrls(effective);

step("docker compose up");
run("docker", ["compose", "up", "-d", ...(args.includes("--no-build") ? [] : ["--build"]), "--wait"]);

if (args.includes("--no-seed")) {
  console.log("\n--no-seed: skipping the synthetic seed");
} else {
  step("seed: three synthetic tenants");
  run("pnpm", ["--silent", "db:seed"], {
    ...effective,
    NODE_ENV: "development",
    DATABASE_URL: urls.databaseUrl,
    DATABASE_URL_POOLED: urls.databaseUrlPooled,
    VALKEY_CACHE_URL: urls.valkeyCacheUrl,
    QUEUE_REDIS_URL: urls.queueRedisUrl,
    NOMINARA_SYNTHETIC_SEED: "1",
  });
}

console.log(`
nominara-api is up.
  API       ${urls.apiUrl}   (readiness: ${urls.apiUrl}/health/ready)
  gateway   ${urls.gatewayUrl}
  Postgres  ${urls.databaseUrl.replace("nominara:nominara@", "nominara:***@")}
OTP codes are logged by the api container: docker compose logs -f api
Start over from empty: docker compose down -v && pnpm dev:up`);
