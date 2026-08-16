import { configDefaults, defineConfig } from "vitest/config";

// STORY-012 — test/integration and test/isolation both require a real
// Postgres via testcontainers and run through their own dedicated scripts
// (`pnpm test:integration`, `pnpm test:isolation[:breakers]`). Bare
// `pnpm test` / `vitest run` stays fast and container-free.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/integration/**", "test/isolation/**"],
  },
});
