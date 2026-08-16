import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { ASSERTIONS } from "../assertions/registry.js";
import { createBrokenDatabase } from "../support/broken-database.js";
import { getAssertionContext, getIsolationProvidedContext, getMaintenanceConnection } from "../support/context.js";

// STORY-012 — pnpm test:isolation:breakers. For EVERY registered assertion,
// applies its paired breaker (via a disposable per-breaker database copy for
// DB-backed assertions, or directly for the few pure-code ones — ISO-11/13/14)
// and asserts the SAME assertion function that passes cleanly under
// test:isolation now THROWS. This is the literal Definition of Done: "each
// assertion demonstrated failing against a deliberately broken fixture".

// ISO-13/14's breakers plant a real file under src/lib/ and remove it in
// `revert()` — a SIGKILL or timeout between apply() and revert() would leave
// it stranded, silently affecting the next run. Sweep any stray copy first.
const LIB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "lib");
const STRAY_PROBE_FILES = ["_iso13_breaker_probe.ts", "_iso14_breaker_probe.ts"].map((f) => path.join(LIB_DIR, f));

describe("ISO-* · breaker matrix (each assertion demonstrated failing)", () => {
  beforeAll(async () => {
    await Promise.all(STRAY_PROBE_FILES.map((f) => unlink(f).catch(() => undefined)));
  });


  for (const entry of ASSERTIONS) {
    // The failure must carry the assertion's OWN identity (its message
    // starts with its own ID, or the entry's explicit override) — an
    // incidental error (connection failure, missing column) does not count
    // as a demonstration.
    const ownFailure = entry.ownFailurePattern ?? new RegExp(`^${entry.id}\\b`);

    it(`${entry.id} · ${entry.breaker.description}`, async () => {
      if (!entry.needsDatabase) {
        await entry.breaker.apply(undefined as never);
        try {
          await expect(entry.assertUnderBreaker(getAssertionContext())).rejects.toThrow(ownFailure);
        } finally {
          await entry.breaker.revert(undefined as never);
        }
        return;
      }

      const conn = getMaintenanceConnection();
      const { breakerTemplateDatabase } = getIsolationProvidedContext();
      const handle = await createBrokenDatabase(conn, breakerTemplateDatabase, entry.breaker, getAssertionContext().fixture);
      try {
        await expect(entry.assertUnderBreaker(handle.ctx)).rejects.toThrow(ownFailure);
      } finally {
        await handle.dispose();
      }
    });
  }
});
