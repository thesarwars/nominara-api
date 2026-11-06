import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// STORY-110, the abuse suites as ONE indexed pack. Each acceptance criterion names the spec files that hold it; this test
// fails the moment one is deleted or renamed, so a suite cannot quietly stop being part of the pack. The pack runs in the
// existing gates (test:unit, test:integration, test:isolation) on every push, and test/unit/ci/gates-workflow.spec.ts
// already fails if any tracked spec is not collected by a script the workflow runs - so there is no separate schedule to
// forget. Files marked NEW were added by STORY-110; the rest are earlier stories' specs the AC leans on.
const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const PACK: Readonly<Record<string, readonly string[]>> = {
  "guarded-fetch rejection (scenarios 6-9)": [
    "test/unit/abuse/guarded-fetch-abuse.spec.ts", // NEW: every spelling of an internal address, rebinding answers
    "src/lib/net/guarded-fetch.test.ts", // per-hop re-check, body cap, slow body, pinned lookup
    "src/lib/net/address-rules.test.ts",
  ],
  "prompt injection (scenario 10)": ["test/unit/abuse/prompt-injection.spec.ts", "test/unit/parser/sentiment.spec.ts"],
  "enumeration timing and error shape (scenario 11)": [
    "test/integration/abuse-workspace-enumeration.spec.ts", // NEW
    "test/integration/identity-email-otp-timing.spec.ts",
    "test/unit/uniform-timing.spec.ts",
    "test/integration/portal-session-http.spec.ts", // share token: constant-time structure, one neutral refusal
  ],
  "unknown keys (scenario 12)": ["test/unit/abuse/unknown-keys.spec.ts", "test/unit/engines/registry.spec.ts", "test/unit/plan-entitlements.spec.ts"],
  "portal read-only, three layers (scenario 13)": [
    "test/unit/abuse/portal-read-only.spec.ts", // NEW: layer 1, the route table
    "test/integration/portal-context-http.spec.ts", // layer 2, READ ONLY transaction
    "test/isolation/portal.spec.ts", // layer 3, database grants, application bypassed
  ],
  "free-tier farming controls (scenario 14)": [
    "test/integration/daily-cap.spec.ts",
    "test/integration/workspace-creation-and-one-owned-invariant.spec.ts",
  ],
  "tenant context fails closed (scenario 18)": [
    "test/integration/tenant-query-guard-installed.spec.ts",
    "test/unit/pool-tenant-guard.spec.ts",
    "test/unit/query-guard.spec.ts",
  ],
  "step-up (scenario 20)": ["test/unit/abuse/step-up-sweep.spec.ts"],
  "csv rendering of untrusted names": ["test/unit/reports/export-document.spec.ts"],
};

describe("STORY-110 · the abuse pack is intact", () => {
  it.each(Object.entries(PACK))("%s", (_name, files) => {
    for (const file of files) expect(existsSync(resolve(ROOT, file)), file).toBe(true);
  });
});
