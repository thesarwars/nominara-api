import { describe, expect, it } from "vitest";
import { NonLocalStudioTargetError, assertLocalTarget } from "../../src/db/studio.js";

// STORY-128 — Drizzle Studio connects as the database OWNER, which RLS does
// not constrain, and it writes. Pointed at anything real it would expose and
// edit every tenant's rows at once, with no confirmation between a cell and
// a committed UPDATE. The only thing standing between that and a stray
// DATABASE_URL is this check.

describe("STORY-128 · assertLocalTarget", () => {
  it.each([
    "postgres://nominara:nominara@localhost:55432/nominara",
    "postgres://nominara:nominara@127.0.0.1:5432/nominara",
    "postgres://u:p@host.docker.internal:5432/db",
    "postgres://u:p@postgres:5432/db",
  ])("allows %s", (url) => {
    expect(() => assertLocalTarget(url)).not.toThrow();
  });

  it.each([
    "postgres://u:p@db.production.internal:5432/nominara",
    "postgres://u:p@nominara-prod.abc123.eu-west-1.rds.amazonaws.com:5432/nominara",
    "postgres://u:p@10.0.4.17:5432/nominara",
    "postgres://u:p@staging-db:5432/nominara",
  ])("refuses %s", (url) => {
    expect(() => assertLocalTarget(url)).toThrow(NonLocalStudioTargetError);
  });

  it("names the host it refused, and says why", () => {
    expect(() => assertLocalTarget("postgres://u:p@db.production.internal:5432/n")).toThrow(/db\.production\.internal/);
    // The reason matters more than the refusal: someone hitting this needs
    // to know Studio is owner-connected and RLS-blind, not just that it said no.
    expect(() => assertLocalTarget("postgres://u:p@db.production.internal:5432/n")).toThrow(/RLS does not constrain/);
  });

  it("refuses an unparseable URL rather than passing it through", () => {
    // Not evidence of a local target — find out here, not inside Studio.
    expect(() => assertLocalTarget("not-a-url")).toThrow(NonLocalStudioTargetError);
    expect(() => assertLocalTarget("")).toThrow(NonLocalStudioTargetError);
  });

  it("is not fooled by a local-looking hostname that is not local", () => {
    // `localhost.evil.com` resolves wherever its owner says.
    expect(() => assertLocalTarget("postgres://u:p@localhost.evil.com:5432/n")).toThrow(NonLocalStudioTargetError);
    expect(() => assertLocalTarget("postgres://u:p@notlocalhost:5432/n")).toThrow(NonLocalStudioTargetError);
  });

  it("is not fooled by credentials that contain a local hostname", () => {
    // The USER is "localhost" here; the host is not.
    expect(() => assertLocalTarget("postgres://localhost:pw@db.prod.internal:5432/n")).toThrow(
      NonLocalStudioTargetError,
    );
  });
});
