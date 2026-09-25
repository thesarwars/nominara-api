import { defineConfig } from "vitest/config";

// STORY-012 T2 — one shared container/migration-chain/seed for the WHOLE
// run via globalSetup + provide/inject (not per-file containers — that blows
// the D-5 5-minute budget). fileParallelism:false mirrors
// vitest.integration.config.ts's own reasoning: this repo's testcontainers
// setup is flaky under concurrent container churn, and the four dangerous
// areas this suite covers (RLS/tenant context, the parser, scoring, the
// credit ledger — here: RLS/tenant context) get zero benefit from the
// ambiguity a flaky "was that a real regression or infra noise" failure
// would introduce on an always-blocking gate.
export default defineConfig({
  test: {
    include: ["test/isolation/**/*.spec.ts"],
    // STORY-155 — every worker refuses to read a SIBLING of this repository
    // (gap G-12's class). See test/support/no-sibling-reads.ts.
    setupFiles: ["test/support/no-sibling-reads.ts"],
    globalSetup: ["test/isolation/support/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
