import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// NEW-D-7 audit finding 4, closed by owner decision 4 (2026-10-08) — "the auto-top-up trigger is reached by a signed
// `billing.auto_topup` queue job, never on the request path". `AutoTopupService.trigger(workspaceId)` takes a raw
// workspace id and does its own tenant transactions, so the ONLY safe caller is the handler whose workspace id comes from
// a payload the processor verified before any context was set. This gate keeps it that way: no production file but the
// ones below may reference the service, and none but the queue handler may call `.trigger(`.
// DEFAULTS TO REPORT: a new referencing file fails here and is a design question, not an allow-list entry.
const ROOT = resolve(import.meta.dirname, "../../..");

// Each of these uses the lifecycle methods (`disableAfterFailure`, `notifyDisabled`) or registers the provider.
const MAY_REFERENCE = new Set([
  "src/modules/billing/auto-topup.service.ts",
  "src/modules/billing/billing.module.ts",
  "src/modules/billing/stripe-credit-pack.handler.ts",
  // The signed queue handler — the one caller of `.trigger(`.
  "src/lib/queue/handlers/billing-auto-topup.handler.ts",
]);

const QUEUE_HANDLER = "src/lib/queue/handlers/billing-auto-topup.handler.ts";

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

describe("NEW-D-7 audit 4 · the auto-top-up trigger is reached only by the signed queue handler", () => {
  it("no production file outside the billing module's own lifecycle code references AutoTopupService", () => {
    const referencing = sources()
      .filter((f) => /\bAutoTopupService\b|auto-topup\.service/.test(f.text))
      .map((f) => f.path)
      .filter((p) => !MAY_REFERENCE.has(p));
    // contracts/billing/auto-topup.schema.ts only NAMES the class in a comment; a real import would be in src/.
    expect(referencing.filter((p) => !p.startsWith("contracts/"))).toEqual([]);
  });

  it("only the billing.auto_topup queue handler calls AutoTopupService.trigger, and it does so exactly once", () => {
    const callers = sources()
      .filter((f) => f.path !== "src/modules/billing/auto-topup.service.ts")
      .filter((f) => /\bAutoTopupService\b/.test(f.text) && /\.trigger\(/.test(f.text))
      .map((f) => ({ path: f.path, calls: f.text.match(/\.trigger\(/g)?.length ?? 0 }));
    expect(callers).toEqual([{ path: QUEUE_HANDLER, calls: 1 }]);
  });

  it("no request-path code (a controller, a guard, an interceptor) references the service: the interceptor only enqueues", () => {
    const requestPath = sources().filter((f) => /\.controller\.ts$|^src\/api\//.test(f.path));
    expect(requestPath.length).toBeGreaterThan(0);
    expect(requestPath.filter((f) => /AutoTopupService|auto-topup\.service/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("the guard itself sees the files it claims to guard (the scan is not vacuous)", () => {
    const found = sources().map((f) => f.path);
    for (const path of MAY_REFERENCE) expect(found).toContain(path);
    expect(sources().filter((f) => /\bAutoTopupService\b/.test(f.text)).length).toBeGreaterThanOrEqual(MAY_REFERENCE.size);
  });
});
