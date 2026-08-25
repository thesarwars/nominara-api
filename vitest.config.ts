import { configDefaults, defineConfig } from "vitest/config";

// STORY-012 — test/integration and test/isolation both require a real
// Postgres via testcontainers and run through their own dedicated scripts
// (`pnpm test:integration`, `pnpm test:isolation[:breakers]`). Bare
// `pnpm test` / `vitest run` stays fast and container-free.
//
// `dist/**` is excluded because vitest 4 NARROWED `configDefaults.exclude` to
// `node_modules` and `.git` only — earlier versions carried `**/dist/**`, and
// dropping it was a silent behaviour change. `pnpm test:unit` is
// `vitest run test/unit src`, and those positional arguments are SUBSTRING
// FILTERS rather than paths, so `test/unit` matches `dist/test/unit/...` and
// `src` matches `dist/src/...` the moment a build has been run on the host.
// The compiled copies are the same suite, so they add no coverage — they just
// resolve their relative paths one directory deeper and fail on artifacts that
// are not there. That produced 20 failures across 12 files, every one of them
// a `dist/` path, in a suite that was otherwise green.
//
// Excluding build output does not weaken this gate: all 103 source spec files
// still run. It stops the runner executing a stale second copy of them.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "dist/**", "test/integration/**", "test/isolation/**"],
  },
});
