import { Global, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyFakeApiEnv } from "../../../test/support/fake-env.js";
import { PG_POOL } from "../../db/pg-pool.js";
import { BillingModule } from "./billing.module.js";
import { BillingController } from "./billing.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
//
// NEW-D-2 — StripeWebhookService injects PG_POOL, which DbModule provides
// globally in the real composition root; this isolated compile supplies an
// inert stand-in (nothing here queries).
@Global()
@Module({ providers: [{ provide: PG_POOL, useValue: {} }], exports: [PG_POOL] })
class InertPoolModule {}

describe("STORY-022 · BillingModule compiles", () => {
  // The Stripe gateway factory validates the environment (loadEnv), exactly as
  // the composition root does; no STRIPE_* variable is set, which is the
  // supported "API boots without a payment provider" configuration.
  const originalEnv = { ...process.env };
  beforeEach(() => applyFakeApiEnv());
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [InertPoolModule, BillingModule] }).compile();
    expect(moduleRef.get(BillingController)).toBeInstanceOf(BillingController);
    await moduleRef.close();
  });
});
