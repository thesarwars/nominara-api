import { describe, expect, it } from "vitest";
import { assertIso13CacheNamespacing } from "./assertions/iso-13-cache-namespace.js";
import { assertIso14ObjectNamespacing } from "./assertions/iso-14-object-namespace.js";
import { assertIso15AggregateAnonymity } from "./assertions/iso-15-aggregate-anonymity.js";
import { getAssertionContext } from "./support/context.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

describe("ISO-13 · cache keys namespaced {env}:{ws}:…, the shared answer cache as the single documented exception", () => {
  it("scanner self-tests clean and finds no un-namespaced key in src/", async () => {
    await expect(assertIso13CacheNamespacing()).resolves.toBeUndefined();
  });
});

describe("ISO-14 · object-storage prefixes namespaced {env}/{workspace_id}/…", () => {
  it("scanner self-tests clean and finds no un-namespaced prefix in src/", async () => {
    await expect(assertIso14ObjectNamespacing()).resolves.toBeUndefined();
  });
});

describe("ISO-15 · cross-tenant aggregates carry no tenant identifier and satisfy k >= 20", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-15"))(
    "holds at the exact boundary (19 rejected, 20 accepted) and for a fixture-derived aggregate",
    async () => {
      await expect(assertIso15AggregateAnonymity(getAssertionContext())).resolves.toBeUndefined();
    },
  );
});
