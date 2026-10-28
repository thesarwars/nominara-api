import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeInterpolationNames, hostSideEnv, resetSteps } from "../../scripts/dev-env.mjs";

// STORY-004 AC3 / AC7 — two hazards in `pnpm dev:up` that no container run shows on a quiet machine.
//
// 1. Precedence. The containers read .env through `env_file`, which a shell variable never overrides; only compose's
//    own `${NAME}` interpolation lets the shell win. A host-side seed that let every shell variable win would wrap the
//    synthetic tenants' DEKs (and sign plan:set's jobs) with a stale exported key the API and workers never see.
// 2. Reset. `--reset` drops the database while the api and workers hold pooled connections, and the seed's workspace
//    and project ids are FIXED, so a queued job or cache entry from before the reset attaches to the rebuilt rows.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");

describe("STORY-004 AC3 · dev:up host-side environment precedence", () => {
  it("reads the interpolated names from docker-compose.yml itself: ports and the image tag, never a secret", () => {
    const names = composeInterpolationNames(COMPOSE);
    for (const name of ["POSTGRES_PORT", "PGBOUNCER_PORT", "VALKEY_PORT", "VALKEY_QUEUE_PORT", "API_PORT", "GATEWAY_HOST_PORT", "NOMINARA_API_IMAGE"]) {
      expect(names, name).toContain(name);
    }
    for (const name of ["WORKSPACE_DEK_WRAPPING_KEY", "QUEUE_JOB_SIGNING_KEY", "NOMINARA_APP_DB_PASSWORD"]) {
      expect(names, name).not.toContain(name);
    }
  });

  it("takes .env over a stale exported secret, the way the containers' env_file does, and names what it ignored", () => {
    const dotenv = { WORKSPACE_DEK_WRAPPING_KEY: "dotenv-dek", QUEUE_JOB_SIGNING_KEY: "dotenv-sign", POSTGRES_PORT: "5432" };
    const shell = { WORKSPACE_DEK_WRAPPING_KEY: "stale-dek", QUEUE_JOB_SIGNING_KEY: "stale-sign", PATH: "/usr/bin" };
    const { env, ignoredShell } = hostSideEnv({ dotenv, shell, composeText: COMPOSE });
    expect(env.WORKSPACE_DEK_WRAPPING_KEY).toBe("dotenv-dek");
    expect(env.QUEUE_JOB_SIGNING_KEY).toBe("dotenv-sign");
    expect(env.PATH).toBe("/usr/bin");
    expect([...ignoredShell].sort()).toEqual(["QUEUE_JOB_SIGNING_KEY", "WORKSPACE_DEK_WRAPPING_KEY"]);
  });

  it("lets the shell win for what compose interpolates, so a second stack's ports and project name are followed", () => {
    const dotenv = { POSTGRES_PORT: "5432", API_PORT: "4000" };
    const shell = { POSTGRES_PORT: "15432", API_PORT: "14000", COMPOSE_PROJECT_NAME: "nominara-b", NOMINARA_API_IMAGE: "nominara-api-b" };
    const { env, ignoredShell } = hostSideEnv({ dotenv, shell, composeText: COMPOSE });
    expect(env.POSTGRES_PORT).toBe("15432");
    expect(env.API_PORT).toBe("14000");
    expect(env.COMPOSE_PROJECT_NAME).toBe("nominara-b");
    expect(env.NOMINARA_API_IMAGE).toBe("nominara-api-b");
    expect(ignoredShell).toEqual([]);
  });
});

describe("STORY-004 AC7 · dev:up --reset order", () => {
  const services = ["valkey", "postgres", "pgbouncer", "valkey-cache", "migrate", "dev-credentials", "api", "worker-crawl", "worker-report", "gateway"];
  const steps = resetSteps(services);
  const indexOf = (predicate: (step: (typeof steps)[number]) => boolean): number => {
    const index = steps.findIndex(predicate);
    expect(index, "step present").toBeGreaterThanOrEqual(0);
    return index;
  };
  const isFlush = (service: string) => (step: (typeof steps)[number]) =>
    step.command === "docker" && step.args.join(" ") === `compose exec -T ${service} valkey-cli FLUSHALL`;
  const isReset = (step: (typeof steps)[number]) => step.command === "pnpm" && step.args.includes("db:reset") && step.args.includes("--seed");

  it("stops every service that holds a connection or consumes the queue before anything is flushed or dropped", () => {
    const stop = indexOf((step) => step.command === "docker" && step.args[0] === "compose" && step.args[1] === "stop");
    expect([...steps[stop]!.args.slice(2)].sort()).toEqual(["api", "gateway", "worker-crawl", "worker-report"]);
    expect(stop).toBeLessThan(indexOf(isFlush("valkey")));
    expect(stop).toBeLessThan(indexOf(isFlush("valkey-cache")));
    expect(stop).toBeLessThan(indexOf(isReset));
  });

  it("flushes BOTH Valkeys (queue and cache) before the reset re-seeds the fixed ids, and runs the reset with the seed environment", () => {
    const reset = indexOf(isReset);
    expect(indexOf(isFlush("valkey"))).toBeLessThan(reset);
    expect(indexOf(isFlush("valkey-cache"))).toBeLessThan(reset);
    expect(steps[reset]!.seedEnv).toBe(true);
  });

  it("brings the stopped services back after the reset, gated on the API's readiness", () => {
    const reset = indexOf(isReset);
    const wait = indexOf((step) => step.command === "docker" && step.args.join(" ") === "compose up -d --no-build --wait api");
    const up = indexOf((step) => step.command === "docker" && step.args.join(" ") === "compose up -d --no-build");
    expect(up).toBeGreaterThan(reset);
    expect(wait).toBeGreaterThan(up);
  });
});
