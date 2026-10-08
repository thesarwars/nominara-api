import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// NEW-D-7 audit finding 4 — "nothing in the code stops `trigger` from being wired". The gate was prose.
// `AutoTopupService.trigger(workspaceId)` takes a raw workspace id and does its own tenant transactions, and the
// cycle roll (`auto_topup_count_cycle` is reset by nothing: max_per_cycle is a lifetime cap) and the signed
// `billing.auto_topup` queue handler (HMAC verified BEFORE any tenant context) do not exist yet. Until they do,
// no production file may reference the service except the ones below, and none of those may call `.trigger(`.
// DEFAULTS TO REPORT: a new referencing file fails here and is a design question, not an allow-list entry.
// The change that lands the queue handler edits this file in the same commit, with the handler's own tests.
const ROOT = resolve(import.meta.dirname, "../../..");

// Each of these uses the lifecycle methods (`disableAfterFailure`, `notifyDisabled`) or registers the provider.
const MAY_REFERENCE = new Set([
  "src/modules/billing/auto-topup.service.ts",
  "src/modules/billing/billing.module.ts",
  "src/modules/billing/stripe-credit-pack.handler.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts") && !full.endsWith(".spec.ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}
const sources = (): { path: string; text: string }[] =>
  [...walk(join(ROOT, "src")), ...walk(join(ROOT, "contracts"))].map((full) => ({ path: relative(ROOT, full), text: readFileSync(full, "utf8") }));

describe("NEW-D-7 audit 4 · the auto-top-up trigger is not wired to anything", () => {
  it("no production file outside the billing module's own lifecycle code references AutoTopupService", () => {
    const referencing = sources()
      .filter((f) => /\bAutoTopupService\b|auto-topup\.service/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !MAY_REFERENCE.has(p));
    // contracts/billing/auto-topup.schema.ts only NAMES the class in a comment; a real import would be in src/.
    expect(referencing.filter((p) => !p.startsWith("contracts/"))).toEqual([]);
  });

  it("no production file calls AutoTopupService.trigger: nothing but its own spec invokes it", () => {
    const callers = sources()
      .filter((f) => f.path !== "src/modules/billing/auto-topup.service.ts")
      .filter((f) => MAY_REFERENCE.has(f.path))
      .filter((f) => /\.trigger\(/.test(f.text))
      .map((f) => f.path);
    expect(callers).toEqual([]);
  });

  it("the guard itself sees the files it claims to guard (the scan is not vacuous)", () => {
    const found = sources().map((f) => f.path);
    for (const path of MAY_REFERENCE) expect(found).toContain(path);
    expect(sources().filter((f) => /\bAutoTopupService\b/.test(f.text)).length).toBeGreaterThanOrEqual(MAY_REFERENCE.size);
  });
});
