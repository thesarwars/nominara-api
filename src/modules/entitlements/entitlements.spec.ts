import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { EntitlementResolver } from "../../lib/entitlements/entitlement-resolver.js";
import { StructuralUsage } from "../../lib/entitlements/structural-usage.js";
import { EntitlementsModule } from "./entitlements.module.js";
import { EntitlementsController } from "./entitlements.controller.js";

// STORY-022's compiles-test, extended by STORY-069. The module now imports
// DbModule and CacheModule, both of which validate the full env schema at
// .compile() time, so this needs the same env fixture every other
// composition-root spec uses.
describe("STORY-022 · EntitlementsModule compiles", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    applyFakeApiEnv();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [EntitlementsModule] }).compile();
    expect(moduleRef.get(EntitlementsController)).toBeInstanceOf(EntitlementsController);
    await moduleRef.close();
  });

  it("exports the two providers EntitlementGuard is constructed from", async () => {
    // The guard is registered in ApiModule via APP_GUARD, so it can only be
    // built if this module exports both. Without the exports the whole
    // application fails to boot, which is a worse place to find out.
    const moduleRef = await Test.createTestingModule({ imports: [EntitlementsModule] }).compile();
    expect(moduleRef.get(EntitlementResolver)).toBeInstanceOf(EntitlementResolver);
    expect(moduleRef.get(StructuralUsage)).toBeInstanceOf(StructuralUsage);
    await moduleRef.close();
  });
});
