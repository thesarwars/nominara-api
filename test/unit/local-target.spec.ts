import { describe, expect, it } from "vitest";
import { describeTarget } from "../../src/db/local-target.js";

// STORY-169 review — `describeTarget` is the mitigation for
// `isLocalTarget`'s own documented, deliberate limitation: it checks a
// hostname only, so a `localhost` port-forward to a REMOTE database (a
// Cloud SQL Auth Proxy, `kubectl port-forward`, `ssh -L`) passes it every
// time. `pnpm db:seed-demo` prints this string for both connection strings
// before writing a row — see `src/db/local-target.ts`'s own header and
// `src/db/seed-demo.ts`'s `main()`.

describe("STORY-169 · describeTarget", () => {
  it("resolves host, port and database exactly as node-postgres itself would connect", () => {
    expect(describeTarget("postgres://nominara:nominara@localhost:55432/nominara")).toBe("localhost:55432/nominara");
  });

  it("resolves the `?host=` query-param override, not the bare URL authority — the SAME parse isLocalTarget uses", () => {
    // The exact bypass `isLocalTarget` was fixed against: a port-forward
    // (or a hostile URL) can make the AUTHORITY read "localhost" while the
    // query param is where node-postgres actually connects.
    expect(describeTarget("postgres://nominara:pw@localhost:5432/nominara?host=prod-db.internal.example.com")).toBe(
      "prod-db.internal.example.com:5432/nominara",
    );
  });

  it("is a plain string a human reads before any row is written — a genuinely local target names itself as such", () => {
    expect(describeTarget("postgres://nominara_app:pw@127.0.0.1:6432/nominara")).toBe("127.0.0.1:6432/nominara");
  });

  it("reports a blank DATABASE_URL by name rather than throwing", () => {
    // Matches `hostnameOf`'s own documented reasoning: `pg.Client` treats
    // `""` as "no connectionString at all" and falls back to its own
    // default host, which would otherwise make a blank DATABASE_URL read
    // as a valid local target instead of the unparseable input it is.
    expect(describeTarget("")).toBe("(unparseable DATABASE_URL)");
    expect(describeTarget("   ")).toBe("(unparseable DATABASE_URL)");
  });
});
