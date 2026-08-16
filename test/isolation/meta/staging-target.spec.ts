import { describe, expect, it } from "vitest";
import { assertRecognizedStagingDatabase, parseStagingTarget, UnrecognizedStagingDatabaseError } from "../support/staging-target.js";
import { ASSERTIONS, selectAssertionsForTarget } from "../assertions/registry.js";

// STORY-012 T24 · D-6 — the ISOLATION_TARGET=staging runner-side capability.
// No real staging environment exists (gap G-9) — these are structural/pure
// checks on the gating logic itself, not an end-to-end staging run.
describe("STORY-012 T24 · ISOLATION_TARGET=staging runner-side capability", () => {
  it("assertRecognizedStagingDatabase accepts a database with both required migrations applied", () => {
    expect(() =>
      assertRecognizedStagingDatabase(new Set(["0001_extensions_and_conventions", "0006_generated_rls_policies"])),
    ).not.toThrow();
  });

  it("assertRecognizedStagingDatabase refuses a database missing either required migration", () => {
    expect(() => assertRecognizedStagingDatabase(new Set())).toThrow(UnrecognizedStagingDatabaseError);
    expect(() => assertRecognizedStagingDatabase(new Set(["0001_extensions_and_conventions"]))).toThrow(
      UnrecognizedStagingDatabaseError,
    );
  });

  it("selectAssertionsForTarget('staging') is a strict, non-empty subset of the full registry, all read-only and fixture-independent", () => {
    const staging = selectAssertionsForTarget("staging");
    expect(staging.length).toBeGreaterThan(0);
    expect(staging.length).toBeLessThan(ASSERTIONS.length);
    for (const entry of staging) {
      expect(entry.readOnly).toBe(true);
      expect(entry.needsFixture).toBe(false);
    }
  });

  it("selectAssertionsForTarget('local'/'pooled') returns the full registry", () => {
    expect(selectAssertionsForTarget("local")).toBe(ASSERTIONS);
    expect(selectAssertionsForTarget("pooled")).toBe(ASSERTIONS);
  });

  // The connection path itself, not just the two pure gating functions
  // above: parseStagingTarget must carry the URL's OWN credentials through,
  // never substitute a hardcoded local-development pair.
  it("parseStagingTarget carries the URL's real host/port/database/credentials through, not local defaults", () => {
    const target = parseStagingTarget("postgres://real_staging_user:s3cr3t-pass@staging-db.internal:6543/nominara_staging");
    expect(target).toEqual({
      host: "staging-db.internal",
      port: 6543,
      database: "nominara_staging",
      superuser: { user: "real_staging_user", password: "s3cr3t-pass" },
    });
    expect(target.superuser.user).not.toBe("nominara");
    expect(target.superuser.password).not.toBe("nominara");
  });

  it("parseStagingTarget refuses a URL missing credentials rather than falling back to a local default", () => {
    expect(() => parseStagingTarget("postgres://staging-db.internal:5432/nominara_staging")).toThrow(
      /must include credentials/,
    );
  });

  it("parseStagingTarget defaults the port to 5432 when the URL omits it", () => {
    const target = parseStagingTarget("postgres://u:p@staging-db.internal/nominara_staging");
    expect(target.port).toBe(5432);
  });
});
