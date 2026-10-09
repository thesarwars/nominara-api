import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// STORY-055 #10 / AC9 — Nominara never posts on a customer's behalf. This is
// an absence check over the dependency and code surface: no third-party
// platform SDK is installed and no platform API endpoint is referenced.

const root = join(import.meta.dirname, "../../..");
const PLATFORM_SDKS = /reddit|snoowrap|praw|octokit|twitter|twit\b|linkedin|discord|slack|@slack|telegraf|stackexchange|g2|trustpilot|capterra|medium-sdk|mastodon|masto|tumblr|wordpress/i;
const PLATFORM_API_HOSTS =
  /(oauth\.reddit\.com|api\.reddit\.com|api\.stackexchange\.com|api\.twitter\.com|api\.x\.com|api\.linkedin\.com|slack\.com\/api|discord(app)?\.com\/api|api\.github\.com|api\.medium\.com|api\.g2\.com|api\.trustpilot\.com|\/wp-json\/)/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|mts)$/.test(name) && !/\.(spec|test)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe("STORY-055 #10 · no platform write client exists", () => {
  it("no dependency is a third-party platform SDK", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names.filter((n) => PLATFORM_SDKS.test(n))).toEqual([]);
  });

  // The ONE reference: GitHub SIGN-IN reads the signing-in user's own identity
  // (`/user`, `/user/emails`). It authenticates the user to Nominara; it does
  // not authenticate Nominara against GitHub to contribute anything. Asserted
  // below to be exactly those two read endpoints, so widening it fails here.
  const SIGN_IN = "src/lib/auth/oauth-providers.ts";

  it("no source file references a platform API endpoint, other than the sign-in identity read", () => {
    const hits = [...walk(join(root, "src")), ...walk(join(root, "contracts"))]
      .filter((f) => PLATFORM_API_HOSTS.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(root.length + 1));
    expect(hits.filter((f) => f !== SIGN_IN)).toEqual([]);
  });

  it("the sign-in exemption references only GitHub's user and user/emails read endpoints", () => {
    const text = readFileSync(join(root, SIGN_IN), "utf8");
    const apiUrls = [...text.matchAll(/https:\/\/api\.github\.com[^"'`\s]*/g)].map((m) => m[0]);
    expect(apiUrls.sort()).toEqual(["https://api.github.com/user", "https://api.github.com/user/emails"]);
    expect(text).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["'][^]*api\.github\.com/);
  });

  it("the sources module and playbook templates make no network call at all", () => {
    for (const f of ["src/modules/analytics/sources.service.ts", "src/modules/analytics/sources.controller.ts", "src/lib/sources/playbook-templates.ts"]) {
      const text = readFileSync(join(root, f), "utf8");
      expect(text, f).not.toMatch(/\bfetch\(|undici|axios|node:https?|\bhttp\.request/);
    }
  });
});
