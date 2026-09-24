import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ⚠ STORY-153 — THE TWO PROPERTIES `WorkspaceGuard`'s EARLY RETURN RESTS ON.
//
// The guard now returns before resolving the token's `ws` claim for any route
// marked `@SkipTenantContext()`. That fixed a deadlock: a plan change bumps
// `entitlement_version`, every existing session goes stale, and the two routes
// that recover from it — `GET /v1/workspaces` and `POST /workspaces/{id}/switch`
// — were themselves refused for being stale. The exit was blocked by the
// condition it existed to clear.
//
// Two things have to stay true for that early return to be safe, and neither
// is visible from the guard's own file:
//
//   1. No tenant-less route may read `req.tenant`. It is `undefined` there now.
//   2. The recovery routes must KEEP the decorator. Removing it from `switch`
//      silently restores the deadlock, and the only symptom is that members of
//      a workspace whose plan changed cannot get back in.
//
// Neither is an integration test, because both are about the SHAPE of the
// controllers rather than the behaviour of one request.
describe("STORY-153 · the contract behind WorkspaceGuard's tenant-less early return", () => {
  const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (full.endsWith(".controller.ts")) out.push(full);
    }
    return out;
  }

  /**
   * ⚠ COMMENTS STRIPPED BEFORE SCANNING.
   *
   * The first version of this scan reported `entitlements.controller.ts` as a
   * tenant-less route that reads `req.tenant` — a false positive, because the
   * string `@SkipTenantContext` appears in a COMMENT there explaining that the
   * route is *not* one. A scanner that reads prose reports a discussion of a
   * thing as the thing. STORY-152 fixed exactly this defect in
   * `measurement-status-shared.spec.ts`, and it was reintroduced here within
   * the hour.
   */
  function stripProse(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  }

  /** Controllers are DERIVED from the tree, never listed — a named list is the shape that keeps failing. */
  const controllers = walk(SRC);

  interface Handler {
    readonly file: string;
    readonly line: number;
    readonly route: string;
    readonly body: string;
  }

  /** Every route handler, as the span from its HTTP-method decorator to the next one. */
  const handlers: Handler[] = controllers.flatMap((file) => {
    const lines = stripProse(readFileSync(file, "utf8")).split("\n");
    const starts = lines.flatMap((line, i) => (/^\s*@(Get|Post|Patch|Put|Delete)\(/u.test(line) ? [i] : []));
    return starts.map((start, n) => ({
      file: path.relative(SRC, file),
      line: start + 1,
      route: lines[start]!.trim(),
      body: lines.slice(start, starts[n + 1] ?? lines.length).join("\n"),
    }));
  });

  const tenantless = handlers.filter((h) => h.body.includes("@SkipTenantContext"));

  it("finds the controllers and handlers it claims to scan", () => {
    expect(controllers.length, "no controllers found — the walk is broken").toBeGreaterThan(5);
    expect(handlers.length, "no route handlers found — the span split is broken").toBeGreaterThan(30);
    expect(tenantless.length, "no @SkipTenantContext routes found — the scan is vacuous").toBeGreaterThan(3);
  });

  it("⚠ no tenant-less route reads req.tenant — the guard leaves it undefined", () => {
    const offenders = tenantless
      .filter((h) => /req\.tenant/u.test(h.body))
      .map((h) => `${h.file}:${h.line} ${h.route}`);
    expect(
      offenders,
      "this route is marked @SkipTenantContext but reads req.tenant, which is now undefined — " +
        "either it needs tenant context (drop the decorator) or it does not (drop the read)",
    ).toEqual([]);
  });

  it("⚠ the two recovery routes are tenant-less, or the plan-change deadlock returns", () => {
    // Named individually because each one alone re-creates the deadlock:
    // without the list the client cannot tell the user belongs anywhere;
    // without the switch it cannot mint a token carrying the current ent_v.
    const routes = tenantless.map((h) => `${path.basename(h.file)} ${h.route}`);
    for (const [needle, why] of [
      ['workspaces.controller.ts @Get("workspaces")', "the client asks this FIRST to decide whether the user belongs anywhere"],
      ['workspaces.controller.ts @Post("workspaces/:id/switch")', "the ONLY route that re-mints a token with the current ent_v"],
    ] as const) {
      // EXACT equality on the route line, so `@Get("workspaces")` cannot be
      // satisfied by `@Get("workspaces/:id")` — a substring match here would
      // report the deadlock as fixed while the list route had lost its
      // decorator.
      expect(routes, `${needle} must stay @SkipTenantContext — ${why}`).toContain(needle);
    }
  });

  it("⚠ and the prose stripper is why the previous assertion is trustworthy", () => {
    // Anti-vacuity in both directions: a route discussing the decorator in a
    // comment must NOT be counted, and a route carrying it must be.
    expect(stripProse("// @SkipTenantContext is not used here\nfoo();")).not.toContain("@SkipTenantContext");
    expect(stripProse("  @SkipTenantContext()\n  handler() {}")).toContain("@SkipTenantContext");

    // The concrete regression: the entitlements route mentions the decorator
    // in prose, reads req.tenant, and must not be reported.
    const entitlements = handlers.find((h) => h.file.includes("entitlements.controller.ts"));
    expect(entitlements, "the entitlements route should be in scope").toBeDefined();
    expect(entitlements!.body).toContain("req.tenant");
    expect(
      entitlements!.body.includes("@SkipTenantContext"),
      "entitlements only MENTIONS the decorator in a comment — it must not be treated as tenant-less",
    ).toBe(false);
  });
});
