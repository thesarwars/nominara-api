import { defineConfig } from "vitest/config";

// STORY-011 fix pass (second pass) — `pnpm test:integration` was reported
// flaky under the previous fix's config: a follow-up review ran the full
// suite 10 consecutive times against that config and still saw 2 failures,
// including this story's own headline partition-hole assertion and
// rls-check.spec.ts — meaning a spurious infrastructure failure was
// currently INDISTINGUISHABLE from a real isolation regression on this
// always-blocking gate. That is not acceptable for the four dangerous areas
// this suite covers.
//
// What the evidence actually shows (and does NOT show):
//
// - CONFIRMED: every observed failure has a container-lifecycle error
//   signature — `(HTTP code 409) removal of container ... is already in
//   progress`, `container stopped/paused`, `Health check failed: unhealthy`,
//   or a `pg` connection error during `migrateUp`. None of the observed
//   failures were a policy-content mismatch — every failure is testcontainers/
//   Docker infrastructure noise, not the isolation logic under test.
// - CONFIRMED: `os.cpus()` (used by the PREVIOUS version of this file to
//   compute a "smart" worker cap) reads the HOST's CPU count, not the
//   Docker VM's actual allocation — on this machine that's 8 (host) vs. 2
//   (this repo's colima default), so a `Math.min(4, os.cpus().length)` cap
//   was still 2x oversubscribed relative to what its own comment claimed to
//   be adapting to.
// - CONFIRMED (measured): running these tests SERIALLY costs approximately
//   ZERO extra wall-clock time versus the previous capped-parallel config on
//   this hardware (~70s parallel vs. ~71s serial) — correctness has no
//   meaningful performance trade-off here, so there is no reason to keep any
//   concurrency at all.
// - NOT CONFIRMED, RETRACTED: the previous version of this file asserted
//   the root cause was "Docker CPU starvation from too many concurrent
//   containers" as an established fact. That was never directly proven —
//   only inferred from the symptom pattern and this repo's documented
//   colima allocation. It is plausible and consistent with the
//   container-lifecycle error signatures above (concurrent container churn
//   contending for constrained Docker resources), but this file no longer
//   asserts it as settled fact. A dedicated investigation (see this story's
//   fix-pass report) tried, and failed, to reproduce a genuine RLS/
//   `app.apply_tenant_rls` policy-content bug as an alternative explanation
//   across 60 combined attempts (30 fresh-container runs + 2×15 sequential
///  drop-schema/remigrate cycles in one long-lived container) — zero
//   reproductions. The isolation logic itself is not implicated.
//
// Fix: serialize integration test execution entirely (`fileParallelism:
// false`, which Vitest documents as overriding `maxWorkers` to 1) rather
// than compute any "smart" concurrency cap. This is scoped to integration
// tests ONLY via this separate config file + `pnpm test:integration`'s own
// `--config` flag — `pnpm test:unit` and plain `vitest run` continue to use
// Vitest's own defaults (full parallelism, default timeouts), untouched.
//
// Verified: 15+ consecutive full `pnpm test:integration` runs with this
// config, zero failures (see this story's fix-pass report for the exact
// tally).
export default defineConfig({
  test: {
    include: ["test/integration/**/*.spec.ts"],
    fileParallelism: false,
    // A generous, uniform floor so a `beforeEach` re-migration or a
    // multi-query mutation/restore sequence running slowly under contended
    // CI/local-dev resources fails LOUDLY with its own assertion (a real
    // bug), never ambiguously with a bare "test timed out" that could mask
    // one. Scoped to integration tests only — test:unit keeps Vitest's
    // default (much shorter) timeouts, since a slow unit test failing fast
    // is a signal worth keeping, not something to loosen for no reason.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
