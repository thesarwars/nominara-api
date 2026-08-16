import { describe, expect, it } from "vitest";
import { assertIso09PortalReadScope } from "./assertions/iso-09-portal-read-scope.js";
import { assertIso10PortalWriteDenied } from "./assertions/iso-10-portal-write-denied.js";
import { getAssertionContext } from "./support/context.js";
import { isRunnableForCurrentTarget } from "./support/target-guard.js";

describe("ISO-09 · portal cannot read outside its project scope, even within the same workspace", () => {
  it.skipIf(!isRunnableForCurrentTarget("ISO-09"))("holds across all 18 PORTAL_READABLE_TABLES", async () => {
    await expect(assertIso09PortalReadScope(getAssertionContext())).resolves.toBeUndefined();
  });
});

describe("ISO-10 · portal receives 42501 on INSERT/UPDATE/DELETE — grant-level denial", () => {
  it("holds across every discovered tenant table", async () => {
    await expect(assertIso10PortalWriteDenied(getAssertionContext())).resolves.toBeUndefined();
  });
});
