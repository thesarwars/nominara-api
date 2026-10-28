// STORY-004 AC3 — `pnpm dev:up`: one command from a clean clone to a running,
// seeded API (owner decision 2026-10-27 item 4). The app repository's
// `pnpm dev:stack` calls this, then starts the app against it.
//
//   1. install      `pnpm install --frozen-lockfile`, only when node_modules is absent
//   2. env          write .env from .env.example with locally generated secrets (never overwrites one)
//   3. start        `docker compose up -d --build`, then `docker compose up -d --wait api`: Postgres,
//                   pgBouncer, both Valkeys, then the one-shot migrate + dev-credentials services,
//                   then the API, the gateway and the workers, gated on the API's readiness probe
//   4. seed         `pnpm db:seed` on the host, against the stack's published ports: three
//                   awkward synthetic tenants (idempotent: a second run writes nothing)
//
// The host-side steps see what the containers see (scripts/dev-env.mjs `hostSideEnv`): .env wins, as the
// containers' `env_file` does, except for what compose itself lets the shell decide, the `${NAME}` it
// interpolates (host ports, image tag) and COMPOSE_*. So `COMPOSE_PROJECT_NAME=other POSTGRES_PORT=15432 ...
// pnpm dev:up` runs a second, independent stack and the seed follows it to the moved ports, while a stale
// exported secret is ignored (and named) rather than used to wrap the seeded DEKs.
//
// Flags: --no-seed (skip step 4), --no-build (start the last built image), --reset (STORY-004 AC7: in place of
// step 4, stop the api/gateway/workers, flush BOTH Valkeys (queue and cache: the seed's ids are fixed, so a job or
// cache entry from before would attach to the rebuilt rows), `pnpm db:reset --seed` (drop everything, re-migrate,
// re-apply the role passwords, re-seed) with the same derived environment, then start the services again).
// --reset covers Postgres and both Valkeys; `docker compose down -v && pnpm dev:up` also discards the volumes.
//
// Not started: the LocalStack object-storage emulator (compose profile `storage`), opt-in since 2026-10-16
// because nothing writes to it yet. STORY-181 switches it on; until then `COMPOSE_PROFILES=storage pnpm dev:up`.
import { spawnSync } from "node:child_process";
import console from "node:console";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { composeHostUrls, ensureDevEnv, hostSideEnv, parseEnvText, resetSteps } from "./dev-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const unknown = args.filter((arg) => arg !== "--no-seed" && arg !== "--no-build" && arg !== "--reset");
if (unknown.length > 0) {
  console.error(`dev:up: unknown argument(s): ${unknown.join(" ")} (accepted: --no-seed, --no-build, --reset)`);
  process.exit(2);
}
if (args.includes("--reset") && args.includes("--no-seed")) {
  console.error("dev:up: --reset re-seeds by definition; it cannot be combined with --no-seed");
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

const { env: effective, ignoredShell } = hostSideEnv({
  dotenv: parseEnvText(readFileSync(path, "utf8")),
  shell: process.env,
  composeText: readFileSync(join(root, "docker-compose.yml"), "utf8"),
});
if (ignoredShell.length > 0) {
  console.log(`note: .env wins over these exported shell variables, as it does in the containers: ${ignoredShell.join(", ")}`);
}
const urls = composeHostUrls(effective);

step("docker compose up");
run("docker", ["compose", "up", "-d", ...(args.includes("--no-build") ? [] : ["--build"])]);
// `--wait` across EVERY service fails here by design: the gateway and the workers disable the image's healthcheck
// (docker-compose.yml says why) and compose refuses to wait on a service with none ("has no healthcheck configured").
// So wait on the API alone: its healthcheck is /health/ready, which needs the database through pgBouncer and the
// queue, and its dependencies include the one-shot migrate + dev-credentials services having exited successfully.
run("docker", ["compose", "up", "-d", "--wait", "api"]);

const seedEnv = {
  ...effective,
  NODE_ENV: "development",
  DATABASE_URL: urls.databaseUrl,
  DATABASE_URL_POOLED: urls.databaseUrlPooled,
  VALKEY_CACHE_URL: urls.valkeyCacheUrl,
  QUEUE_REDIS_URL: urls.queueRedisUrl,
  NOMINARA_SYNTHETIC_SEED: "1",
};
if (args.includes("--no-seed")) {
  console.log("\n--no-seed: skipping the synthetic seed");
} else if (args.includes("--reset")) {
  step("reset: stop api/gateway/workers, flush both Valkeys, drop, re-migrate, role passwords, seed, start again");
  const listed = spawnSync("docker", ["compose", "config", "--services"], { cwd: root, encoding: "utf8" });
  if (listed.status !== 0) {
    console.error(`dev:up: \`docker compose config --services\` exited ${String(listed.status)}: ${listed.stderr ?? ""}`);
    process.exit(listed.status ?? 1);
  }
  const services = listed.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  for (const { command, args: stepArgs, seedEnv: withSeedEnv } of resetSteps(services)) {
    run(command, [...stepArgs], withSeedEnv ? seedEnv : process.env);
  }
} else {
  step("seed: three synthetic tenants");
  run("pnpm", ["--silent", "db:seed"], seedEnv);
}

console.log(`
nominara-api is up.
  API       ${urls.apiUrl}   (readiness: ${urls.apiUrl}/health/ready)
  gateway   ${urls.gatewayUrl}
  Postgres  ${urls.databaseUrl.replace("nominara:nominara@", "nominara:***@")}
OTP codes are logged by the api container: docker compose logs -f api
Start over: pnpm dev:up --reset (Postgres and both Valkeys; to drop the volumes too, docker compose down -v && pnpm dev:up)`);
