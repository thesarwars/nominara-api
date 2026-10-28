import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";
import { composeHostUrls, ensureDevEnv, generateDevEnv, parseEnvText, VENDOR_KEYS } from "../../scripts/dev-env.mjs";

// STORY-004 AC3 / test scenario 1 ("Clean clone, run the single command -> a
// working API and app, no vendor credentials set"). The full scenario needs
// Docker and is verified by hand under a separate compose project (see the
// README); this is its offline proxy: the .env the one command writes from
// .env.example must boot the real config schema with ZERO vendor keys.

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXAMPLE = readFileSync(join(ROOT, ".env.example"), "utf8");

describe("STORY-004 AC3 · dev env bootstrap (scenario 1, offline proxy)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("a .env generated from .env.example parses under env.schema with no vendor credential set", () => {
    const parsed = parseEnvText(generateDevEnv(EXAMPLE));
    expect(() => loadEnv({ ...parsed, NODE_ENV: "development" })).not.toThrow();
    for (const key of VENDOR_KEYS) {
      expect(parsed[key], `${key} must not be set by the bootstrap`).toBeUndefined();
    }
  });

  it("names the vendor keys it keeps unset: every engine, Stripe, Resend and OAuth credential", () => {
    for (const key of [
      "GEMINI_API_KEY",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "RESEND_API_KEY",
      "GOOGLE_OAUTH_CLIENT_ID",
      "GITHUB_OAUTH_CLIENT_SECRET",
      "MICROSOFT_OAUTH_CLIENT_SECRET",
    ]) {
      expect(VENDOR_KEYS).toContain(key);
    }
  });

  it("fills every placeholder with a locally generated secret, different on every run", () => {
    const first = generateDevEnv(EXAMPLE);
    const second = generateDevEnv(EXAMPLE);
    const firstEnv = parseEnvText(first);
    const secondEnv = parseEnvText(second);
    expect(Object.values(firstEnv).filter((value) => value.includes("REPLACE_"))).toEqual([]);
    for (const key of [
      "AUTH_TOKEN_ED25519_PRIVATE_KEY",
      "CSRF_SECRET",
      "OAUTH_STATE_SECRET",
      "OTP_EMAIL_HASH_PEPPER",
      "WORKSPACE_DEK_WRAPPING_KEY",
      "QUEUE_JOB_SIGNING_KEY",
    ]) {
      expect(firstEnv[key], key).toBeTruthy();
      expect(firstEnv[key], `${key} must not be a constant`).not.toEqual(secondEnv[key]);
    }
    expect(Buffer.from(firstEnv.WORKSPACE_DEK_WRAPPING_KEY!, "base64")).toHaveLength(32);
    expect(Buffer.from(firstEnv.QUEUE_JOB_SIGNING_KEY!, "base64")).toHaveLength(32);
  });

  it("turns on OTP_DEV_LOG_CODES so a seeded owner can sign in locally", () => {
    expect(parseEnvText(generateDevEnv(EXAMPLE)).OTP_DEV_LOG_CODES).toBe("true");
  });

  // The default host ports are read from docker-compose.yml itself (`${NAME:-default}`), so the seed's URLs and the
  // stack's published ports cannot drift apart. Valkey URLs are checked by their parts: STORY-174's scanner refuses a
  // literal Valkey URL anywhere in the test tree.
  const COMPOSE = readFileSync(join(ROOT, "docker-compose.yml"), "utf8");
  const composeDefault = (name: string): string => {
    const match = new RegExp(`\\$\\{${name}:-(\\d+)\\}`, "u").exec(COMPOSE);
    if (match === null) throw new Error(`docker-compose.yml has no default for ${name}`);
    return match[1]!;
  };
  const hostAndPort = (url: string) => {
    const parsed = new URL(url);
    return { protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port };
  };

  it("derives the host URLs from the same port variables docker-compose.yml interpolates, with its defaults", () => {
    const urls = composeHostUrls({});
    expect(urls.databaseUrl).toBe(`postgres://nominara:nominara@localhost:${composeDefault("POSTGRES_PORT")}/nominara`);
    expect(urls.databaseUrlPooled).toBe(`postgres://nominara_app:nominara_app_dev_local@localhost:${composeDefault("PGBOUNCER_PORT")}/nominara`);
    expect(hostAndPort(urls.valkeyCacheUrl)).toEqual({ protocol: "redis:", hostname: "localhost", port: composeDefault("VALKEY_PORT") });
    expect(hostAndPort(urls.queueRedisUrl)).toEqual({ protocol: "redis:", hostname: "localhost", port: composeDefault("VALKEY_QUEUE_PORT") });
    expect(urls.apiUrl).toBe(`http://localhost:${composeDefault("API_PORT")}`);
    expect(urls.gatewayUrl).toBe(`http://localhost:${composeDefault("GATEWAY_HOST_PORT")}`);
  });

  it("follows every port variable when a second stack moves them", () => {
    const moved = composeHostUrls({
      POSTGRES_PORT: "15432",
      PGBOUNCER_PORT: "16432",
      VALKEY_PORT: "16379",
      VALKEY_QUEUE_PORT: "16390",
      API_PORT: "14000",
      GATEWAY_HOST_PORT: "13001",
    });
    expect(moved.databaseUrl).toBe("postgres://nominara:nominara@localhost:15432/nominara");
    expect(moved.databaseUrlPooled).toBe("postgres://nominara_app:nominara_app_dev_local@localhost:16432/nominara");
    expect(hostAndPort(moved.valkeyCacheUrl)).toEqual({ protocol: "redis:", hostname: "localhost", port: "16379" });
    expect(hostAndPort(moved.queueRedisUrl)).toEqual({ protocol: "redis:", hostname: "localhost", port: "16390" });
    expect(moved.apiUrl).toBe("http://localhost:14000");
    expect(moved.gatewayUrl).toBe("http://localhost:13001");
  });

  it("writes .env only when absent and never overwrites an existing one", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-env-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env.example"), EXAMPLE);
    expect(ensureDevEnv(dir).created).toBe(true);
    const written = readFileSync(join(dir, ".env"), "utf8");
    expect(ensureDevEnv(dir).created).toBe(false);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(written);
  });

  it("refuses an existing .env that still holds a REPLACE_ placeholder in a required key", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-env-"));
    dirs.push(dir);
    writeFileSync(join(dir, ".env.example"), EXAMPLE);
    writeFileSync(join(dir, ".env"), EXAMPLE);
    expect(() => ensureDevEnv(dir)).toThrow(/REPLACE_/u);
  });
});
