import { describe, expect, it } from "vitest";
import { DemoSeedRefusedError, assertDemoSeedAllowed, type DemoSeedGuardInput } from "../../src/db/seed/demo/guard.js";

// STORY-169 — `pnpm db:seed-demo` writes real rows (facts, an AUX audit,
// tasks, a wallet grant) from an operator's shell, with no guard chain able
// to intercept a wrong target the way a request's would. Tested from the
// HAZARD — the ways a developer or a script could point this at something
// that is not their own local database — rather than from the guard's own
// four branches, so a rewrite that merges branches differently still has to
// keep refusing every one of these.

const ALLOWED: DemoSeedGuardInput = {
  nodeEnv: "development",
  databaseUrl: "postgres://nominara:nominara@localhost:55432/nominara",
  databaseUrlPooled: "postgres://nominara_app:pw@localhost:6432/nominara",
  optIn: "1",
};

describe("STORY-169 · assertDemoSeedAllowed", () => {
  it("allows the fully-local, opted-in, non-production case", () => {
    expect(() => assertDemoSeedAllowed(ALLOWED)).not.toThrow();
  });

  it("also allows NODE_ENV=test with both URLs local and opted in", () => {
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, nodeEnv: "test" })).not.toThrow();
  });

  it("refuses NODE_ENV=production even when every other condition is met", () => {
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, nodeEnv: "production" })).toThrow(DemoSeedRefusedError);
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, nodeEnv: "production" })).toThrow(/NODE_ENV=production/);
  });

  it.each([
    "postgres://u:p@db.production.internal:5432/nominara",
    "postgres://u:p@nominara-prod.abc123.eu-west-1.rds.amazonaws.com:5432/nominara",
    "postgres://u:p@10.0.4.17:5432/nominara",
    "postgres://u:p@staging-db:5432/nominara",
    // a local-looking hostname that is not local — resolves wherever its
    // owner says, exactly the studio-target.spec.ts hazard.
    "postgres://u:p@localhost.evil.com:5432/nominara",
    "postgres://u:p@notlocalhost:5432/nominara",
    // credentials that CONTAIN a local hostname are not evidence the HOST is
    // local — the user here is "localhost"; the host is not.
    "postgres://localhost:pw@db.prod.internal:5432/nominara",
    // A `?host=` query parameter overrides the parsed authority for
    // node-postgres, even though `new URL(...).hostname` still reports
    // "localhost" — the same hole `studio-target.spec.ts` pins.
    "postgres://nominara:pw@localhost:5432/nominara?host=prod-db.internal.example.com",
    // The Cloud SQL Unix-socket idiom is the same trick with a socket path.
    "postgres://u:p@localhost/db?host=/cloudsql/proj:region:inst",
    "postgres://nominara:pw@localhost:5432/nominara?host=10.0.0.5",
  ])("refuses a non-local DATABASE_URL: %s", (url) => {
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrl: url })).toThrow(DemoSeedRefusedError);
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrl: url })).toThrow(/DATABASE_URL names/);
  });

  it.each([
    "postgres://u:p@db.production.internal:6432/nominara",
    "postgres://u:p@pgbouncer.prod.internal:6432/nominara",
    "postgres://nominara_app:pw@localhost:6432/nominara?host=prod-db.internal.example.com",
  ])("refuses a non-local DATABASE_URL_POOLED even when DATABASE_URL is local: %s", (url) => {
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrlPooled: url })).toThrow(DemoSeedRefusedError);
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrlPooled: url })).toThrow(/DATABASE_URL_POOLED names/);
  });

  it("refuses an unparseable URL rather than passing it through", () => {
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrl: "not-a-url" })).toThrow(DemoSeedRefusedError);
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrl: "" })).toThrow(DemoSeedRefusedError);
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrlPooled: "not-a-url" })).toThrow(DemoSeedRefusedError);
  });

  it("refuses a missing DATABASE_URL or DATABASE_URL_POOLED", () => {
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrl: undefined })).toThrow(/DATABASE_URL is not set/);
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, databaseUrlPooled: undefined })).toThrow(
      /DATABASE_URL_POOLED is not set/,
    );
  });

  it("refuses when NOMINARA_DEMO_SEED is not set, even with everything else satisfied", () => {
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, optIn: undefined })).toThrow(DemoSeedRefusedError);
    expect(() => assertDemoSeedAllowed({ ...ALLOWED, optIn: undefined })).toThrow(/NOMINARA_DEMO_SEED=1/);
  });

  it.each(["true", "yes", "0", " 1", "1 "])(
    "refuses anything other than the exact string '1' for the opt-in: %j",
    (optIn) => {
      expect(() => assertDemoSeedAllowed({ ...ALLOWED, optIn })).toThrow(DemoSeedRefusedError);
    },
  );

  it("checks NODE_ENV before either connection string — the cheapest refusal fires first", () => {
    // Both URLs are also wrong here; the message must still name NODE_ENV,
    // proving the check order rather than merely the outcome.
    expect(() =>
      assertDemoSeedAllowed({
        nodeEnv: "production",
        databaseUrl: "postgres://u:p@prod:5432/n",
        databaseUrlPooled: "postgres://u:p@prod:6432/n",
        optIn: undefined,
      }),
    ).toThrow(/NODE_ENV=production/);
  });
});
