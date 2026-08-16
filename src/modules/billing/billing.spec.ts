import { Test } from "@nestjs/testing";
import { describe, expect, it } from "vitest";
import { BillingModule } from "./billing.module.js";
import { BillingController } from "./billing.controller.js";

// STORY-022 — one compiles-test per scaffolded module (task 6 of this
// story's breakdown). Logic and real assertions land with this bounded
// area's own future story.
describe("STORY-022 · BillingModule compiles", () => {
  it("resolves in a Nest testing module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [BillingModule] }).compile();
    expect(moduleRef.get(BillingController)).toBeInstanceOf(BillingController);
    await moduleRef.close();
  });
});
