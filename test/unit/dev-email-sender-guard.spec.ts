import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EnvValidationError, loadEnv } from "../../src/config/env.js";
import { applyFakeApiEnv } from "../support/fake-env.js";

// STORY-127 — DevEmailSenderAdapter prints a one-time code in plaintext, so
// the only thing that matters about it is that production cannot reach it.
// Three independent checks say so; these tests hold all three, because a
// guard that can be refactored away is the failure this codebase keeps
// finding.

describe("STORY-127 · check 1 — env validation refuses the pair at BOOT", () => {
  // Through loadEnv, not envSchema directly: loadEnv picks KNOWN_KEYS out of
  // process.env first, and that pick is where OTP_DEV_LOG_CODES was silently
  // dropped while this was being written.
  function load(overrides: Record<string, string>) {
    applyFakeApiEnv();
    return () => loadEnv({ ...process.env, ...overrides });
  }

  it("refuses OTP_DEV_LOG_CODES under NODE_ENV=production — the process never starts", () => {
    expect(load({ NODE_ENV: "production", OTP_DEV_LOG_CODES: "true" })).toThrow(EnvValidationError);
    expect(load({ NODE_ENV: "production", OTP_DEV_LOG_CODES: "true" })).toThrow(/plaintext/);
  });

  it("allows it outside production, and the loader actually carries it through", () => {
    for (const NODE_ENV of ["development", "test"]) {
      expect(load({ NODE_ENV, OTP_DEV_LOG_CODES: "true" })().OTP_DEV_LOG_CODES, NODE_ENV).toBe("true");
    }
  });

  it("allows production when the flag is absent", () => {
    expect(load({ NODE_ENV: "production" })).not.toThrow();
  });

  it.each(["1", "yes", "TRUE", "True", ""])("treats %o as OFF rather than guessing — guessing wrong prints a credential", (value) => {
    // z.literal("true") — anything else is a validation error, not a
    // silently-enabled flag and not a silently-ignored one.
    expect(load({ NODE_ENV: "development", OTP_DEV_LOG_CODES: value })).toThrow(EnvValidationError);
  });
});

describe("STORY-127 · check 2 — the adapter's own constructor refuses production", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("throws under NODE_ENV=production even if something wired it there anyway", async () => {
    // The scenario this covers is a future refactor of selectEmailSender,
    // not a user misconfiguring anything — check 1 already stops that.
    process.env.NODE_ENV = "production";
    const { DevEmailSenderAdapter } = await import("../../src/modules/identity/adapters/dev-email-sender.adapter.js");
    expect(() => new DevEmailSenderAdapter()).toThrow(/never be constructed under NODE_ENV=production/);
  });

  it("constructs outside production", async () => {
    process.env.NODE_ENV = "development";
    const { DevEmailSenderAdapter } = await import("../../src/modules/identity/adapters/dev-email-sender.adapter.js");
    expect(() => new DevEmailSenderAdapter()).not.toThrow();
  });
});

describe("STORY-127 · check 3 — selectEmailSender defaults to the non-logging adapter", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function select() {
    const { selectEmailSender } = await import("../../src/modules/identity/identity.module.js");
    return selectEmailSender();
  }

  it("returns the LOGGING adapter in development when the flag is unset — nothing prints a code unless asked", async () => {
    process.env.NODE_ENV = "development";
    delete process.env.OTP_DEV_LOG_CODES;
    expect((await select()).constructor.name).toBe("LoggingEmailSenderAdapter");
  });

  it("returns the DEV adapter only when the flag is on and the mode is not production", async () => {
    process.env.NODE_ENV = "development";
    process.env.OTP_DEV_LOG_CODES = "true";
    expect((await select()).constructor.name).toBe("DevEmailSenderAdapter");
  });

  it("cannot even be asked under production with the flag set — loadEnv refuses first", async () => {
    // Written expecting "returns the logging adapter", which turned out to
    // be unreachable: selectEmailSender reads loadEnv(), and check 1 refuses
    // this combination before the selector sees it. The stricter outcome is
    // the correct one, so the test records that instead.
    process.env.NODE_ENV = "production";
    process.env.OTP_DEV_LOG_CODES = "true";
    const { EnvValidationError } = await import("../../src/config/env.js");
    await expect(select()).rejects.toThrow(EnvValidationError);
  });
});

describe("STORY-127 · the default adapter still never logs the code", () => {
  it("LoggingEmailSenderAdapter's source contains no reference to the message body", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile("src/modules/identity/adapters/logging-email-sender.adapter.ts", "utf8");
    // textBody is the only field that carries the code. STORY-016 chose not
    // to log it; STORY-127 must not have quietly changed that.
    expect(source).not.toMatch(/message\.textBody/);
  });
});
