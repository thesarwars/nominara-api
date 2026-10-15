import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError, KNOWN_KEYS, loadEnv } from "../../src/config/env.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// Group C item 1 — which EmailSender a process runs with, and what the boot refuses.

const originalEnv = { ...process.env };

beforeEach(() => {
  applyFakeApiEnv();
  vi.resetModules();
  for (const key of ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_TO_EMAIL", "OTP_DEV_LOG_CODES", "ALERT_EMAIL_TO"]) delete process.env[key];
});

afterEach(() => {
  process.env = { ...originalEnv };
});

async function select(): Promise<string> {
  const { selectEmailSender } = await import("../../src/modules/identity/identity.module.js");
  return selectEmailSender().constructor.name;
}

describe("Resend selection matrix", () => {
  it("logging adapter when no Resend key is configured (today's behaviour)", async () => {
    process.env.NODE_ENV = "development";
    expect(await select()).toBe("LoggingEmailSenderAdapter");
  });

  it("Resend when RESEND_API_KEY and RESEND_FROM_EMAIL are both set", async () => {
    process.env.NODE_ENV = "development";
    process.env.RESEND_API_KEY = "re_test_PLACEHOLDER";
    process.env.RESEND_FROM_EMAIL = "onboarding@resend.dev";
    expect(await select()).toBe("ResendEmailSenderAdapter");
  });

  it("Resend in production too, without any override", async () => {
    process.env.NODE_ENV = "production";
    process.env.RESEND_API_KEY = "re_test_PLACEHOLDER";
    process.env.RESEND_FROM_EMAIL = "Nominara <no-reply@nominara.test>";
    expect(await select()).toBe("ResendEmailSenderAdapter");
  });

  it("Resend wins over the OTP_DEV_LOG_CODES dev logger when both are configured outside production", async () => {
    process.env.NODE_ENV = "development";
    process.env.OTP_DEV_LOG_CODES = "true";
    process.env.RESEND_API_KEY = "re_test_PLACEHOLDER";
    process.env.RESEND_FROM_EMAIL = "onboarding@resend.dev";
    expect(await select()).toBe("ResendEmailSenderAdapter");
  });

  it("the dev logger is still chosen when only OTP_DEV_LOG_CODES is set", async () => {
    process.env.NODE_ENV = "development";
    process.env.OTP_DEV_LOG_CODES = "true";
    expect(await select()).toBe("DevEmailSenderAdapter");
  });

  it("RESEND_TO_EMAIL outside production is carried into the adapter (a redirect, not ignored)", async () => {
    process.env.NODE_ENV = "development";
    process.env.RESEND_API_KEY = "re_test_PLACEHOLDER";
    process.env.RESEND_FROM_EMAIL = "onboarding@resend.dev";
    process.env.RESEND_TO_EMAIL = "owner@example.net";
    const { selectEmailSender } = await import("../../src/modules/identity/identity.module.js");
    const sender = selectEmailSender() as unknown as { toOverride?: string };
    expect(sender.toOverride).toBe("owner@example.net");
  });
});

describe("Resend boot validation", () => {
  const load = (overrides: Record<string, string>) => () => loadEnv({ ...process.env, ...overrides });

  it("REFUSES RESEND_TO_EMAIL under NODE_ENV=production, naming the key", () => {
    const attempt = load({ NODE_ENV: "production", RESEND_API_KEY: "re_x", RESEND_FROM_EMAIL: "a@b.test", RESEND_TO_EMAIL: "owner@example.net" });
    expect(attempt).toThrow(EnvValidationError);
    expect(attempt).toThrow(/RESEND_TO_EMAIL/);
  });

  it("allows RESEND_TO_EMAIL in development and test, and loadEnv carries it through", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const env = load({ NODE_ENV, RESEND_API_KEY: "re_x", RESEND_FROM_EMAIL: "a@b.test", RESEND_TO_EMAIL: "owner@example.net" })();
      expect(env.RESEND_TO_EMAIL, NODE_ENV).toBe("owner@example.net");
    }
  });

  it("production with only half of the pair (key without sender, or sender without key) is refused rather than silently mailing nothing", () => {
    expect(load({ NODE_ENV: "production", RESEND_API_KEY: "re_x" })).toThrow(/RESEND_FROM_EMAIL/);
    expect(load({ NODE_ENV: "production", RESEND_FROM_EMAIL: "a@b.test" })).toThrow(/RESEND_API_KEY/);
  });

  it("rejects a malformed RESEND_TO_EMAIL / ALERT_EMAIL_TO", () => {
    expect(load({ NODE_ENV: "development", RESEND_TO_EMAIL: "not-an-address" })).toThrow(EnvValidationError);
    expect(load({ NODE_ENV: "development", ALERT_EMAIL_TO: "not-an-address" })).toThrow(EnvValidationError);
  });

  it("all four new keys are in KNOWN_KEYS", () => {
    for (const key of ["RESEND_API_KEY", "RESEND_FROM_EMAIL", "RESEND_TO_EMAIL", "ALERT_EMAIL_TO"]) {
      expect(KNOWN_KEYS as readonly string[]).toContain(key);
    }
  });
});
