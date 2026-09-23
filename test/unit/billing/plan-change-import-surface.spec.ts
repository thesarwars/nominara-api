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

  /** The one file allowed to import it: the operator CLI. */
  const ALLOWED = path.join(root, "workers", "billing", "plan-set.ts");

  // ⚠ THE SCOPE IS WIDER THAN "src/modules AND src/api", AND THAT MATTERS.
  // Queue handlers open their own connection from `env.DATABASE_URL` directly
  // (maintenance-partition, audit-verify, credit-reconcile all do), so a
  // BullMQ handler importing this would have been a customer-triggerable path
  // that a narrower scan waved through.
  const SCANNED = ["modules", "api", "lib/queue/handlers", "workers", "gateway", "tenancy"];

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(full) && !/\.spec\.tsx?$/.test(full)) out.push(full);
    }
    return out;
  }

  const files = SCANNED.flatMap((rel) => walk(path.join(root, rel)));

  it("finds the files it claims to scan — an empty scan would pass forever", () => {
    // The failure mode of every source scan: the detector stops matching and
    // reports success. This is the floor, not a target.
    // A floor, not a pin: tight enough that a broken walk (wrong root, wrong
    // extension filter) fails loudly, loose enough that adding or moving a
    // file is not a test edit. It is 200 today.
    expect(files.length).toBeGreaterThan(150);
    expect(files, "the one allowed importer must itself be in scope").toContain(ALLOWED);
  });

  it("⚠ NOTHING BUT THE OPERATOR CLI IMPORTS applyPlanChange", () => {
    const offenders = files
      .filter((file) => file !== ALLOWED)
      .filter((file) => /from\s+"[^"]*billing\/apply-plan\.js"/u.test(readFileSync(file, "utf8")));

    expect(
      offenders.map((f) => path.relative(root, f)),
      "a new importer here is a new way for a customer to reach a plan write — see this file's header",
    ).toEqual([]);
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
