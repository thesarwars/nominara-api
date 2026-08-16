import { describe, expect, it } from "vitest";
import { assertIso00AntiVacuity } from "./assertions/iso-00-anti-vacuity.js";
import { getAssertionContext } from "./support/context.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

describe("ISO-00 · anti-vacuity guard (this repo's own addition)", () => {
  // T24 — needs the fixture, so ISOLATION_TARGET=staging skips this one.
  it.skipIf(!isRunnableForCurrentTarget("ISO-00"))(
    "the connection is a real runtime role, every discovered set is non-empty, every fixture row count is non-zero",
    async () => {
      await expect(assertIso00AntiVacuity(getAssertionContext())).resolves.toBeUndefined();
    },
  );
});
