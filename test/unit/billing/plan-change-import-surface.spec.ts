import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ⚠ DELETING THIS TEST REMOVES STORY-151'S SAFETY PROPERTY. Read that sentence
// before deciding it is noise.
//
// A workspace's plan cannot be changed by any customer, and the mechanism is
// an ABSENCE rather than a predicate: `applyPlanChange` is imported by no
// controller, guard, interceptor or queue handler, so no HTTP request reaches
// a statement that writes a paid `plan_key`. There is no route to call, no
// permission to hold (`billing:write` is held by every workspace OWNER, which
// is exactly why a route would be wrong), no environment variable to be
// misconfigured, and no NODE_ENV to be wrong about.
//
// The alternative considered was an environment gate shaped like
// OTP_DEV_LOG_CODES. A gate is a predicate that has to evaluate correctly on
// every production process forever, and its failure is silent and total. An
// absence fails only when someone writes and merges new code — which is a
// reviewable event, and which THIS TEST turns into a red build.
//
// So: someone will eventually add the "obvious" self-service plan route, in a
// hurry, reusing `applyPlanChange` because it is right there and well tested.
// This test is what stops that being a quiet Tuesday.
//
// `subscriptions.provider` (migration 0026) is the detective backstop that
// proves the same property from the data side even if this test is removed —
// see plan-change-service.spec.ts.
describe("STORY-151 · nothing customer-reachable can change a plan", () => {
  const root = fileURLToPath(new URL("../../../src/", import.meta.url));

  /** The operator CLI. */
  const ALLOWED = path.join(root, "workers", "billing", "plan-set.ts");
  /**
   * STORY-075a — OWNER-APPROVED, and the ONLY addition to this gate: the
   * webhook reconciler. It is reachable solely from StripeWebhookService, after
   * the raw-body signature verified and the subscription was re-fetched from
   * Stripe; no request body is an input to the plan it writes. A THIRD importer
   * still fails the build below, and so does anything but the module importing
   * the reconciler itself.
   */
  const RECONCILER = path.join(root, "modules", "billing", "stripe-subscription.handler.ts");
  const RECONCILER_REGISTRAR = path.join(root, "modules", "billing", "billing.module.ts");

  // ⚠ THE SCOPE IS WIDER THAN "src/modules AND src/api", AND THAT MATTERS.
  // Queue handlers open their own connection from `env.DATABASE_URL` directly
  // (maintenance-partition, audit-verify, credit-reconcile all do), so a
  // BullMQ handler importing this would have been a customer-triggerable path
  // that a narrower scan waved through.
  // ⚠ EVERYTHING UNDER src/, NOT A LIST OF DIRECTORIES. The first version
  // scanned six directories and a second-engineer review walked around it:
  // `src/lib/queue/handlers.ts` (the handler REGISTRY, next to the `handlers/`
  // directory that WAS scanned), the three process entry points `main.ts`,
  // `worker.ts`, `gateway.ts`, and every re-export barrel under `src/lib/**`
  // were all one hop out of view. Scanning everything and allowing exactly one
  // file has no such gaps to enumerate.
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(full) && !/\.spec\.tsx?$/.test(full)) out.push(full);
    }
    return out;
  }

  /** The module and its siblings in src/lib/billing are not "importers". */
  const BILLING_LIB = path.join(root, "lib", "billing");
  const files = walk(root).filter((file) => !file.startsWith(BILLING_LIB));

  // ⚠ EVERY MODULE-SPECIFIER FORM, NOT JUST `import … from "…"`. The review
  // evaded the original matcher with `await import()`, `require()`, single
  // quotes, a re-export and a barrel hop — and `await import()` is not
  // hypothetical: src/modules/tracking/run-estimate.service.ts already uses it,
  // inside a directory the old scan covered. A controller in that house style
  // reached `applyPlanChange` with a green build.
  const REACHES_APPLY_PLAN = /(?:from|import|require)\s*\(?\s*["'][^"']*billing\/apply-plan\.js["']/u;
  /** One hop out: anything importing the CLI inherits its reach. */
  const REACHES_CLI = /(?:from|import|require)\s*\(?\s*["'][^"']*workers\/billing\/plan-set\.js["']/u;

  it("finds the files it claims to scan — an empty scan would pass forever", () => {
    // A floor, not a pin: tight enough that a broken walk fails loudly, loose
    // enough that adding a file is not a test edit. It is ~460 today.
    expect(files.length).toBeGreaterThan(300);
    expect(files, "the one allowed importer must itself be in scope").toContain(ALLOWED);
    // Named individually because each of these was a hole in the first version.
    for (const entry of ["worker.ts", "main.ts", "gateway.ts", path.join("lib", "queue", "handlers.ts")]) {
      expect(files, `${entry} must be scanned — it was a gap`).toContain(path.join(root, entry));
    }
  });

  it("⚠ NOTHING BUT THE OPERATOR CLI AND THE WEBHOOK RECONCILER REACHES applyPlanChange", () => {
    const offenders = files
      .filter((file) => file !== ALLOWED && file !== RECONCILER)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return REACHES_APPLY_PLAN.test(source) || REACHES_CLI.test(source);
      });

    expect(
      offenders.map((f) => path.relative(root, f)),
      "a new importer here is a new way for a customer to reach a plan write — see this file's header",
    ).toEqual([]);
  });

  // One hop out from the reconciler, as REACHES_CLI is for the CLI: whoever
  // imports it inherits its reach. Only the module that registers it may.
  const REACHES_RECONCILER = /(?:from|import|require)\s*\(?\s*["'][^"']*stripe-subscription\.handler\.js["']/u;

  it("⚠ ONLY billing.module.ts IMPORTS THE WEBHOOK RECONCILER, AND IT IS NOT A CONTROLLER", () => {
    const importers = files.filter((file) => file !== RECONCILER && REACHES_RECONCILER.test(readFileSync(file, "utf8")));
    expect(importers.map((f) => path.relative(root, f))).toEqual([path.relative(root, RECONCILER_REGISTRAR)]);
    expect(files, "the reconciler must be in scope of the scan").toContain(RECONCILER);
    const source = readFileSync(RECONCILER, "utf8");
    expect(source).not.toMatch(/@Controller\(/u);
    expect(source).not.toMatch(/@(Get|Post|Put|Patch|Delete)\(/u);
  });

  it("the reconciler pattern catches the import forms and not unrelated ones", () => {
    expect(REACHES_RECONCILER.test('import { StripeSubscriptionHandler } from "./stripe-subscription.handler.js";')).toBe(true);
    expect(REACHES_RECONCILER.test("const m = await import('../x/stripe-subscription.handler.js');")).toBe(true);
    expect(REACHES_RECONCILER.test('import { StripeEventHandler } from "./stripe-event-handler.js";')).toBe(false);
  });

  // ⚠ A DETECTOR THAT CANNOT FAIL IS NOT A CONTROL. Every form below was found
  // by a review walking straight through the first version of this test, so
  // each is a regression case rather than a hypothetical.
  it.each([
    ["static import", 'import { applyPlanChange } from "../../lib/billing/apply-plan.js";'],
    ["single quotes", "import { applyPlanChange } from '../../lib/billing/apply-plan.js';"],
    ["dynamic import", 'const m = await import("../../lib/billing/apply-plan.js");'],
    ["dynamic import then()", 'void import("../../lib/billing/apply-plan.js").then((m) => m.applyPlanChange);'],
    ["require", 'const m = require("../../lib/billing/apply-plan.js");'],
    ["re-export", 'export { applyPlanChange } from "../../lib/billing/apply-plan.js";'],
    ["transitively via the CLI", 'import { runPlanSet } from "../../workers/billing/plan-set.js";'],
  ])("catches a %s", (_label, line) => {
    expect(REACHES_APPLY_PLAN.test(line) || REACHES_CLI.test(line), `this form evades the scan: ${line}`).toBe(true);
  });

  it("does not fire on an unrelated import that merely mentions billing", () => {
    for (const line of [
      'import { getWallet } from "../../lib/credits/wallet.js";',
      'import { proRataTopUp } from "../../lib/billing/plan-grant.js";',
      "// applyPlanChange is named in this comment and imported by nothing",
    ]) {
      expect(REACHES_APPLY_PLAN.test(line) || REACHES_CLI.test(line), line).toBe(false);
    }
  });

  // The CLI is not a NestJS artifact and must not become one: a provider, a
  // controller or a module would put it in the injector, and the injector is
  // reachable from a request.
  it("the operator CLI is a script, not a Nest provider", () => {
    const cli = readFileSync(ALLOWED, "utf8");
    expect(cli).not.toMatch(/@Injectable\(/u);
    expect(cli).not.toMatch(/@Controller\(/u);
    expect(cli).not.toMatch(/@Module\(/u);
  });
});
